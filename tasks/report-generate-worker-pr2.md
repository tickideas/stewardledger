# Phase 7 — Background `report.generate` worker (PR 2)

Closes ROADMAP Phase 7 *Background `report.generate` jobs with
email-when-ready*. PR 1 landed the in-process polling worker,
the `report_jobs` table, and the four tenant routes. PR 2:

1. Swaps the polling loop for **pg-boss**, using the existing
   `claim → run → finalize` service-layer split. No route
   contract change.
2. Adds **email-when-ready**: a branded transactional email
   (success + failure variants) sent through the existing
   `usesend` adapter.
3. Adds a daily **expiry cleanup** job: deletes the artefact
   blob, flips the row to `status='expired'`, retains the row
   for audit.

On merge, the Phase 7 background-worker entry in
`docs/ROADMAP.md` flips to a single Done line and the
`tasks/report-generate-worker.md` follow-up is closed.

## Non-goals (explicit)

- **Streaming / pagination for huge result sets.** The
  `>100k rows stream/paginate, never time out` Phase 7 exit
  criterion is a separate concern about the renderer itself
  loading the full row set into memory. PR 2 does **not**
  satisfy it. Tracked separately.
- **Cron / scheduled saved-filter runs.** Phase 14 candidate;
  unrelated to PR 2.
- **Multi-process worker scale-out.** The pg-boss subscriber
  uses the canonical `for update skip locked` claim pattern
  through pg-boss internals, so N processes are safe — but we
  still run a single API container today.

## Architecture overview

```
HTTP POST /reports/:id/jobs
  └─ queueJob(ctx, …)            ← packages/api/src/services/reports/jobs.ts
       ├─ INSERT report_jobs           (existing)
       ├─ writeAudit "report.job.create" (existing)
       └─ enqueueReportJob(jobId)      ← NEW: publish "report.generate"
                                          inside the same tx via
                                          pg-boss boss.send

pg-boss subscriber (boot)
  └─ boss.work("report.generate", handler)
       └─ handler(jobId):
            ├─ load row by id (status must be 'queued' OR 'running'
            │   with a stale started_at — re-runs are safe)
            ├─ claimNextJob equivalent (status='running')
            ├─ runClaimedJob(db, job)   ← existing, untouched
            ├─ finalizeJob(db, job, outcome) ← existing
            └─ sendReportJobEmail(job, outcome) ← NEW

pg-boss scheduler (boot)
  └─ boss.schedule("report.cleanup", "0 3 * * *")
       └─ work handler: cleanupExpiredArtefacts(db)
            ├─ select id, storage_key
                where status='completed' and storage_key is not null
                and expires_at < now()
            ├─ storage().delete(storage_key)
            └─ update report_jobs set status='expired', storage_key=null
```

The DB row remains the source of truth. pg-boss is a dispatcher;
a missed enqueue is recovered by a boot-time **sweeper** that
re-publishes any `queued` row older than `BOOT_SWEEP_AGE_MS` (60 s
default) that has no in-flight pg-boss job. This closes the
window between `INSERT report_jobs` committing and a process
crash before `boss.send` runs.

## Dependencies + env

Add to `packages/api/package.json`:

```json
"pg-boss": "^11.0.0"
```

(latest stable as of writing; pg-boss 10+ uses native UUID PKs
and a single connection-string constructor — matches our setup.)

Env knobs (default values; expose in `packages/api/src/env.ts`
only if operations needs to tune them):

| Var | Default | Purpose |
|---|---|---|
| `REPORT_JOB_EMAIL_FROM` | `env.USESEND_FROM` | Override the From: header for report emails only. |
| `REPORT_JOB_CLEANUP_CRON` | `"0 3 * * *"` | UTC. Daily 03:00. |
| `REPORT_JOB_BOOT_SWEEP_AGE_MS` | `60_000` | Re-publish `queued` rows older than this on boot. |

No new env is **required**; defaults work out of the box. The
existing `USESEND_*` env still gates real email sends. In dev,
the email lands in the existing `dev-log` branch and the test
suite asserts that branch is hit (see Tests §3).

`pg-boss` creates its own `pgboss` schema on `boss.start()`. CI
must run `boss.start()` once before tests that exercise the
queue, then `boss.stop()` on teardown. The Drizzle migration
roundtrip test is unaffected — pg-boss owns its schema
externally.

## Schema delta

Single migration `00XX_report_jobs_pr2.sql`:

