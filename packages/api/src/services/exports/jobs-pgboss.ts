// packages/api/src/services/exports/jobs-pgboss.ts
// Phase 9 §3 — pg-boss publisher + subscriber + boot sweep for the
// zone-export queue. Mirror of `services/reports/jobs-pgboss.ts`.
//
// Wires three queues against the singleton from `services/queue.ts`:
//   1. `zone.export.generate` — one job per `zone_exports.id`.
//      Handler claims, builds the bundle, finalizes, sends email.
//   2. `zone.export.cleanup`  — daily schedule that drops expired
//      artefacts and flips rows to `status='expired'`.
//   3. Boot sweep             — once per process start, re-publishes
//      any `queued` row older than 60s + resets stale `running`
//      rows whose worker likely crashed.
//
// The DB row is the source of truth. `singletonKey: exportId` makes
// every `enqueueZoneExportJob` call idempotent; pg-boss redelivery
// is safe because `handleGenerate` and `sendZoneExportEmail` both
// short-circuit on terminal status / `email_sent_at`.
//
// RELEVANT FILES: ../queue.ts, ./jobs.ts, ./bundle.ts, ./email.ts, ./cleanup.ts

import { and, eq, isNotNull, lt } from "drizzle-orm";
import { zoneExports } from "@stewardledger/db/schema";
import { db } from "../../db";
import { log } from "../../logger";
import { getBoss } from "../queue";
import { buildZoneExportBundle } from "./bundle";
import { cleanupExpiredZoneExports } from "./cleanup";
import { sendZoneExportEmail } from "./email";
import {
  bundleStorageKey,
  claimExportById,
  finalizeExport,
  getExportById,
  type ExportOutcome,
  type ZoneExportStatus,
} from "./jobs";

const GENERATE_QUEUE = "zone.export.generate";
const CLEANUP_QUEUE = "zone.export.cleanup";
// Run cleanup an hour after the report-cleanup (`0 3 * * *`) so the
// two heavy sweeps don't fight for the DB. Retention sweep is on
// `0 4 * * *` per the existing convention; export cleanup sits at
// `0 5 * * *` so each tier owns its hour.
const CLEANUP_CRON = "0 5 * * *";
const BOOT_SWEEP_QUEUED_AGE_MS = 60_000;
// A `running` bundle taking longer than 30 minutes is almost
// certainly an orphan from a worker crash. Report-jobs use 15
// minutes; bundles can be substantially larger so we double the
// allowance.
const STALE_RUNNING_AGE_MS = 30 * 60_000;

let queuesRegistered = false;

/**
 * Publish a job. Called from `queueExportJob` after the row commits.
 * The singletonKey lets repeated publishes for the same row (boot
 * sweep, manual replay) coalesce into a single pending pg-boss job.
 */
export async function enqueueZoneExportJob(exportId: string): Promise<void> {
  const boss = await getBoss();
  await ensureQueuesRegistered();
  await boss.send(GENERATE_QUEUE, { exportId }, { singletonKey: exportId });
}

async function ensureQueuesRegistered(): Promise<void> {
  if (queuesRegistered) return;
  const boss = await getBoss();
  await boss.createQueue(GENERATE_QUEUE);
  await boss.createQueue(CLEANUP_QUEUE);
  queuesRegistered = true;
}

/**
 * Boot-time bootstrap. Idempotent: safe to call on every process
 * start. Registers the two queues, attaches their workers, kicks
 * off the cleanup schedule, and sweeps any orphaned rows.
 */
export async function startZoneExportQueue(): Promise<void> {
  const boss = await getBoss();
  await ensureQueuesRegistered();

  await boss.work<{ exportId: string }>(
    GENERATE_QUEUE,
    async (msgs: Array<{ data: { exportId: string } }>) => {
      for (const msg of msgs) {
        await handleGenerate(msg.data.exportId);
      }
    },
  );

  await boss.work(CLEANUP_QUEUE, async (): Promise<void> => {
    await cleanupExpiredZoneExports(db);
  });

  await boss.schedule(CLEANUP_QUEUE, CLEANUP_CRON);

  await sweepOrphanedQueuedRows();

  log.info(
    "zone export queue: subscribers + schedule + boot sweep ready",
  );
}

