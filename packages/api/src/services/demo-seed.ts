// packages/api/src/services/demo-seed.ts
// Helpers for demo-data tooling. Lives in src/services (not scripts/) so it
// can be unit-tested via vitest without the script running its own main().

import { inArray, sql } from "drizzle-orm";
import {
  chapters,
  contributionLines,
  contributionMembers,
  contributions,
  members,
  zones,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";

/**
 * Triggers we temporarily disable to wipe demo data. Posted contributions
 * are immutable in normal operation; we own demo data and need to delete it.
 */
const POSTED_GUARD_TRIGGERS = [
  ["contributions", "contributions_posted_guard"],
  ["contributions", "contributions_no_delete_when_posted"],
  ["contribution_lines", "contribution_lines_posted_guard"],
] as const;

/**
 * Delete every zone whose slug matches one of `slugs`, plus all its
 * dependent rows. Refuses any slug that doesn't start with `prefix` as a
 * defence against future edits accidentally aiming at a real tenant.
 *
 * Re-enables the posted-guard triggers in a `finally` block so a failed
 * delete cannot leave the database in a state where posted contributions
 * are mutable. (The triggers would also be restored by a transaction
 * rollback; the explicit re-enable matters for the happy path.)
 */
export async function dropDemoZones(
  database: Db,
  slugs: readonly string[],
  prefix: string,
): Promise<{ deletedZones: number }> {
  if (slugs.length === 0) return { deletedZones: 0 };
  for (const s of slugs) {
    if (!s.startsWith(prefix)) {
      throw new Error(
        `dropDemoZones refused: slug "${s}" lacks "${prefix}" prefix`,
      );
    }
  }

  const rows = await database
    .select({ id: zones.id })
    .from(zones)
    .where(inArray(zones.slug, slugs as string[]));
  if (rows.length === 0) return { deletedZones: 0 };
  const ids = rows.map((r) => r.id);

  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
    );
    for (const [t, n] of POSTED_GUARD_TRIGGERS) {
      await tx.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
    }
    try {
      await tx.delete(contributionLines).where(inArray(contributionLines.zoneId, ids));
      await tx.delete(contributionMembers).where(inArray(contributionMembers.zoneId, ids));
      await tx.delete(contributions).where(inArray(contributions.zoneId, ids));
      await tx.delete(members).where(inArray(members.zoneId, ids));
      await tx.delete(chapters).where(inArray(chapters.zoneId, ids));
      await tx.delete(zones).where(inArray(zones.id, ids));
    } finally {
      for (const [t, n] of POSTED_GUARD_TRIGGERS) {
        await tx.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
      }
    }
  });

  return { deletedZones: rows.length };
}

/**
 * Read the enabled-state of the posted-guard triggers. Returns one row per
 * trigger with `tgenabled` ('O' = enabled, 'D' = disabled). Used by tests
 * to assert the reset path leaves the database in a safe state.
 */
export async function readPostedGuardTriggerStates(
  database: Db,
): Promise<{ table: string; trigger: string; enabled: boolean }[]> {
  const rows = await database.execute(
    sql`select c.relname as table, t.tgname as trigger, t.tgenabled as state
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        where t.tgname in (
          'contributions_posted_guard',
          'contributions_no_delete_when_posted',
          'contribution_lines_posted_guard'
        )
          and not t.tgisinternal
        order by c.relname, t.tgname`,
  );
  return (rows as unknown as { table: string; trigger: string; state: string }[]).map((r) => ({
    table: r.table,
    trigger: r.trigger,
    enabled: r.state === "O",
  }));
}
