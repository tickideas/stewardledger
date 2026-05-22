// packages/api/src/services/reports/jobs-worker.ts
// Phase 7 PR 1 \u2014 in-process polling worker for queued `report_jobs`.
//
// Started by `server.ts` at boot and stopped on SIGTERM. The loop is
// a thin wrapper around `runOnce`: when the queue is empty we sleep
// `POLL_INTERVAL_MS`, otherwise we keep draining without delay so a
// burst of queued jobs doesn't wait an interval per job.
//
// PR 2 swaps this for pg-boss; the contract above (claim \u2192 run \u2192
// finalize) is identical, so the route layer and the tests don't
// change shape.
//
// RELEVANT FILES: packages/api/src/services/reports/jobs.ts, packages/api/src/server.ts

import { db } from "../../db";
import { log } from "../../logger";
import { runOnce, type JobSummary } from "./jobs";

const POLL_INTERVAL_MS = 2_000;

let running = false;
let stopRequested = false;
let inflight: Promise<void> | null = null;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    // Hold the listener in a named ref so we can remove it whichever
    // path wins (timer expiry or abort). Without explicit removal,
    // signal listeners accumulate across thousands of 2-second polls
    // until the process exits.
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function loop(signal: AbortSignal): Promise<void> {
  while (!stopRequested) {
    let summary: JobSummary | null = null;
    try {
      summary = await runOnce(db);
    } catch (err) {
      // `runOnce` shouldn't throw \u2014 `runClaimedJob` catches and
      // surfaces every error on the row. A throw here is a bug
      // in the service layer or an unrecoverable DB outage.
      // Either way, log and back off so we don't spin.
      log.error({ err }, "report-job worker: runOnce threw unexpectedly");
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }
    if (!summary) {
      // Queue empty \u2014 wait for the next interval.
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }
    // A job ran. Loop again immediately so a queued burst drains
    // without per-iteration sleeps.
    log.info(
      {
        jobId: summary.id,
        reportId: summary.reportId,
        status: summary.status,
        rowCount: summary.rowCount,
        byteCount: summary.byteCount,
      },
      "report-job worker: ran job",
    );
  }
}

let abort: AbortController | null = null;

export function startReportJobsWorker(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  abort = new AbortController();
  log.info("report-job worker: starting");
  inflight = loop(abort.signal).finally(() => {
    running = false;
    inflight = null;
    log.info("report-job worker: stopped");
  });
}

/**
 * Request a graceful shutdown. Resolves once the in-flight job
 * (if any) completes, up to `maxWaitMs`. Callers should await this
 * during process termination so partial work doesn't get torn
 * down mid-render.
 */
export async function stopReportJobsWorker(maxWaitMs = 10_000): Promise<void> {
  if (!running) return;
  stopRequested = true;
  abort?.abort();
  const deadline = Date.now() + maxWaitMs;
  while (running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Test helper: is the worker loop active right now? */
export function isReportJobsWorkerRunning(): boolean {
  return running;
}

/** Test helper: await the in-flight worker promise, if any. */
export function reportJobsWorkerInflight(): Promise<void> | null {
  return inflight;
}
