// packages/api/src/services/admin/zone-mfa.ts
// Service layer for the platform-admin "Two-factor enforcement"
// surface on /admin/zones/:slug. Wraps the `zones.mfa_required_role_codes`
// column with normalisation, taxonomy validation, idempotent writes,
// audit, and an "enrolled / required" blast-radius summary.
//
// RELEVANT FILES: packages/api/src/routes/admin.ts, packages/db/src/schema/zones.ts, packages/db/src/schema/auth.ts

import type { Db } from "@stewardledger/db";
import {
  roles,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import {
  MFA_ENFORCEABLE_ROLE_CODES,
  type MfaEnforceableRoleCode,
} from "@stewardledger/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { writeAudit } from "../audit";

const ENFORCEABLE = new Set<string>(MFA_ENFORCEABLE_ROLE_CODES);

export class ZoneMfaError extends Error {
  constructor(
    readonly code: "zone_not_found" | "invalid_role",
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Normalise an incoming code list: trim, lowercase, drop empties,
 * dedupe, sort. The DB column is `text[]`, so a stable canonical
 * ordering also makes diff-by-equality cheap and the audit `before`/
 * `after` payloads stable.
 */
function normalise(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of codes) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen].sort();
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export interface UpdateMfaRoleCodesInput {
  zoneId: string;
  actorUserId: string | null;
  codes: readonly string[];
}

/**
 * Write the new role-code list. Returns the post-write canonical list.
 * No-op writes (post-normalisation equality) skip both the UPDATE and
 * the audit row so the audit log stays signal-heavy.
 *
 * Invalid codes (anything not in `MFA_ENFORCEABLE_ROLE_CODES`) raise
 * `ZoneMfaError("invalid_role")` and abort — the route turns this
 * into a 422 with the offending list.
 */
export async function updateMfaRequiredRoleCodes(
  database: Db,
  { zoneId, actorUserId, codes }: UpdateMfaRoleCodesInput,
): Promise<MfaEnforceableRoleCode[]> {
  const normalised = normalise(codes);
  const unknown = normalised.filter((c) => !ENFORCEABLE.has(c));
  if (unknown.length > 0) {
    throw new ZoneMfaError(
      "invalid_role",
      `unknown role code(s): ${unknown.join(", ")}`,
      { unknown },
    );
  }
  return await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ codes: zones.mfaRequiredRoleCodes })
      .from(zones)
      .where(and(eq(zones.id, zoneId), isNull(zones.deletedAt)))
      .limit(1);
    if (!row) {
      throw new ZoneMfaError("zone_not_found", `zone ${zoneId} not found`);
    }
    // Re-normalise the stored value too — historical SQL surgery
    // may have left mixed-case or unsorted entries.
    const before = normalise(row.codes ?? []);
    if (arraysEqual(before, normalised)) {
      return before as MfaEnforceableRoleCode[];
    }
    await tx
      .update(zones)
      .set({ mfaRequiredRoleCodes: normalised, updatedAt: new Date() })
      .where(eq(zones.id, zoneId));
    await writeAudit(tx, {
      // Platform-scope: the audit_events_zone_scope_check constraint
      // requires `platform.*` actions to have NULL zone_id.
      zoneId: null,
      actorUserId,
      action: "platform.zone.mfa_required_role_codes.update",
      entityType: "zone",
      entityId: zoneId,
      before: { codes: before },
      after: { codes: normalised },
    });
    return normalised as MfaEnforceableRoleCode[];
  });
}

export interface MfaEnforcementSummary {
  /** Distinct users in the zone holding at least one required role. */
  required: number;
  /** Subset of `required` whose `user.two_factor_enabled` is true. */
  enrolled: number;
}

/**
 * "Blast radius" counter for the UI: how many users hold an
 * enforcement-required role in this zone, and how many of them have
 * already enrolled in TOTP. Returns `{ required: 0, enrolled: 0 }`
 * when the column is empty so the UI can render the no-op state
 * without a null-check.
 *
 * Bindings are filtered by `revoked_at IS NULL`; only active bindings
 * count. Users are de-duplicated across multiple bindings (e.g.
 * holding both zone_owner and zone_admin) so the counts match the
 * "people who would be locked out tomorrow" question the operator is
 * actually asking.
 */
export async function mfaEnforcementSummary(
  database: Db,
  zoneId: string,
): Promise<MfaEnforcementSummary> {
  const [zone] = await database
    .select({ codes: zones.mfaRequiredRoleCodes })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!zone) return { required: 0, enrolled: 0 };
  const codes = normalise(zone.codes ?? []);
  if (codes.length === 0) return { required: 0, enrolled: 0 };

  // `user_role_bindings.roleId` references `roles.id`; the role code
  // lives on the `roles` row. Join through.
  const rows = await database
    .selectDistinct({
      userId: userTable.id,
      twoFactorEnabled: userTable.twoFactorEnabled,
    })
    .from(userRoleBindings)
    .innerJoin(roles, eq(roles.id, userRoleBindings.roleId))
    .innerJoin(userTable, eq(userTable.id, userRoleBindings.userId))
    .where(
      and(
        eq(userRoleBindings.zoneId, zoneId),
        isNull(userRoleBindings.revokedAt),
        inArray(roles.code, codes),
      ),
    );
  const required = rows.length;
  const enrolled = rows.filter((r) => r.twoFactorEnabled).length;
  return { required, enrolled };
}

/**
 * Read helper used by the GET payload so the UI can render the
 * current list without a second round-trip. Always returns the
 * canonical normalised shape.
 */
export async function loadMfaRequiredRoleCodes(
  database: Db,
  zoneId: string,
): Promise<MfaEnforceableRoleCode[]> {
  const [row] = await database
    .select({ codes: zones.mfaRequiredRoleCodes })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!row) return [];
  return normalise(row.codes ?? []) as MfaEnforceableRoleCode[];
}

// Re-export so route + tests don't reach into `@stewardledger/shared`
// just to hold a type:
export type { MfaEnforceableRoleCode };
