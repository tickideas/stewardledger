# Phase 7 — Background `report.generate` worker (PR 1)

Closes ROADMAP Phase 7 *Background `report.generate` jobs with
email-when-ready* in two iterations:

- **PR 1 (this):** in-process async export generation. New
  `report_jobs` table, two endpoints, polling worker started by
  the API at boot. Status-only response; user polls for
  completion + downloads via a tenant-scoped URL.
- **PR 2 (follow-up):** swap the polling loop for pg-boss + add
  email-when-ready. The API contract doesn't change \u2014 the worker
  implementation does.

The user-visible win is *requests don't time out on big report
exports*. The 100k-row exit criterion under Phase 7 becomes
satisfiable: an export that takes >30 s on the request thread can
queue here and return immediately.

## MVP scope

### Schema (`report_jobs`)

| Column | Type | Notes |
|---|---|---|
| `id` | text PK uuid | |
| `zone_id` | text NOT NULL FK | tenant boundary |
| `user_id` | text NOT NULL FK | the requester |
| `report_id` | text NOT NULL | matches `ReportSpec.id` |
| `filters` | jsonb NOT NULL | parsed Zod output |
| `format` | text NOT NULL | `xlsx` or `pdf` |
| `status` | text NOT NULL default `queued` | `queued`, `running`, `completed`, `failed`, `expired` |
| `storage_key` | text | set on success; relative to `STORAGE_ROOT` |
| `error_code` | text | set on failure (e.g. `invalid_filters`, `forbidden`, `crash`) |
| `error_message` | text | human-readable |
| `row_count` | int | from `result.rows.length`, surfaced in the job status |
| `byte_count` | int | rendered artefact size |
| `expires_at` | timestamptz NOT NULL | now() + 7 days; cleanup leaves the row + drops the blob |
| `created_at`, `started_at`, `completed_at`, `updated_at` | timestamptz | lifecycle markers |

Indexes:
- `(status, created_at)` partial WHERE `status = 'queued'` so the
  worker's `SELECT … FOR UPDATE SKIP LOCKED` is index-aided.
- `(zone_id, user_id, created_at DESC)` for the list endpoint.

### API

Mounted under the existing reports router so the role gates and
spec-resolution stay uniform.

- `POST /api/tenant/reports/:id/jobs?format=xlsx|pdf` \u2014 body is
  the same filter shape the synchronous endpoint accepts; we
  re-use `parseReportFilters` against the spec's Zod schema
  before persistence. Returns `{ jobId, status: "queued" }`.
- `GET  /api/tenant/reports/jobs` \u2014 caller's jobs in this zone,
  newest first, cap of 50.
- `GET  /api/tenant/reports/jobs/:jobId` \u2014 single job status
  with a download URL when `status === "completed"`.
- `GET  /api/tenant/reports/jobs/:jobId/download` \u2014 streams the
  artefact. 404 if completed but expired or storage_key missing.

Access:
- POST / list / status: any caller who can READ the report.
- Download: re-checks `canExportReports` because the artefact
  is the same PII payload as the synchronous export.

Audit:
- `report.job.create` on queue, `report.job.complete` on
  success, `report.job.fail` on failure (action + reportId in
  `after`).

### Worker

A single in-process polling loop, started by the API at boot.

```ts
// Pseudocode
async function poll() {
  while (!shuttingDown) {
    const job = await db.transaction(async tx => {
      const [r] = await tx
        .update(reportJobs)
        .set({ status: "running", startedAt: now() })
        .where(eq(reportJobs.id,
          sql`(select id from report_jobs
                where status = 'queued'
                order by created_at asc
                limit 1
                for update skip locked)`))
        .returning();
      return r ?? null;
    });
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    await runJob(job);
  }
}
```

`runJob` mirrors the synchronous export path:
- Resolve the spec via `getReport(job.reportId)`.
- Re-validate `job.filters` (defensive against schema drift
  between queue + run).
- Re-check `accessCheck` against the persisted actor context
  (we cache `userId` + `zoneId` on the row; bindings can change
  between queue + run \u2014 we re-resolve the user's roles at run
  time).
