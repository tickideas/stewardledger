// packages/api/src/services/admin/platform-invitations.ts
// Lifecycle for invitations into a platform role. Sibling to
// `services/invitations.ts` (zone-scoped). Tokens use the same scheme:
// 32 random bytes, URL-safe base64; only the SHA-256 hash is persisted.
//
// RELEVANT FILES: packages/api/src/services/admin/administrators.ts, packages/db/src/schema/platform-invitations.ts, packages/api/src/services/invitations.ts

import { randomBytes } from "node:crypto";
import type { Database, Db } from "@stewardledger/db";
import {
  platformInvitations,
  platformRoleBindings,
  user as userTable,
} from "@stewardledger/db/schema";
import {
  INVITATION_TOKEN_BYTES,
  INVITATION_VALIDITY_HOURS,
} from "@stewardledger/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import { writeAudit } from "../audit";
import { hashInvitationToken } from "../invitations";
import { isGrantableRole } from "./administrators";

function urlSafeBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class PlatformInvitationError extends Error {
  constructor(
    readonly code:
      | "invalid_role"
      | "email_already_user"
      | "invitation_not_found"
      | "invitation_revoked"
      | "invitation_already_accepted"
      | "invitation_expired",
    message: string,
  ) {
    super(message);
  }
}

export interface PlatformInvitationSummary {
  id: string;
  email: string;
  name: string;
  roleCode: string;
  superAdmin: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface CreatedPlatformInvitation {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface CreatePlatformInvitationArgs {
  email: string;
  name: string;
  roleCode: string;
  superAdmin?: boolean;
  createdByUserId: string;
}

interface ActorContext {
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Create a new platform invitation and revoke any existing open
 * invitation for the same (email, role). Refuses if a user with that
 * email already exists — operators should grant the role on the existing
 * user instead, which is a different audit action.
 */
export async function createPlatformInvitation(
  database: Database,
  args: CreatePlatformInvitationArgs,
  actor: ActorContext,
): Promise<CreatedPlatformInvitation> {
  if (!isGrantableRole(args.roleCode)) {
    throw new PlatformInvitationError(
      "invalid_role",
      `Role ${args.roleCode} cannot be invited here.`,
    );
  }
  const email = args.email.trim().toLowerCase();
  return database.transaction(async (tx) => {
    const userMatch = await tx
      .select({ id: userTable.id })
      .from(userTable)
      .where(sql`lower(${userTable.email}) = ${email}`)
      .limit(1);
    if (userMatch[0]) {
      throw new PlatformInvitationError(
        "email_already_user",
        "A user with this email already exists. Grant the role on the existing user instead.",
      );
    }

    // Revoke any previously-open invitation for the same (email, role).
    await tx
      .update(platformInvitations)
      .set({ revokedAt: new Date(), revokedByUserId: actor.actorUserId })
      .where(
        and(
          eq(platformInvitations.email, email),
          eq(platformInvitations.roleCode, args.roleCode),
          isNull(platformInvitations.acceptedAt),
          isNull(platformInvitations.revokedAt),
        ),
      );

    const tokenBytes = randomBytes(INVITATION_TOKEN_BYTES);
    const token = urlSafeBase64(tokenBytes);
    const tokenHash = hashInvitationToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_VALIDITY_HOURS * 60 * 60 * 1000);

    let row: { id: string };
    try {
      [row] = await tx
        .insert(platformInvitations)
        .values({
          email,
          name: args.name,
          roleCode: args.roleCode,
          superAdmin: args.superAdmin ?? false,
          tokenHash,
          createdByUserId: args.createdByUserId,
          expiresAt,
        })
        .returning({ id: platformInvitations.id });
    } catch (err) {
      // Race on the partial unique index `platform_invitations_open_unique_idx`:
      // two concurrent invites for the same (email, role) could both
      // pass the revoke step and contend on the insert. Map to a
      // typed conflict so the route layer can return 409 instead of
      // a raw 500.
      if (isUniqueViolation(err)) {
        throw new PlatformInvitationError(
          "email_already_user",
          "An open invitation for this email + role already exists. Revoke it before re-issuing.",
        );
      }
      throw err;
    }

    await writeAudit(tx, {
      zoneId: null,
      actorUserId: actor.actorUserId,
      action: "platform.admin.invite",
      entityType: "platform_invitation",
      entityId: row.id,
      after: {
        email,
        roleCode: args.roleCode,
        superAdmin: args.superAdmin ?? false,
      },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });

    return { id: row.id, token, expiresAt };
  });
}

export async function listOpenPlatformInvitations(
  database: Db,
): Promise<PlatformInvitationSummary[]> {
  const rows = await database
    .select()
    .from(platformInvitations)
    .where(
      and(
        isNull(platformInvitations.acceptedAt),
        isNull(platformInvitations.revokedAt),
      ),
    )
    .orderBy(platformInvitations.createdAt);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    roleCode: r.roleCode,
    superAdmin: r.superAdmin,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/** Revoke an open platform invitation. 404 if it is not currently open. */
export async function revokePlatformInvitation(
  database: Database,
  args: { invitationId: string },
  actor: ActorContext,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: platformInvitations.id,
        email: platformInvitations.email,
        roleCode: platformInvitations.roleCode,
        acceptedAt: platformInvitations.acceptedAt,
        revokedAt: platformInvitations.revokedAt,
      })
      .from(platformInvitations)
      .where(eq(platformInvitations.id, args.invitationId))
      .for("update")
      .limit(1);
    if (!existing) {
      throw new PlatformInvitationError(
        "invitation_not_found",
        "Invitation not found.",
      );
    }
    if (existing.acceptedAt) {
      throw new PlatformInvitationError(
        "invitation_already_accepted",
        "Invitation has already been accepted.",
      );
    }
    if (existing.revokedAt) {
      throw new PlatformInvitationError(
        "invitation_revoked",
        "Invitation has already been revoked.",
      );
    }
    await tx
      .update(platformInvitations)
      .set({ revokedAt: new Date(), revokedByUserId: actor.actorUserId })
      .where(eq(platformInvitations.id, existing.id));
    await writeAudit(tx, {
      zoneId: null,
      actorUserId: actor.actorUserId,
      action: "platform.admin.invite_revoke",
      entityType: "platform_invitation",
      entityId: existing.id,
      before: { email: existing.email, roleCode: existing.roleCode },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });
  });
}

