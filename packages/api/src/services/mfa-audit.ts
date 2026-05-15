// packages/api/src/services/mfa-audit.ts
// Phase 9 §5 — server-side audit for MFA enable / disable.
//
// Better Auth's two-factor plugin handles the cryptographic lifecycle
// but does not write to our `audit_events` table. We wire this via
// `databaseHooks.user.update.after` (configured in `auth.ts`): whenever
// the user row is updated, if `two_factor_enabled` changed we fan out
// an audit row to every zone the user belongs to.
//
// One MFA decision affects every zone the user can administer — a
// super-admin disabling MFA is a security-relevant event in each of
// those zones. We write per-zone rows so a zone auditor sees the event
// without depending on a cross-tenant query.
//
// RELEVANT FILES: packages/api/src/auth.ts, packages/db/src/schema/audit.ts, packages/api/src/services/audit.ts

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";
import { writeAuditMany, type AuditWrite } from "./audit";

interface RecordMfaAuditArgs {
  userId: string;
  enabled: boolean;
  /** Optional request context the Better Auth hook can supply. */
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Distinct zone ids for the user, derived from their active role
 * bindings. Excludes revoked bindings and soft-deleted zones so a
 * stale binding never surfaces an audit row in a zone the user no
 * longer accesses.
 */
export async function scopedZoneIds(
  database: Db,
  userId: string,
): Promise<string[]> {
  const rows = await database
    .selectDistinct({ zoneId: userRoleBindings.zoneId })
    .from(userRoleBindings)
    .innerJoin(zones, eq(zones.id, userRoleBindings.zoneId))
    .where(
      and(
        eq(userRoleBindings.userId, userId),
        isNull(userRoleBindings.revokedAt),
        isNull(zones.deletedAt),
      ),
    );
  return rows.map((r) => r.zoneId);
}

/**
 * Write one `user.mfa_enable` or `user.mfa_disable` row per zone the
 * user belongs to. No-ops when the user has no tenant bindings
 * (e.g. a platform-only super-admin).
 *
 * Runs **after** Better Auth commits the user-row update. If the audit
 * write fails we log via the caller but do not throw — reverting the
 * MFA flip would require an additional Better Auth API call and could
 * leave the user in a half-armed state worse than the missing audit
 * row.
 */
export async function recordMfaAudit(
  database: Db,
  args: RecordMfaAuditArgs,
): Promise<void> {
  const zoneIds = await scopedZoneIds(database, args.userId);
  if (zoneIds.length === 0) return;
  const action = args.enabled ? "user.mfa_enable" : "user.mfa_disable";
  const events: AuditWrite[] = zoneIds.map((zoneId) => ({
    zoneId,
    actorUserId: args.actorUserId ?? args.userId,
    action,
    entityType: "user",
    entityId: args.userId,
    after: { twoFactorEnabled: args.enabled },
    ipAddress: args.ipAddress ?? null,
    userAgent: args.userAgent ?? null,
    requestId: args.requestId ?? null,
  }));
  await writeAuditMany(database, events);
}

interface RecordMfaBypassBlockedArgs {
  email: string;
  path: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Audit a blocked MFA-bypass attempt. The user has TOTP enabled and
 * someone tried to sign them in via /sign-in/email-otp,
 * /sign-in/magic-link, or /email-otp/send-verification-otp — the
 * bypass-closure rejected with 409. Without this, the attempt is
 * invisible to operators (the response goes back to the attacker,
 * nothing lands in the audit log).
 *
 * Resolves the email -> user id case-insensitively. If the email
 * doesn't map to a known user the function no-ops — there's nothing
 * to attribute the event to and the bypass-closure wouldn't have
 * fired in that case either.
 */
export async function recordMfaBypassBlocked(
  database: Db,
  args: RecordMfaBypassBlockedArgs,
): Promise<void> {
  const normalised = args.email.trim().toLowerCase();
  if (!normalised) return;
  const [row] = await database
    .select({ id: userTable.id })
    .from(userTable)
    .where(sql`lower(${userTable.email}) = ${normalised}`)
    .limit(1);
  if (!row) return;
  const zoneIds = await scopedZoneIds(database, row.id);
  if (zoneIds.length === 0) return;
  const events: AuditWrite[] = zoneIds.map((zoneId) => ({
    zoneId,
    // The attacker is not authenticated; the event is attributed to
    // the targeted user so a zone auditor can see "this account was
    // probed via /sign-in/magic-link".
    actorUserId: row.id,
    action: "user.mfa_bypass_blocked",
    entityType: "user",
    entityId: row.id,
    after: { path: args.path },
    ipAddress: args.ipAddress ?? null,
    userAgent: args.userAgent ?? null,
    requestId: args.requestId ?? null,
  }));
  await writeAuditMany(database, events);
}