```sql
-- One nullable column so we don't double-send if pg-boss
-- redelivers a completed handler. Idempotency belongs on the
-- row, not on pg-boss config.
alter table report_jobs
  add column email_sent_at timestamptz;

-- `expired` is a new terminal status. Add to the check.
alter table report_jobs
  drop constraint report_jobs_status_check;
alter table report_jobs
  add constraint report_jobs_status_check
  check (status in ('queued','running','completed','failed','expired'));
```

`ReportJobStatus` in `services/reports/jobs.ts` gains `"expired"`
as a fifth member. The download endpoint already 404s when
`storage_key is null`, so the status-only change does not break
existing callers; the UI's status panel adds an `Expired` chip.

## Code changes

### New: `packages/api/src/services/queue.ts`

Singleton pg-boss wrapper. The whole module is ~80 LOC:

```ts
import PgBoss from "pg-boss";
import { env } from "../env";
import { log } from "../logger";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;
  starting = (async () => {
    const b = new PgBoss({
      connectionString: env.DATABASE_URL,
      // pg-boss owns its schema; keep it isolated.
      schema: "pgboss",
      // Long-running renders shouldn't hold a slot forever.
      newJobCheckInterval: 2_000,
    });
    b.on("error", (err) => log.error({ err }, "pg-boss error"));
    await b.start();
    boss = b;
    return b;
  })();
  return starting;
}

export async function stopBoss(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true, timeout: 10_000 });
  boss = null;
  starting = null;
}
```

### New: `packages/api/src/services/reports/jobs-pgboss.ts`

```ts
import type PgBoss from "pg-boss";
import { db } from "../../db";
import { log } from "../../logger";
import { getBoss } from "../queue";
import { runClaimedJob, finalizeJob, getJobById } from "./jobs";
import { cleanupExpiredArtefacts } from "./cleanup";
import { sendReportJobEmail } from "./email";

const QUEUE = "report.generate";
const CLEANUP_QUEUE = "report.cleanup";

export async function enqueueReportJob(jobId: string): Promise<void> {
  const boss = await getBoss();
  // singletonKey ensures pg-boss treats repeated publishes for the
  // same jobId as a single job — boot-sweep re-publishes are safe.
  await boss.send(QUEUE, { jobId }, { singletonKey: jobId });
}

export async function startReportQueue(): Promise<void> {
  const boss = await getBoss();
  await boss.work<{ jobId: string }>(QUEUE, async (msg) => {
    const job = await getJobById(db, msg.data.jobId);
    if (!job) return; // row deleted between enqueue + work
    if (job.status === "completed" || job.status === "failed" || job.status === "expired") {
      return; // pg-boss redeliver, already terminal
    }
    const outcome = await runClaimedJob(db, job);
    const finalized = await finalizeJob(db, job, outcome);
    await sendReportJobEmail(db, finalized);
  });
  await boss.work(CLEANUP_QUEUE, async () => cleanupExpiredArtefacts(db));
  await boss.schedule(CLEANUP_QUEUE, "0 3 * * *");
  log.info("report queue: subscribers started");

  // Boot sweep: re-publish queued rows older than 60 s that pg-boss
  // doesn't have an in-flight job for. Cheap; runs once.
  await sweepOrphanedQueuedRows(boss);
}

async function sweepOrphanedQueuedRows(boss: PgBoss): Promise<void> {
  // See implementation note in §"Sweep semantics" below.
}
```

### New: `packages/api/src/services/reports/cleanup.ts`

```ts
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { reportJobs } from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { log } from "../../logger";
import { storage } from "../storage";

export interface CleanupSummary {
  scanned: number;
  deletedArtefacts: number;
  expiredRows: number;
}

export async function cleanupExpiredArtefacts(
  database: Database,
): Promise<CleanupSummary> {
  const candidates = await database
    .select({ id: reportJobs.id, storageKey: reportJobs.storageKey })
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.status, "completed"),
        isNotNull(reportJobs.storageKey),
        lt(reportJobs.expiresAt, sql`now()`),
      ),
    )
    .limit(500); // bounded; next scheduled run picks up the rest.

  let deletedArtefacts = 0;
  for (const row of candidates) {
    if (!row.storageKey) continue;
    try {
      await storage().delete(row.storageKey);
      deletedArtefacts += 1;
    } catch (err) {
      log.warn({ err, jobId: row.id }, "report cleanup: blob delete failed");
      // Continue — still flip the row to expired so we don't loop.
    }
  }
  if (candidates.length === 0) {
    return { scanned: 0, deletedArtefacts: 0, expiredRows: 0 };
  }
  const ids = candidates.map((c) => c.id);
  const flipped = await database
    .update(reportJobs)
    .set({ status: "expired", storageKey: null, updatedAt: new Date() })
    .where(sql`${reportJobs.id} = ANY(${ids})`)
    .returning({ id: reportJobs.id });
  return {
    scanned: candidates.length,
    deletedArtefacts,
    expiredRows: flipped.length,
  };
}
```

