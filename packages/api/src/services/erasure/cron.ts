// packages/api/src/services/erasure/cron.ts
// Phase 9 §6 — daily pg-boss sweep that applies past-due erasure
// requests. Mirrors `services/retention/cron.ts`: one queue, one
// idempotent schedule, idempotent boot.
//
// Schedule: 05:00 UTC — one hour after the retention sweep at
// 04:00, two hours after the report-cleanup at 03:00. Stacking
// the daily jobs avoids competing for the same off-hour window.
//
// Per-row failures are caught + logged + leave the row in
// `failed`; the loop continues so a single broken request can't
// block every other tenant.
//
// RELEVANT FILES: ./requests.ts (apply path), ../queue.ts

import { and, lte, eq } from "drizzle-orm";
import type { Db } from "@stewardledger/db";
import { erasureRequests } from "@stewardledger/db/schema";

import { db } from "../../db";
import { log } from "../../logger";
import { writeAudit } from "../audit";
import { getBoss } from "../queue";
import { applyErasureRequest } from "./requests";

const SWEEP_QUEUE = "erasure.apply.sweep";
const SWEEP_CRON = "0 5 * * *";

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
export async function startErasureSweep(): Promise<void> {
  const boss = await getBoss();
  await ensureQueueRegistered();
  await boss.work(SWEEP_QUEUE, async (): Promise<void> => {
    await runErasureSweep(db);
  });
  await boss.schedule(SWEEP_QUEUE, SWEEP_CRON);
  log.info("erasure sweep: subscriber + schedule ready");
}

export interface ErasureSweepSummary {
  considered: number;
  applied: number;
  failed: number;
}

/**
 * Signature of the apply path. Extracted so tests can inject a
 * spy without resorting to module-binding rewrites — `cron.ts`
 * imports `applyErasureRequest` at module init time, which means
 * a `vi.spyOn` on the exported binding wouldn't be seen by
 * `runErasureSweep`.
 */
type ApplyFn = (
  database: Db,
  input: {
    requestId: string;
    actorUserId: string | null;
    now?: Date;
  },
) => Promise<unknown>;

/**
 * Find every `pending` row whose `applies_at` has passed and run
 * the apply path on each. Per-row failures are caught + logged +
 * surface as `status='failed'` (the apply path itself handles the
 * status flip) so the loop keeps going.
 *
 * The `applyFn` parameter defaults to the real apply path; tests
 * inject a stub to exercise the per-row failure-isolation branch
 * without needing to set up a real scrub-failure scenario.
 *
 * Concurrency: this SELECT is a candidate enumeration, not a
 * claim. The actual row claim happens inside `applyErasureRequest`
 * via `SELECT ... FOR UPDATE SKIP LOCKED` so a second concurrent
 * worker (multi-node future, or operator-triggered apply
 * overlapping a cron beat) racing on the same row sees zero
 * locked rows and raises `concurrent_apply`, which this loop
 * catches and counts as a failure for telemetry.
 */
export async function runErasureSweep(
  database: Db,
  now: Date = new Date(),
  applyFn: ApplyFn = applyErasureRequest,
): Promise<ErasureSweepSummary> {
  const due = await database
    .select({ id: erasureRequests.id })
    .from(erasureRequests)
    .where(
      and(
        eq(erasureRequests.status, "pending"),
        lte(erasureRequests.appliesAt, now),
      ),
    );

  const summary: ErasureSweepSummary = {
    considered: due.length,
    applied: 0,
    failed: 0,
  };

  for (const row of due) {
    try {
      await applyFn(database, {
        requestId: row.id,
        actorUserId: null, // cron-applied: no operator
        now,
      });
      summary.applied++;
    } catch (err) {
      summary.failed++;
      log.error(
        { err, requestId: row.id },
        "erasure sweep: per-row apply failed; continuing",
      );
    }
  }

  // Platform-scope audit row with the sweep summary so an operator
  // can grep `platform.erasure.sweep.run` on the audit log.
  await writeAudit(database, {
    zoneId: null,
    action: "platform.erasure.sweep.run",
    entityType: "platform",
    after: summary,
  });

  log.info(summary, "erasure sweep: pass complete");
  return summary;
}

/** Test helper: reset the queue-registered latch so a fresh boot reruns. */
export function resetErasureRegistrationForTesting(): void {
  registered = false;
}