- `spec.fetch` \u2192 `spec.excel | spec.pdf` \u2192 write to
  `storage().put("{zoneId}/reports/{yyyy}/{mm}/{jobId}.{ext}", bytes)`.
- Mark `completed`, `storage_key`, `row_count`, `byte_count`.
- On any error, mark `failed` + capture `error_code` /
  `error_message`; do NOT crash the loop.

Concurrency: one worker per process; CLAIM via
`for update skip locked` is the canonical safe pattern for
multi-process deployments to pick up. Today we run a single API
container so it doesn't matter.

Shutdown: an `AbortController` signal lets the poll loop exit on
SIGTERM. We don't pre-empt a running job \u2014 the worker waits up
to 10 s before exiting, then the orchestrator can SIGKILL.

### UI

Small additions to `/zone/reports/[id]/+page.svelte`:

- Below the existing *Download Excel* / *Download PDF* buttons,
  a *Generate in background* dropdown with the two formats.
  Submitting POSTs the new endpoint and shows a transient
  toast: "Job queued. We'll keep this list up to date."
- A *My recent jobs* panel below the report results: lists the
  caller's last 10 jobs for this report (filter by reportId on
  the list endpoint). Each row shows status + (when complete)
  a download link. Polls every 5 s while any job is in `queued`
  or `running`.

A separate `/zone/reports/jobs` page that lists every job across
reports is **deferred** \u2014 the per-report panel is enough for the
v1 flow ("I asked for this report, did it finish?").

## Non-goals (deferred to PR 2)

- Email-when-ready. The Phase 7 exit criterion mentions email;
  PR 2 wires it via the existing email service.
- pg-boss replacing the polling loop. The CLAIM pattern means
  the contract is identical; only the worker implementation
  changes.
- Streaming / pagination for huge result sets. The 100k-row
  exit criterion is hit by *not blocking the request thread*;
  the synchronous renderer continues to load the whole set
  into memory and call `spec.excel(rows, ...)`. If a report
  exceeds available memory inside the worker, that's a
  follow-up.
- Cron / scheduled saved-filter runs (separate Phase 14
  candidate).
- Cleanup job for `expires_at`-past rows. v1 leaves the row +
  drops the blob; we add a periodic prune in PR 2 alongside
  the email plumbing.

## Files

New:
- `packages/db/src/schema/report-jobs.ts`
- `packages/db/drizzle/0010_*.sql`
- `packages/api/src/services/reports/jobs.ts` (CRUD + run logic)
- `packages/api/src/services/reports/jobs-worker.ts` (poll loop)
- `packages/api/src/routes/tenant-reports-jobs.test.ts`

Modified:
- `packages/db/src/schema/index.ts` \u2014 export barrel.
- `packages/api/src/routes/tenant-reports.ts` \u2014 add the four
  job routes.
- `packages/api/src/server.ts` \u2014 start the worker on boot.
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` \u2014
  queue button + jobs panel.
- `docs/ROADMAP.md` \u2014 flip Phase 7 worker entry to landed.

## Tests

8 integration tests in `tenant-reports-jobs.test.ts`:

1. Queue: POST returns `{ jobId, status: "queued" }`; row exists with
   the parsed filters.
2. Worker: directly invoke `runJob(jobId)` (don't depend on the poll
   loop) and assert `status="completed"`, `storage_key` set, blob
   matches the synchronous Excel export bytes for the same filters.
3. Bad filter: POST with a payload that fails the spec's Zod schema
   returns 400 `invalid_filters` and writes no row.
4. Forbidden: a chapter treasurer queueing a member-statement for a
   member outside their chapters gets 403; no row.
5. Status endpoint: returns the job + a download URL when complete.
6. Download: returns the blob bytes with correct content-type +
   content-disposition. Re-fetch after expiry simulation returns 404.
7. Cross-user isolation: a user can't read another user's job in the
   same zone.
8. Cross-tenant isolation: a user can't read a job by jobId from
   zone B while resolved into zone A.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A treasurer can queue an Excel export for any report, poll the
  status panel, and download the artefact once `status="completed"`.
- A failed job surfaces the error inline.
- Roadmap Phase 7 background-worker entry annotated.