### New: `packages/api/src/services/reports/email.ts`

Branded "Your {report} export is ready" / "failed" email. Uses
the existing `sendEmail` + `brandedEmailHtml` helpers in
`services/email.ts`. Sets `email_sent_at` after a successful
send so a pg-boss redeliver doesn't double-send.

Subjects:

- Success: `Your {reportTitle} export is ready`
- Failure: `Your {reportTitle} export failed`

Body (success):

> Hi {userName},
>
> Your **{reportTitle}** export is ready. It's available for the
> next 7 days.
>
> {DownloadLinkButton → `${PUBLIC_WEB_URL}/zone/reports/${reportId}#jobs`}
>
> If you didn't request this, you can ignore this email.

Body (failure) carries the human-readable `errorMessage` and a
link back to the report page so the user can retry.

The deep link points to the per-report jobs panel — the user
re-authenticates if needed and the download endpoint enforces
`canExportReports` on every fetch. We do **not** ship a signed
URL in v1 because the download is gated on the same role check
that issued the queue.

### New: `packages/api/src/services/reports/jobs.ts` additions

A small `getJobById(db, jobId)` helper (currently the worker
reads via `claimNextJob`'s raw SQL; pg-boss receives the id and
needs a typed read). It does **not** enforce caller identity —
that already happens in `runClaimedJob` via
`resolveAuthAtRunTime`.

`queueJob` gets one new line after the tx commits:

```ts
await enqueueReportJob(result.id);
```

It runs **outside** the tx so a `boss.send` failure doesn't roll
back the row — the boot sweep would catch the orphan on next
start. We log + continue if `boss.send` throws, on the
deliberate principle that the persisted row is the durable
truth.

### Modified: `packages/api/src/server.ts`

Replace the in-process worker boot with pg-boss boot:

```ts
import { startReportQueue } from "./services/reports/jobs-pgboss";
import { stopBoss } from "./services/queue";

// after server.listen…
void startReportQueue().catch((err) =>
  log.error({ err }, "report queue: failed to start"),
);

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "shutting down");
  await stopBoss();
  server.close(() => process.exit(0));
};
```

`startReportJobsWorker` / `stopReportJobsWorker` and the
polling loop in `services/reports/jobs-worker.ts` are **deleted**.
The `runOnce` + `claimNextJob` helpers in `jobs.ts` stay — the
tests still call them directly to exercise the service layer
without booting pg-boss. The worker module's two test exports
(`isReportJobsWorkerRunning`, `reportJobsWorkerInflight`) are
removed; any test depending on them migrates to calling
`runOnce(db)` directly.

### Modified: `packages/api/src/services/storage.ts`

Already has `delete(key)` on the interface and both adapters
(`FsStorage` + `InMemoryStorage`). No changes required.

### Modified: `packages/web/src/routes/zone/reports/[id]/+page.svelte`

Add an `Expired` status pill to the jobs panel. The download
button hides for `expired` rows; existing `completed`-only
visibility was already there.

## Sweep semantics (boot recovery)

On boot, after `boss.work` is registered:

```sql
select id from report_jobs
 where status = 'queued'
   and created_at < now() - interval '60 seconds';
```

For each id, call `enqueueReportJob(id)` — pg-boss dedupes via
`singletonKey: jobId`. This handles two crash scenarios:

1. `queueJob`'s row committed but the process died before
   `boss.send` returned.
2. pg-boss-internal state was lost (rare; `pgboss` schema
   truncated). The visible queue is `report_jobs.status =
   'queued'` and the sweep repopulates pg-boss from it.

The sweep runs once at boot — there's no need for a periodic
sweep because a healthy process always enqueues after insert,
and crashes are recovered by the next boot.

## Audit + observability

- `report.job.complete` and `report.job.fail` audit events are
  already emitted by `finalizeJob`; PR 2 does not change the
  payload.
- `report.cleanup.run` (new): platform-scoped audit (NULL
  `zone_id`) with `after = { scanned, deletedArtefacts,
  expiredRows }`. Mirrors the precedent set by
  `import.rollback`.
- The `email_sent_at` column is metadata-only; no audit event
  for the send itself (the audit log shouldn't dump email
  bodies; the row + timestamp is sufficient).

## Tests