/**
 * Run one claimed export to completion. Catches every error so the
 * worker loop never crashes; failures land on the row as
 * `errorCode` + `errorMessage`.
 *
 * **Non-retryable contract**: when `buildZoneExportBundle` throws,
 * we convert the error into a `failed` row + return normally. We
 * deliberately do NOT rethrow because:
 *
 *   1. pg-boss's retry would re-enter the handler against an
 *      already-`failed` row, where `claimExportById` no-ops and
 *      the idempotent email-send re-runs — wasted work without
 *      a path to recovery.
 *   2. Bundle failures (table_too_large, zone deleted mid-export,
 *      storage outage) are deterministically reproducible against
 *      the same row; retrying will hit the same wall.
 *   3. The owner sees the failure two ways: the failed email goes
 *      out via the email-send call below, and the row appears in
 *      `GET /zone/exports` with status=failed + errorMessage.
 *
 * Manual replay is the recovery path: an operator can delete the
 * `failed` row and the owner can POST a new export request.
 */
async function handleGenerate(exportId: string): Promise<void> {
  const claimed = await claimExportById(db, exportId);
  if (claimed) {
    let outcome: ExportOutcome;
    try {
      const result = await buildZoneExportBundle(db, {
        zoneId: claimed.zoneId,
        exportId: claimed.id,
        storageKey: bundleStorageKey(claimed.zoneId, claimed.id),
      });
      outcome = {
        status: "completed",
        storageKey: result.storageKey,
        byteCount: result.byteCount,
        tableCount: result.tableCount,
        fileCount: result.fileCount,
        artefactCount: result.artefactCount,
        sha256: result.sha256,
      };
    } catch (err) {
      outcome = {
        status: "failed",
        errorCode: "build_failed",
        errorMessage:
          err instanceof Error ? err.message : "Unknown export error",
      };
      log.error(
        { err, exportId: claimed.id },
        "zone export: bundle build failed",
      );
    }
    const finalized = await finalizeExport(db, claimed, outcome);
    await sendZoneExportEmail(db, { job: finalized }).catch((err) =>
      log.warn(
        { err, exportId: claimed.id },
        "zone export queue: email send failed",
      ),
    );
    return;
  }
  // Redelivery: row may already be terminal. Idempotent email send
  // covers the "we finished but pg-boss is retrying" case.
  const existing = await getExportById(db, exportId);
  if (!existing) return;
  const status = existing.status as ZoneExportStatus;
  if (status === "completed" || status === "failed") {
    await sendZoneExportEmail(db, { job: existing }).catch((err) =>
      log.warn(
        { err, exportId },
        "zone export queue: idempotent email send failed",
      ),
    );
  }
  // `running` (another worker has it) or `expired` (cleanup already
  // purged it) — do nothing.
}

/**
 * Flip stale `running` rows back to `queued`. The handler can't
 * recover these on its own because `claimExportById` only matches
 * `queued`. Exported for direct unit-testing without booting
 * pg-boss; the sweep below calls it inline.
 */
export async function recoverStaleRunningExports(
  database: typeof db,
  ageMs: number = STALE_RUNNING_AGE_MS,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - ageMs);
  const reset = await database
    .update(zoneExports)
    .set({ status: "queued", startedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(zoneExports.status, "running"),
        isNotNull(zoneExports.startedAt),
        lt(zoneExports.startedAt, cutoff),
      ),
    )
    .returning({ id: zoneExports.id });
  if (reset.length > 0) {
    log.warn(
      { count: reset.length, ids: reset.map((r) => r.id) },
      "zone export queue: reset stale running rows to queued",
    );
  }
  return reset.map((r) => r.id);
}

async function sweepOrphanedQueuedRows(): Promise<void> {
  // Step 1: reset any stale `running` rows so they re-enter the
  // queue alongside legitimately orphaned `queued` rows.
  await recoverStaleRunningExports(db);

  // Step 2: pick up every queued row older than the publish cutoff.
  const queuedCutoff = new Date(Date.now() - BOOT_SWEEP_QUEUED_AGE_MS);
  const rows = await db
    .select({ id: zoneExports.id })
    .from(zoneExports)
    .where(
      and(
        eq(zoneExports.status, "queued"),
        lt(zoneExports.createdAt, queuedCutoff),
      ),
    )
    .limit(200);
  if (rows.length === 0) return;
  for (const row of rows) {
    try {
      await enqueueZoneExportJob(row.id);
    } catch (err) {
      log.warn(
        { err, exportId: row.id },
        "zone export queue: boot sweep re-publish failed",
      );
    }
  }
  log.info(
    { count: rows.length },
    "zone export queue: boot sweep re-published",
  );
}

/** Test helper: reset the queue-registered latch so a fresh boot reruns. */
export function resetZoneExportQueueRegistrationForTesting(): void {
  queuesRegistered = false;
}
