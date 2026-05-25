# Phase 9 — Per-zone data export bundle

Closes the Phase 9 deliverable + exit criterion *"An exported
bundle contains every record for that zone and is independently
restorable."*

A `zone_owner` requests an export; a background job dumps every
zone-scoped row (schema + data), packages it with every
uploaded file in object storage and every retained report
artefact, signs a download URL, and emails the owner when
ready. The bundle must be independently restorable into a clean
schema using the same Drizzle migration set.

## Architecture overview

Reuse the Phase 7 PR 2 plumbing wholesale: pg-boss queue, the
`report_jobs`-style status row, the artefact-cleanup pattern,
and the `cleanup.ts` daily schedule. The job is a different
shape (zone-wide, longer-running, big artefact) but the
lifecycle is identical:

```
queued → running → completed (storage key + signed URL) → expired
                 → failed
```

## Schema

New table `zone_exports` (migration `0019_zone_exports.sql`):

```sql
CREATE TABLE zone_exports (
  id            text PRIMARY KEY,
  zone_id       text NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  requested_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  status        text NOT NULL CHECK (status IN ('queued','running','completed','failed','expired')),
  storage_key   text,
  byte_count    bigint,
  table_count   integer,
  file_count    integer,
  artefact_count integer,
  error_code    text,
  error_message text,
  started_at    timestamptz,
  completed_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  email_sent_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zone_exports_zone_status_idx ON zone_exports (zone_id, status, created_at desc);
CREATE INDEX zone_exports_expiry_idx ON zone_exports (expires_at) WHERE status = 'completed';
```

Default `expires_at` is created_at + 7 days (same as report
jobs). Operators can re-issue an expired bundle by requesting a
new one.

## Bundle shape

The artefact is a single `.tar.gz` at object-storage key
`{zoneId}/exports/{yyyy}/{mm}/{exportId}.tar.gz`. Layout:

```
zone-export-{slug}-{exportId}/
├── manifest.json             # zone slug, generated_at, table list, file count, sha256s
├── schema/
│   └── drizzle/              # copy of the migration set as of generation
├── data/
│   └── {table}.jsonl         # one JSONL per zone-scoped table, streamed
├── files/
│   └── imports/              # raw bytes for every import_files row
├── reports/
│   └── {jobId}.{ext}         # every retained report artefact for the zone
└── README.md                 # how to restore (drizzle migrate + jsonl-load script)
```

JSONL is chosen over `pg_dump` for v1 because:

- It runs inside the API container without a `pg_dump` binary
  in the Alpine image (the Dockerfile currently only ships
  `node:22-alpine`; adding `postgresql-client` is ~30 MB).
- It naturally tolerates schema drift on restore — the operator
  runs Drizzle migrations against a clean DB first, then loads
  JSONL row by row.
- The tests can assert row counts directly without parsing
  binary dump format.
- A full `pg_dump --data-only --no-owner` path can be added in
  Phase 11 once the operational story for restoring into a
  customer-owned DB is real. For v1 the JSONL is what an
  exfiltrating zone-owner takes with them.

Tables included (every `zone_id`-bearing table; the list is
derived from the Drizzle schema at codegen time, not hand-
maintained):

```
zones, regions (only the row(s) referenced by this zone),
chapters, chapter_name_history, groups, chapter_group_history,
members, addresses,
giving_categories, giving_types, payment_methods, accounts,
giving_type_account_mappings, service_types, service_events,
service_event_attendance, giving_periods, fiscal_periods,
ministry_periods, partnership_periods,
contributions, contribution_lines, contribution_members,
contribution_batches,
import_files, import_jobs, import_rows, import_row_failures,
import_failure_types (zone-scoped overrides only),
processed_transactions, import_schedules,
financial_targets, paying_in_books,
saved_report_filters, report_jobs (metadata only — artefacts
live in `reports/`),
audit_events, user_role_bindings (rows for this zone),
invitations.
```

`user`, `account`, `session`, `verification` (Better Auth) are
**not** included — they're global identity tables. Per the PRD
they're outside the zone boundary. A note in `README.md`
explains how to recreate the relevant users on restore (run
the standard invite flow against the new tenant).