export interface PlatformInvitationLookup {
  id: string;
  email: string;
  name: string;
  roleCode: string;
  superAdmin: boolean;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export async function findPlatformInvitationByToken(
  database: Db,
  token: string,
): Promise<PlatformInvitationLookup | null> {
  const tokenHash = hashInvitationToken(token);
  const rows = await database
    .select()
    .from(platformInvitations)
    .where(eq(platformInvitations.tokenHash, tokenHash))
    .limit(1);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    roleCode: r.roleCode,
    superAdmin: r.superAdmin,
    expiresAt: r.expiresAt,
    acceptedAt: r.acceptedAt,
    revokedAt: r.revokedAt,
  };
}

/**
 * Mark an invitation accepted, write the role binding (and the super-admin
 * bit if requested), and audit. The Better Auth user is created by the
 * caller before this runs.
 */
export async function applyAcceptedPlatformInvitation(
  database: Database,
  args: { invitationId: string; userId: string },
): Promise<{ roleCode: string; superAdmin: boolean }> {
  return database.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(platformInvitations)
      .where(eq(platformInvitations.id, args.invitationId))
      .for("update")
      .limit(1);
    if (!inv) {
      throw new PlatformInvitationError(
        "invitation_not_found",
        "Invitation not found.",
      );
    }
    if (inv.acceptedAt) {
      throw new PlatformInvitationError(
        "invitation_already_accepted",
        "Invitation already accepted.",
      );
    }
    if (inv.revokedAt) {
      throw new PlatformInvitationError(
        "invitation_revoked",
        "Invitation has been revoked.",
      );
    }
    if (inv.expiresAt.getTime() < Date.now()) {
      throw new PlatformInvitationError(
        "invitation_expired",
        "Invitation has expired.",
      );
    }

    // Idempotency: re-use any existing un-revoked binding for the same role.
    const [existing] = await tx
      .select({ id: platformRoleBindings.id })
      .from(platformRoleBindings)
      .where(
        and(
          eq(platformRoleBindings.userId, args.userId),
          eq(platformRoleBindings.roleCode, inv.roleCode),
          isNull(platformRoleBindings.revokedAt),
        ),
      )
      .limit(1);
    if (!existing) {
      try {
        await tx.insert(platformRoleBindings).values({
          userId: args.userId,
          roleCode: inv.roleCode,
          grantedByUserId: inv.createdByUserId,
        });
      } catch (err) {
        // A concurrent accept (or a stray grantRole) for the same
        // (user, role) could land between the SELECT above and this
        // INSERT and trip the partial unique index. Treat that as
        // idempotent success — the user ends up with the right role
        // either way, and the audit row below still records the
        // accept.
        if (!isUniqueViolation(err)) throw err;
      }
    }

    if (inv.superAdmin) {
      await tx
        .update(userTable)
        .set({ isSuperAdmin: true })
        .where(eq(userTable.id, args.userId));
    }

    await tx
      .update(platformInvitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: args.userId })
      .where(eq(platformInvitations.id, inv.id));

    await writeAudit(tx, {
      zoneId: null,
      actorUserId: args.userId,
      action: "platform.admin.invite_accept",
      entityType: "platform_invitation",
      entityId: inv.id,
      after: {
        email: inv.email,
        roleCode: inv.roleCode,
        superAdmin: inv.superAdmin,
      },
    });

    return { roleCode: inv.roleCode, superAdmin: inv.superAdmin };
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const direct = err as { code?: unknown; cause?: unknown };
  if (direct.code === "23505") return true;
  const cause = direct.cause;
  return Boolean(
    cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505",
  );
}
