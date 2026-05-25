// packages/api/src/services/reports/jobs-pgboss.ts
// Phase 7 PR 2 \u2014 pg-boss publisher + subscriber + boot sweep.
//
// Wires three queues against the singleton from `services/queue.ts`:
//   1. `report.generate` \u2014 one job per `report_jobs.id`. Handler
//      claims, runs, finalizes, sends the email.
//   2. `report.cleanup`  \u2014 daily schedule that drops expired
//      artefacts and flips rows to `status='expired'`.
//   3. Boot sweep      \u2014 once per process start, re-publishes any
//      `queued` row older than 60s in case `boss.send` failed
//      between row commit + first try.
//
// The DB row is the source of truth. `singletonKey: jobId` makes
// every `enqueueReportJob` call idempotent; pg-boss redelivery is
// safe because both `runClaimedJob` and `sendReportJobEmail` short-
// circuit on terminal status / `email_sent_at`.
//
// RELEVANT FILES: packages/api/src/services/queue.ts, packages/api/src/services/reports/jobs.ts

import { and, eq, lt } from "drizzle-orm";
import { reportJobs } from "@stewardledger/db/schema";
import { db } from "../../db";
import { log } from "../../logger";
import { getBoss } from "../queue";
import { cleanupExpiredArtefacts } from "./cleanup";
import { sendReportJobEmail } from "./email";
import {
  claimJobById,
  finalizeJob,
  getJobById,
  runClaimedJob,
  type ReportJobStatus,
} from "./jobs";

const GENERATE_QUEUE = "report.generate";
const CLEANUP_QUEUE = "report.cleanup";
const CLEANUP_CRON = "0 3 * * *"; // daily at 03:00 UTC
const BOOT_SWEEP_AGE_MS = 60_000;

let queuesRegistered = false;

/**
 * Publish a job. Called from `queueJob` after the row commits. The
 * singletonKey lets repeated publishes for the same row (boot sweep,
 * manual replay) coalesce into a single pending pg-boss job.
 */
export async function enqueueReportJob(jobId: string): Promise<void> {
  const boss = await getBoss();
  await ensureQueuesRegistered();
  await boss.send(GENERATE_QUEUE, { jobId }, { singletonKey: jobId });
}

async function ensureQueuesRegistered(): Promise<void> {
  if (queuesRegistered) return;
  const boss = await getBoss();
  // pg-boss 12 requires queues to be created explicitly. `createQueue`
  // is idempotent: re-calling on an existing queue is a no-op. We use
  // the `standard` policy (default) \u2014 multiple workers are fine,
  // singletonKey on send handles dedupe.
  await boss.createQueue(GENERATE_QUEUE);
  await boss.createQueue(CLEANUP_QUEUE);
  queuesRegistered = true;
}

/**
 * Boot-time bootstrap. Idempotent: safe to call on every process
 * start. Registers the two queues, attaches their workers, kicks
 * off the cleanup schedule, and sweeps any orphaned queued rows.
 */
export async function startReportQueue(): Promise<void> {
  const boss = await getBoss();
  await ensureQueuesRegistered();

  await boss.work<{ jobId: string }>(
    GENERATE_QUEUE,
    async (msgs: Array<{ data: { jobId: string } }>) => {
      // pg-boss 12 hands the handler a batch (size 1 by default).
      for (const msg of msgs) {
        await handleGenerate(msg.data.jobId);
      }
    },
  );

  await boss.work(CLEANUP_QUEUE, async (): Promise<void> => {
    await cleanupExpiredArtefacts(db);
  });

  // Daily schedule. `schedule` is idempotent per (queue, key); we
  // omit `key` so a single schedule slot is reused across restarts.
  await boss.schedule(CLEANUP_QUEUE, CLEANUP_CRON);

  await sweepOrphanedQueuedRows();

  log.info("report queue: subscribers + schedule + boot sweep ready");
}

async function handleGenerate(jobId: string): Promise<void> {
  // Atomic queued -> running. A `null` here means one of:
  //   1. Row deleted between enqueue + work (nothing to do).
  //   2. Another worker / a manual replay claimed it (nothing to do).
  //   3. Row is already terminal (pg-boss redelivery of a job that
  //      finished on a prior attempt) - try the idempotent email
  //      on `completed` / `failed`; never on `expired` (the blob is
  //      gone, the deep link would 404).
  const claimed = await claimJobById(db, jobId);
  if (claimed) {
    const outcome = await runClaimedJob(db, claimed);
    const finalized = await finalizeJob(db, claimed, outcome);
    await sendReportJobEmail(db, { job: finalized }).catch((err) =>
      log.warn({ err, jobId }, "report queue: email send failed"),
    );
    return;
  }
  const existing = await getJobById(db, jobId);
  if (!existing) return;
  const status = existing.status as ReportJobStatus;
  if (status === "completed" || status === "failed") {
    await sendReportJobEmail(db, { job: existing }).catch((err) =>
      log.warn({ err, jobId }, "report queue: idempotent email send failed"),
    );
  }
  // `running` (another worker has it) or `expired` (cleanup already
  // purged it) - do nothing.
}

/**
 * Re-publish queued rows that pg-boss doesn't know about. The
 * publish path is `INSERT row` \u2192 `boss.send`; a crash between the
 * two leaves the row visible to us but invisible to pg-boss. Run
 * once at boot.
 */
async function sweepOrphanedQueuedRows(): Promise<void> {
  const cutoff = new Date(Date.now() - BOOT_SWEEP_AGE_MS);
  const rows = await db
    .select({ id: reportJobs.id })
    .from(reportJobs)
    .where(
      and(eq(reportJobs.status, "queued"), lt(reportJobs.createdAt, cutoff)),
    )
    .limit(200);
  if (rows.length === 0) return;
  for (const row of rows) {
    try {
      await enqueueReportJob(row.id);
    } catch (err) {
      log.warn(
        { err, jobId: row.id },
        "report queue: boot sweep re-publish failed",
      );
    }
  }
  log.info({ count: rows.length }, "report queue: boot sweep re-published");
}

/** Test helper: reset the queue-registered latch so a fresh boot reruns. */
export function resetQueueRegistrationForTesting(): void {
  queuesRegistered = false;
}

