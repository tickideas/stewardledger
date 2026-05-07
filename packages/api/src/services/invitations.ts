// packages/api/src/services/invitations.ts
// Invitation lifecycle: create + send email, look up by token, accept.
// Tokens are 32 random bytes encoded URL-safe base64; only the SHA-256 hash
// is stored. The raw token only appears in the outbound email URL.

import { createHash, randomBytes } from "node:crypto";
import {
  CHAPTER_ROLES,
  INVITATION_TOKEN_BYTES,
  INVITATION_VALIDITY_HOURS,
  ZONE_ROLES,
} from "@stewardledger/shared";
import { and, eq, isNull } from "drizzle-orm";
import {
  invitations,
  roles,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import type { Db, Database } from "@stewardledger/db";

export interface CreatedInvitation {
  id: string;
  token: string;
  expiresAt: Date;
}

interface CreateArgs {
  zoneId: string;
  email: string;
  roleCode: string;
  chapterId?: string | null;
  createdByUserId?: string | null;
}

function urlSafeBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class InvitationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function createInvitation(
  database: Db,
  args: CreateArgs,
): Promise<CreatedInvitation> {
  const tokenBytes = randomBytes(INVITATION_TOKEN_BYTES);
  const token = urlSafeBase64(tokenBytes);
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_VALIDITY_HOURS * 60 * 60 * 1000);
  const [row] = await database
    .insert(invitations)
    .values({
      zoneId: args.zoneId,
      email: args.email.toLowerCase(),
      roleCode: args.roleCode,
      chapterId: args.chapterId ?? null,
      tokenHash,
      expiresAt,
      createdByUserId: args.createdByUserId ?? null,
    })
    .returning({ id: invitations.id });
  return { id: row.id, token, expiresAt };
}

export interface InvitationLookup {
  id: string;
  zoneId: string;
  zoneSlug: string;
  zoneName: string;
  email: string;
  roleCode: string;
  chapterId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export async function findInvitationByToken(
  database: Db,
  token: string,
): Promise<InvitationLookup | null> {
  const tokenHash = hashInvitationToken(token);
  const rows = await database
    .select({
      id: invitations.id,
      zoneId: invitations.zoneId,
      zoneSlug: zones.slug,
      zoneName: zones.name,
      email: invitations.email,
      roleCode: invitations.roleCode,
      chapterId: invitations.chapterId,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .innerJoin(zones, eq(invitations.zoneId, zones.id))
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Bind a user to a zone via an accepted invitation. Looks up the seeded
 * `roles` row for the invitation's `roleCode`, inserts a `user_role_bindings`
 * row, marks the invitation accepted. If the invitation is for `zone_owner`
 * and the zone is still in `pending_setup`, the zone is promoted to `active`.
 *
 * The Better Auth user is expected to already exist (created by the caller).
 */
export async function applyAcceptedInvitation(
  database: Database,
  args: { invitationId: string; userId: string },
): Promise<{ zoneId: string }> {
  return database.transaction(async (tx) => {
    const [inv] = await tx
      .select({
        id: invitations.id,
        zoneId: invitations.zoneId,
        roleCode: invitations.roleCode,
        chapterId: invitations.chapterId,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
      })
      .from(invitations)
      .where(eq(invitations.id, args.invitationId))
      .limit(1);
    if (!inv) throw new InvitationError("invitation_not_found", "Invitation not found.");
    if (inv.acceptedAt)
      throw new InvitationError("invitation_already_accepted", "Invitation already accepted.");
    if (inv.revokedAt)
      throw new InvitationError("invitation_revoked", "Invitation has been revoked.");
    if (inv.expiresAt.getTime() < Date.now())
      throw new InvitationError("invitation_expired", "Invitation has expired.");

    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.zoneId, inv.zoneId), eq(roles.code, inv.roleCode)))
      .limit(1);
    if (!role)
      throw new InvitationError("role_not_seeded", `Role ${inv.roleCode} not seeded for zone.`);

    // Re-use any existing active binding (idempotency for retried accepts).
    const existing = await tx
      .select({ id: userRoleBindings.id })
      .from(userRoleBindings)
      .where(
        and(
          eq(userRoleBindings.userId, args.userId),
          eq(userRoleBindings.zoneId, inv.zoneId),
          eq(userRoleBindings.roleId, role.id),
          isNull(userRoleBindings.revokedAt),
        ),
      )
      .limit(1);
    if (!existing[0]) {
      await tx.insert(userRoleBindings).values({
        userId: args.userId,
        zoneId: inv.zoneId,
        chapterId: inv.chapterId,
        roleId: role.id,
      });
    }

    await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: args.userId })
      .where(eq(invitations.id, inv.id));

    if (inv.roleCode === ZONE_ROLES.ZONE_OWNER) {
      await tx
        .update(zones)
        .set({
          status: "active",
          activatedAt: new Date(),
          primaryContactUserId: args.userId,
        })
        .where(and(eq(zones.id, inv.zoneId), eq(zones.status, "pending_setup")));
      await tx
        .update(userTable)
        .set({ defaultZoneId: inv.zoneId })
        .where(eq(userTable.id, args.userId));
    }

    return { zoneId: inv.zoneId };
  });
}

export function isChapterRole(code: string): boolean {
  return (Object.values(CHAPTER_ROLES) as string[]).includes(code);
}
