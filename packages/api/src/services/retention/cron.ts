// packages/api/src/services/retention/cron.ts
// Phase 9 — pg-boss schedule that runs the per-zone retention sweep
// once a day. Mirrors the shape of `services/reports/jobs-pgboss.ts`
// so the operational model stays consistent: one queue, one
// idempotent schedule, idempotent boot.
//
// The handler iterates every non-soft-deleted zone, loads its policy,
// runs each dimension sweep, and emits two kinds of audit rows:
//
//   - one **tenant-scope** `zone.retention.sweep` row PER ZONE when the
//     pass actually deleted anything (skipped on a no-op so the audit
//     log stays signal-heavy);
//   - one **platform-scope** `platform.retention.sweep.run` row PER
//     PASS carrying the cross-tenant summary, regardless of whether
//     individual zones changed.
//
// RELEVANT FILES: ./policy.ts, ./sweep.ts, packages/api/src/services/queue.ts

import { isNull } from "drizzle-orm";
import { zones } from "@stewardledger/db/schema";

import { db } from "../../db";
import { log } from "../../logger";
import { writeAudit } from "../audit";
import { getBoss } from "../queue";
import { loadRetentionPolicy } from "./policy";
import { sweepZone, type ZoneSweepSummary } from "./sweep";

const SWEEP_QUEUE = "zone.retention.sweep";
// 04:00 UTC — one hour after the report-cleanup schedule at 03:00.
// Stacking the two daily jobs avoids competing for the same off-hour
// window without needing a coordination layer.
const SWEEP_CRON = "0 4 * * *";

let registered = false;

async function ensureQueueRegistered(): Promise<void> {
  if (registered) return;
  const boss = await getBoss();
  await boss.createQueue(SWEEP_QUEUE);
  registered = true;
}

/**
 * Boot-time bootstrap. Idempotent: safe to call on every process
 * start. Registers the queue, attaches the worker, and (re)installs
 * the daily schedule.
 */
export async function startRetentionSweep(): Promise<void> {
  const boss = await getBoss();
  await ensureQueueRegistered();
  await boss.work(SWEEP_QUEUE, async (): Promise<void> => {
    await runRetentionSweep(db);
  });
  await boss.schedule(SWEEP_QUEUE, SWEEP_CRON);
  log.info("retention sweep: subscriber + schedule ready");
}

/**
 * Run a single sweep pass across every non-soft-deleted zone
 * (`zones.deleted_at IS NULL`). Exported so tests can call it
 * directly without pg-boss.
 *
 * Errors per zone are caught + logged — one zone's broken state
 * shouldn't block sweeps for every other tenant. The per-zone
 * `zone.retention.sweep` audit row carries the per-dimension counts;
 * the platform-scope `platform.retention.sweep.run` row carries the
 * cross-tenant run summary.
 */
export async function runRetentionSweep(
  database: typeof db,
): Promise<{ zonesScanned: number; totals: ZoneSweepSummary }> {
  const activeZones = await database
    .select({ id: zones.id })
    .from(zones)
    .where(isNull(zones.deletedAt));

  const totals: ZoneSweepSummary = {
    audit_events: 0,
    import_files: 0,
    import_rows: 0,
    report_jobs: 0,
  };

  for (const zone of activeZones) {
    try {
      const policy = await loadRetentionPolicy(database, zone.id);
      const summary = await sweepZone(database, zone.id, policy);
      totals.audit_events += summary.audit_events;
      totals.import_files += summary.import_files;
      totals.import_rows += summary.import_rows;
      totals.report_jobs += summary.report_jobs;
      // Per-zone tenant-scope audit row — readable from the existing
      // `/zone/audit` surface. Skip the write when the pass was a
      // pure no-op so the audit log stays signal-heavy.
      const touchedAny =
        summary.audit_events +
          summary.import_files +
          summary.import_rows +
          summary.report_jobs >
        0;
      if (touchedAny) {
        await writeAudit(database, {
          zoneId: zone.id,
          action: "zone.retention.sweep",
          entityType: "zone",
          entityId: zone.id,
          after: summary,
        });
      }
    } catch (err) {
      log.error(
        { err, zoneId: zone.id },
        "retention sweep: per-zone pass failed; continuing",
      );
    }
  }

  // Platform-scope summary row. Action prefixed `platform.*` to satisfy
  // the audit_events_zone_scope_check constraint with NULL zone_id.
  await writeAudit(database, {
    zoneId: null,
    action: "platform.retention.sweep.run",
    entityType: "platform",
    after: { zonesScanned: activeZones.length, totals },
  });

  log.info(
    { zonesScanned: activeZones.length, totals },
    "retention sweep: pass complete",
  );
  return { zonesScanned: activeZones.length, totals };
}

/** Test helper: reset the queue-registered latch so a fresh boot reruns. */
export function resetRetentionRegistrationForTesting(): void {
  registered = false;
}