## Service layer

New module `packages/api/src/services/exports/`:

- `bundle.ts` — `buildZoneExportBundle(db, { zoneId, exportId,
  storageKey }) → { tableCount, fileCount, artefactCount,
  byteCount }`. Streams each table's rows via Drizzle in 1k-row
  pages, gzips the tar archive incrementally (Node's
  `zlib.createGzip` + `tar-stream`) so we never hold the
  full bundle in memory. Copies import files and report
  artefacts via `storage().get(key)` per row.
- `bundle.test.ts` — integration: seeds a small zone (2
  chapters, 3 members, 5 contributions, 1 import file, 1
  retained report job), runs the build, untars the result,
  asserts the manifest matches, the JSONL row counts tie out,
  every file referenced in `data/import_files.jsonl` is present
  in `files/`, and a clean schema restored from `schema/` +
  a JSONL loader produces the same row counts.
- `jobs-pgboss.ts` — mirror of `services/reports/jobs-pgboss.ts`.
  Same queue patterns: `zone.export.generate` work queue +
  daily `zone.export.cleanup` schedule + boot sweep for
  orphaned `queued` and stale `running` rows. Same singletonKey
  idempotency.
- `email.ts` — "your export is ready" + "your export failed"
  templates, mirroring `services/reports/email.ts`. Reuses
  `useSend` and respects `email_sent_at` for idempotency.
- `cleanup.ts` — daily expiry sweep. Same pattern as
  `services/reports/cleanup.ts` (batch of 500, delete blob,
  flip status to `expired`, audit row).
- `restore-helper.ts` (in `scripts/`, not bundled) — a tiny
  Node script invoked as `pnpm restore-export <tar.gz> --target
  <tenant-slug>` that the docs reference. Out of strict v1
  scope for *generating* but in scope for *acceptance*: the
  acceptance test below restores into an empty schema.

## Route

New endpoints on `tenantZonesRouter`:

- `POST /api/tenant/zones/exports` — enqueue a new bundle. Body
  `{}` (no params; one bundle = whole zone). Returns the new
  row. Rate-limited to 1 per zone per 24 h to keep the storage
  footprint sane (lookup: most recent row's `created_at`).
  Audited as `zone.export.request` with the requesting
  user id.
- `GET /api/tenant/zones/exports` — list recent bundles for the
  zone (status, byte count, expires_at, signed download URL
  for completed rows). Paginated `limit + 1`.
- `GET /api/tenant/zones/exports/:id/download` — streams the
  artefact directly via `storage().get()` with
  `Content-Disposition: attachment;
  filename="zone-export-{slug}-{shortId}.tar.gz"`. 410 Gone if
  expired, 404 if not the caller's zone, 403 if the row isn't
  owned by a `zone_owner` call.

All three are `zone_owner`-only. Even `zone_admin` can't pull a
full data export — this is the highest-blast-radius single
action in the product.

## UI

New section on `/zone/settings/+page.svelte` (the page lands in
the retention-policy task; if those two tasks ship in either
order the surface is the same):

- Card titled "Export this zone's data".
- Subtitle: "Generates a complete archive of every record,
  uploaded file, and stored report for this zone. Owner-only."
- A "Request export" button. Disabled when an in-progress
  export exists for the zone (the loader includes the most
  recent row).
- A small table below listing the last 10 exports with status,
  size, created-at, expires-at, and a Download link.
- Each completed row shows a "Copy SHA-256" affordance for the
  manifest digest (already in the manifest; surfaced for
  operators who want to verify an out-of-band restore).

Non-owners see the panel rendered read-only with a "Owner-only
action — ask a zone owner to generate a bundle if you need
one." inline note.

## Files

New:

- `packages/db/drizzle/0019_zone_exports.sql`
- `packages/db/src/schema/zone-exports.ts`
- `packages/api/src/services/exports/{bundle,bundle.test,
  jobs-pgboss,jobs-pgboss.test,email,email.test,cleanup,
  cleanup.test}.ts`
- `packages/api/src/routes/tenant-exports.ts` — new sub-router
  mounted under `/api/tenant/zones/exports` from `tenant.ts`.
- `packages/api/src/routes/tenant-exports.test.ts` — owner-only
  gate, 24 h rate limit, expired-row 410, cross-zone 404.
- `scripts/restore-export.ts` — restore helper (Drizzle migrate
  to target → load each `data/*.jsonl` → copy `files/*` into
  the storage backend at the new zone id).
- `scripts/restore-export.test.ts` — round-trip test:
  generate → tear down DB → restore → assert row counts +
  hash a representative contribution.
- `packages/web/src/lib/exports/access.ts` +
  `access.test.ts` — `canRequestExport(auth) → boolean`
  predicate (owner only).
- `packages/web/src/routes/zone/settings/+page.svelte` —
  merge the new section in alongside the retention panel.

Modified:

- `packages/api/src/routes/tenant.ts` — mount the new router.
- `packages/api/src/server.ts` — boot the export queue
  alongside the existing `startReportQueue()`. Single
  `await startZoneExportQueue()`.
- `docs/ROADMAP.md` — flip Phase 9 *"Per-zone data export
  bundle"* and its exit criterion to done.
- `docs/DOMAIN-MODEL.md` — append a §15 "Exports" subsection
  documenting the bundle shape + manifest.
- `docs/DEPLOYMENT.md` — operator note: bundles can balloon
  past 1 GB for a large zone; ensure object storage and
  retention windows are sized accordingly.
- `package.json` — add `tar-stream` (small, MIT, ~10 KB) as a
  dependency. `zlib` is built-in.
- `Dockerfile.api` — no change (no `pg_dump` needed for the
  JSONL path).

## Tests

API:

- `bundle.test.ts` — seeded-fixture round-trip (above).
- `jobs-pgboss.test.ts` — mirror of the report-queue tests:
  boot sweep recovers orphaned rows, idempotent on redeliver,
  email-send respects `email_sent_at`.
- `cleanup.test.ts` — mirror of the report-cleanup tests:
  batched, status-conditional UPDATE, blob delete is best-
  effort.
- `tenant-exports.test.ts` — auth (owner-only) + happy path
  (request → wait for terminal status → download) + 24 h rate
  limit + cross-zone 404.

Web:

- `exports/access.test.ts` — 6-case predicate matrix.

End-to-end:

- `scripts/restore-export.test.ts` proves independent
  restorability — the canonical exit criterion. This test is
  the gate for ticking the Phase 9 box.

## Non-goals (deferred)

- Encrypted bundles with a customer-supplied passphrase
  (Phase 11+; the signed URL + 7-day expiry is the v1 control).
- Incremental / delta exports — every bundle is a full snapshot.
- Restoring into the *same* DB on top of an existing zone
  (merge semantics are out of scope; the restore helper requires
  an empty target).
- `pg_dump` path (deferred to Phase 11 when the Alpine image
  changes are justified by a customer who wants binary-fidelity
  restore).
- Streaming the bundle directly to the client (we always write
  to object storage; the signed download is the access path).
- Surfacing in-progress percentage to the UI (status badges
  are enough for v1; reuse the report-job status pattern).

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A `zone_owner` can request an export and download the
  resulting `.tar.gz` from `/zone/settings`.
- The `scripts/restore-export.ts` round-trip test passes:
  generate → drop DB → migrate → restore → row counts match,
  representative contribution hashes match, every referenced
  import file is byte-for-byte identical.
- The daily `zone.export.cleanup` schedule purges expired
  bundles and writes a single
  `platform.zone.export.cleanup.run` audit row per pass.
- The audit log shows `zone.export.request`,
  `zone.export.completed`, and
  `zone.export.expired` rows for the full lifecycle.
- A `zone_admin` (non-owner) sees the panel read-only and
  cannot request an export.
- ROADMAP Phase 9 *"Per-zone data export bundle"* deliverable
  and exit criterion *"An exported bundle contains every
  record for that zone and is independently restorable."*
  both ticked.