7 new tests across two files. Each is a single behaviour; they
do not depend on a running pg-boss instance for the unit
assertions (the queue is mocked) but the integration tests
require pg-boss against the test DB.

### `services/reports/cleanup.test.ts` (4 tests)

1. **No candidates → no-op.** `cleanupExpiredArtefacts` returns
   `{scanned: 0, deletedArtefacts: 0, expiredRows: 0}` when no
   `completed` rows have expired.
2. **Flips expired completed rows.** Insert one `completed`
   row with `storage_key` set + `expires_at = now() - 1d`;
   assert blob deleted from the in-memory adapter and row
   status flips to `expired`, `storage_key` is NULL.
3. **Skips already-expired or failed rows.** A `failed` row
   with `expires_at` in the past stays `failed`; the cleanup
   query filters on `status='completed'`.
4. **Blob delete failure doesn't poison the flip.** Stub the
   adapter to throw on `.delete`; assert the row still flips
   to `expired` (we log + continue).

### `services/reports/email.test.ts` (3 tests)

1. **Success email content.** Build a completed job, capture
   the message sent by stubbing `sendEmail`. Assert subject
   matches `Your Member statement export is ready`, body
   includes the report title + the canonical deep link.
2. **Failure email carries errorMessage.** Same shape against
   a `failed` outcome.
3. **Idempotent: `email_sent_at` set after success; second
   call no-ops.** Verifies pg-boss redelivery doesn't
   double-send.

`tenant-reports-jobs.test.ts` (existing) gets two assertions
appended:

- After `runOnce(db)` finishes a job, `email_sent_at` is set
  on the row.
- `cleanupExpiredArtefacts` integration: after manually
  expiring a job, the next cleanup pass returns 404 from the
  download endpoint and the audit log carries one
  `report.cleanup.run` event.

The polling-worker tests in PR 1 that referenced
`reportJobsWorkerInflight` / `isReportJobsWorkerRunning` are
deleted, not migrated — the equivalent behaviour is now covered
by direct `runOnce(db)` invocations + the pg-boss subscriber
integration test.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A treasurer queues an export and receives an email within
  seconds of completion (locally: the `dev-log` transport
  prints the email).
- A failed export sends the failure email; the user can retry
  from the jobs panel.
- A completed artefact older than 7 days is purged by the
  daily cleanup job; the row remains visible with `Expired`
  status and a 404 on download.
- `docs/ROADMAP.md` Phase 7 background-worker bullet collapses
  from a PR 1 / PR 2 split into a single Done line.
- `tasks/report-generate-worker.md` deletion or merging into
  this spec (one consolidated history).

## File summary

**New**

- `packages/api/src/services/queue.ts`
- `packages/api/src/services/reports/jobs-pgboss.ts`
- `packages/api/src/services/reports/cleanup.ts`
- `packages/api/src/services/reports/email.ts`
- `packages/api/src/services/reports/cleanup.test.ts`
- `packages/api/src/services/reports/email.test.ts`
- `packages/db/drizzle/00XX_report_jobs_pr2.sql`

**Modified**

- `packages/api/package.json` — add `pg-boss`
- `packages/api/src/server.ts` — swap worker boot to queue boot
- `packages/api/src/services/reports/jobs.ts` — `getJobById`,
  `enqueueReportJob` call from `queueJob`, append email-sent
  metadata in `finalizeJob` (the actual send lives in
  `email.ts`)
- `packages/db/src/schema/report-jobs.ts` — `emailSentAt`
  column, `expired` added to the status check
- `packages/api/src/routes/tenant-reports-jobs.test.ts` —
  email + cleanup assertions
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  Expired status pill
- `docs/ROADMAP.md` — Phase 7 background-worker entry
- `tasks/report-generate-worker.md` — delete (or mark
  superseded)

**Deleted**

- `packages/api/src/services/reports/jobs-worker.ts`
- Any test referencing `reportJobsWorkerInflight` /
  `isReportJobsWorkerRunning`

## Open questions

- **pg-boss version pinning.** Confirm the latest stable that
  works against PG 17. If 11.x has regressions, fall back to
  10.x; the API surface used here (`send`, `work`, `schedule`,
  `start`, `stop`) is stable across both.
- **Email rate limiting.** `usesend` already has its own
  throttling. If a zone runs 50 reports in a minute, we send
  50 emails. Acceptable for v1; if we hear complaints we can
  add a 5-minute batching window in a follow-up.
- **Cleanup batch size.** 500 per run is arbitrary. At 1 job /
  user / day across 100 zones, the table is comfortably under
  that. Re-evaluate if we see growth.
