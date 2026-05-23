// packages/api/src/services/invitations.ts
// Invitation lifecycle: create + send email, look up by token, accept.
// Tokens are 32 random bytes encoded URL-safe base64; only the SHA-256 hash
// is stored. The raw token only appears in the outbound email URL.

import { createHash, randomBytes } from "node:crypto";
import type { Database, Db } from "@stewardledger/db";
import {
  groups,
  invitations,
  roles,
  userRoleBindings,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import {
  BRAND_WORDMARK,
  CHAPTER_ROLES,
  GROUP_ROLES,
  INVITATION_TOKEN_BYTES,
  INVITATION_VALIDITY_HOURS,
  ZONE_ROLES,
} from "@stewardledger/shared";
import { and, eq, isNull } from "drizzle-orm";

import { log } from "../logger";
import { env } from "../env";
import { brandedEmailHtml, escapeHtml, sendEmail } from "./email";

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
  groupId?: string | null;
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

export interface RevokeFilter {
  zoneId: string;
  /** Optional: limit to a specific invitation id. */
  invitationId?: string;
  /** Optional: limit to one role code (e.g. owner-only resend). */
  roleCode?: string;
}

/**
 * Revoke every currently-open invitation that matches `filter`. Open means
 * neither accepted nor revoked. Caller must pass a transaction handle when
 * the revoke is part of a larger atomic operation (e.g. resend), so the
 * revoke and the follow-on insert/audit commit together.
 */
export async function revokeOpenInvitations(
  database: Db,
  filter: RevokeFilter,
  revokedByUserId: string,
): Promise<{ revokedIds: string[] }> {
  const conditions = [
    eq(invitations.zoneId, filter.zoneId),
    isNull(invitations.acceptedAt),
    isNull(invitations.revokedAt),
  ];
  if (filter.invitationId) conditions.push(eq(invitations.id, filter.invitationId));
  if (filter.roleCode) conditions.push(eq(invitations.roleCode, filter.roleCode));
  const rows = await database
    .update(invitations)
    .set({ revokedAt: new Date(), revokedByUserId })
    .where(and(...conditions))
    .returning({ id: invitations.id });
  return { revokedIds: rows.map((r) => r.id) };
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
      groupId: args.groupId ?? null,
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
  groupId: string | null;
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
      groupId: invitations.groupId,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .innerJoin(zones, eq(invitations.zoneId, zones.id))
    .where(and(eq(invitations.tokenHash, tokenHash), isNull(zones.deletedAt)))
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
        groupId: invitations.groupId,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
      })
      .from(invitations)
      .innerJoin(zones, eq(invitations.zoneId, zones.id))
      .where(and(eq(invitations.id, args.invitationId), isNull(zones.deletedAt)))
      .limit(1);
    if (!inv) throw new InvitationError("invitation_not_found", "Invitation not found.");
    if (inv.acceptedAt)
      throw new InvitationError("invitation_already_accepted", "Invitation already accepted.");
    if (inv.revokedAt)
      throw new InvitationError("invitation_revoked", "Invitation has been revoked.");
    if (inv.expiresAt.getTime() < Date.now())
      throw new InvitationError("invitation_expired", "Invitation has expired.");

    const [role] = await tx
      .select({ id: roles.id, scope: roles.scope })
      .from(roles)
      .where(and(eq(roles.zoneId, inv.zoneId), eq(roles.code, inv.roleCode)))
      .limit(1);
    if (!role)
      throw new InvitationError("role_not_seeded", `Role ${inv.roleCode} not seeded for zone.`);

    if (inv.groupId) {
      const [group] = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(
          and(
            eq(groups.id, inv.groupId),
            eq(groups.zoneId, inv.zoneId),
            isNull(groups.deletedAt),
          ),
        )
        .limit(1);
      if (!group) {
        throw new InvitationError("group_not_found", "Invitation group is no longer active.");
      }
    }

    // Re-use any existing active binding (idempotency for retried accepts).
    const existing = await tx
      .select({ id: userRoleBindings.id })
      .from(userRoleBindings)
      .where(
        and(
          eq(userRoleBindings.userId, args.userId),
          eq(userRoleBindings.zoneId, inv.zoneId),
          eq(userRoleBindings.roleId, role.id),
          inv.chapterId
            ? eq(userRoleBindings.chapterId, inv.chapterId)
            : isNull(userRoleBindings.chapterId),
          inv.groupId
            ? eq(userRoleBindings.groupId, inv.groupId)
            : isNull(userRoleBindings.groupId),
          isNull(userRoleBindings.revokedAt),
        ),
      )
      .limit(1);
    if (!existing[0]) {
      await tx.insert(userRoleBindings).values({
        userId: args.userId,
        zoneId: inv.zoneId,
        chapterId: inv.chapterId,
        groupId: inv.groupId,
        roleId: role.id,
        roleScope: role.scope,
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

/**
 * Delete a Better Auth user row that was created by an invite-accept
 * flow whose follow-on apply step then failed. Sessions and accounts
 * cascade via ON DELETE CASCADE on the user FK, so a single DELETE
 * cleans up the whole identity. Used by both `/invitations/accept` and
 * `/platform-invitations/accept` to prevent orphan accounts that
 * would otherwise block a re-invite of the same email.
 *
 * Errors are caught and logged — if the cleanup itself fails the
 * caller still surfaces the original apply-failure to the client; we
 * do not want a secondary fault to mask the primary cause.
 */
export async function discardOrphanedAuthUser(
  database: Database,
  userId: string,
): Promise<void> {
  try {
    await database.delete(userTable).where(eq(userTable.id, userId));
  } catch (err) {
    log.warn(
      { err, userId },
      "discardOrphanedAuthUser failed; manual cleanup may be required",
    );
  }
}

export function isChapterRole(code: string): boolean {
  return (Object.values(CHAPTER_ROLES) as string[]).includes(code);
}

export function isGroupRole(code: string): boolean {
  return (Object.values(GROUP_ROLES) as string[]).includes(code);
}

/**
 * Resolve the public URL the invited user follows to accept the invitation.
 * In local dev (`PUBLIC_TENANT_DOMAIN=localhost`) we host the accept page on
 * the marketing origin; in prod each zone's subdomain hosts it.
 */
export function buildAcceptUrl(slug: string, token: string): string {
  if (env.PUBLIC_TENANT_DOMAIN === "localhost") {
    return `${env.PUBLIC_APP_URL}/invite/${encodeURIComponent(token)}`;
  }
  const url = new URL(env.PUBLIC_APP_URL);
  url.host = `${slug}.${env.PUBLIC_TENANT_DOMAIN}`;
  url.pathname = `/invite/${encodeURIComponent(token)}`;
  return url.toString();
}

export interface ZoneOwnerInviteEmail {
  to: string;
  /** Optional greeting name. When omitted the email uses a neutral salutation. */
  contactName?: string | null;
  zoneSlug: string;
  zoneName: string;
  token: string;
}

/**
 * Send the zone-owner invitation email. Used both at zone creation and when
 * an admin re-issues an invitation from /admin/zones/[slug].
 */
export async function sendZoneOwnerInviteEmail(args: ZoneOwnerInviteEmail): Promise<void> {
  const acceptUrl = buildAcceptUrl(args.zoneSlug, args.token);
  const greetingLine = args.contactName ? `Hi ${args.contactName},\n\n` : "";
  const greetingHtml = args.contactName
    ? `<p>Hi ${escapeHtml(args.contactName)},</p>`
    : "";
  await sendEmail({
    to: args.to,
    subject: `You're invited to set up ${args.zoneName} on ${BRAND_WORDMARK}`,
    body:
      greetingLine +
      `You've been invited to set up ${args.zoneName} on ${BRAND_WORDMARK}.\n\n` +
      `Click the link below to accept the invitation, choose a password, and finish setting up your zone:\n` +
      `${acceptUrl}\n\n` +
      `This link expires in 7 days. If you weren't expecting this email, you can safely ignore it.`,
    html: brandedEmailHtml({
      zoneName: args.zoneName,
      body: `
        ${greetingHtml}
        <p>You've been invited to set up <strong>${escapeHtml(args.zoneName)}</strong> on ${escapeHtml(BRAND_WORDMARK)}.</p>
        <p>Click the button below to accept the invitation, choose a password, and finish setting up your zone.</p>
        <p>
          <a href="${acceptUrl}"
             style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">
            Accept invitation
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">This link expires in 7 days. If you weren't expecting this email, you can safely ignore it.</p>
      `,
    }),
  });
}
