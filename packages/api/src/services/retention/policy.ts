// packages/api/src/services/retention/policy.ts
// Phase 9 — read + write the per-zone retention policy column.
//
// The column is a partial jsonb blob; every read hydrates defaults
// from `@stewardledger/shared` so callers always work with the
// fully-populated `ZoneRetentionPolicy` shape. Writes are
// validated, normalised, and audited.
//
// RELEVANT FILES: ./sweep.ts, ./cron.ts, packages/db/src/schema/zones.ts

import type { Db } from "@stewardledger/db";
import { zones } from "@stewardledger/db/schema";
import {
  DEFAULT_RETENTION_POLICY,
  hydrateRetentionPolicy,
  type ZoneRetentionPolicy,
  type ZoneRetentionPolicyInput,
} from "@stewardledger/shared";
import { eq } from "drizzle-orm";

import { writeAudit } from "../audit";

export class RetentionPolicyError extends Error {
  constructor(
    readonly code: "zone_not_found",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Read the policy for a zone, hydrating defaults for any missing
 * dimension. Returns the canonical fully-populated shape; never
 * returns `undefined`.
 */
export async function loadRetentionPolicy(
  database: Db,
  zoneId: string,
): Promise<ZoneRetentionPolicy> {
  const [row] = await database
    .select({ retentionPolicy: zones.retentionPolicy })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!row) {
    throw new RetentionPolicyError("zone_not_found", `zone ${zoneId} not found`);
  }
  return hydrateRetentionPolicy(row.retentionPolicy as ZoneRetentionPolicyInput);
}

/**
 * Normalise a partial input by dropping any dimension whose retainDays
 * already matches the default. Keeps the stored column small + makes
 * "Restore defaults" a pure no-op write (which the audit layer
 * recognises as no-change and skips the row).
 */
function compactPolicy(
  input: ZoneRetentionPolicyInput,
): ZoneRetentionPolicyInput {
  const out: ZoneRetentionPolicyInput = {};
  for (const [key, value] of Object.entries(input) as Array<
    [keyof ZoneRetentionPolicyInput, { retainDays: number } | undefined]
  >) {
    if (!value) continue;
    const def = DEFAULT_RETENTION_POLICY[key as keyof typeof DEFAULT_RETENTION_POLICY];
    if (def && def.retainDays === value.retainDays) continue;
    out[key] = { retainDays: value.retainDays };
  }
  return out;
}

export interface UpdateRetentionPolicyInput {
  zoneId: string;
  actorUserId: string | null;
  policy: ZoneRetentionPolicyInput;
}

/**
 * Write a new policy. Returns the post-write hydrated shape so the
 * caller can hand it straight back to the client.
 *
 * No-op writes (the new effective policy matches the prior effective
 * policy) skip the column update **and** the audit row to keep the
 * audit log readable for actual changes. The `before` payload in the
 * audit row carries the prior **effective** shape, not the raw
 * compacted column, so an operator reading the audit log doesn't have
 * to mentally hydrate defaults.
 */
export async function updateRetentionPolicy(
  database: Db,
  { zoneId, actorUserId, policy }: UpdateRetentionPolicyInput,
): Promise<ZoneRetentionPolicy> {
  return await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ retentionPolicy: zones.retentionPolicy })
      .from(zones)
      .where(eq(zones.id, zoneId))
      .limit(1);
    if (!row) {
      throw new RetentionPolicyError(
        "zone_not_found",
        `zone ${zoneId} not found`,
      );
    }
    const before = hydrateRetentionPolicy(
      row.retentionPolicy as ZoneRetentionPolicyInput,
    );
    const compact = compactPolicy(policy);
    const after = hydrateRetentionPolicy(compact);
    if (effectivelyEqual(before, after)) {
      return before;
    }
    await tx
      .update(zones)
      .set({ retentionPolicy: compact, updatedAt: new Date() })
      .where(eq(zones.id, zoneId));
    await writeAudit(tx, {
      zoneId,
      actorUserId,
      action: "zone.retention_policy.update",
      entityType: "zone",
      entityId: zoneId,
      before,
      after,
    });
    return after;
  });
}

function effectivelyEqual(
  a: ZoneRetentionPolicy,
  b: ZoneRetentionPolicy,
): boolean {
  return (
    a.audit_events.retainDays === b.audit_events.retainDays &&
    a.import_files.retainDays === b.import_files.retainDays &&
    a.import_rows.retainDays === b.import_rows.retainDays &&
    a.report_jobs.retainDays === b.report_jobs.retainDays &&
    a.member_soft_deletes.retainDays === b.member_soft_deletes.retainDays
  );
}
