# Phase 9 — Retention configuration

Closes the Phase 9 deliverable *"Retention configuration"* and
sets the groundwork for the upcoming export-bundle + GDPR-erase
tasks (both of which read the retention window when deciding
what to include / when to scrub).

Today the only retained-then-purged dataset is the report-job
artefacts (PR #58: `services/reports/cleanup.ts`, daily pg-boss
schedule at `0 3 * * *`, 7-day default). Every other accumulating
table — `audit_events`, `import_files` (bytes in object storage),
`import_jobs` / `import_rows` (parse output), `report_jobs` rows
themselves after expiry, soft-deleted `members.deleted_at` —
grows forever. We need a per-zone policy column with sensible
defaults plus scheduled vacuum jobs that respect it.

## Why a JSONB column, not separate columns

- The set of retention dimensions will grow (audit log, imports,
  reports, member soft-deletes are the v1 four; bank statements,
  document attachments come later in Phase 14). A `jsonb` policy
  blob lets each dimension be added without a migration per
  field.
- The policy is read by background workers, not in any hot path,
  so the GIN-vs-`->>` perf concern is moot.
- It mirrors `zones.branding jsonb` and the audit-event
  `before / after` shape — operators already grok the pattern.
- A Zod schema in `packages/shared` is the canonical contract
  (the column is `jsonb`, the meaning is the schema).

## Schema

New migration `packages/db/drizzle/0018_zone_retention_policy.sql`:

```sql
ALTER TABLE "zones"
  ADD COLUMN "retention_policy" jsonb NOT NULL
  DEFAULT '{}'::jsonb;
```

`packages/db/src/schema/zones.ts` — append:

```ts
retentionPolicy: jsonb("retention_policy").notNull().default({}),
```

The JSON shape (validated on every write by the new shared
schema, hydrated with defaults on every read):

```ts
{
  audit_events: { retainDays: number },         // default: 1825 (5 years)
  import_files: { retainDays: number },         // default: 365  — bytes in storage
  import_rows:  { retainDays: number },         // default: 90   — parse output
  report_jobs:  { retainDays: number },         // default: 7    — already shipping
  member_soft_deletes: { retainDays: number },  // default: 0    — never purged in v1
}
```

`retainDays: 0` for a dimension means **never purge** (used for
`member_soft_deletes` until GDPR-erase ships). The Zod schema
constrains each field to `z.number().int().min(0).max(36500)`
(100 years cap to keep the workers' date math sane).

## Service layer

New module `packages/api/src/services/retention/`:

- `policy.ts` — `loadRetentionPolicy(db, zoneId) → Policy` reads
  the column, hydrates defaults, returns a typed object.
  `updateRetentionPolicy(db, { zoneId, actorUserId, policy }) →
  Policy` validates, writes the column, emits a single
  `zone.retention_policy.update` audit row with before/after.
- `sweep.ts` — one exported function per dimension. Each is a
  bounded-batch DELETE / UPDATE keyed on the zone's window. All
  callable in isolation for tests + driven by the central
  pg-boss schedule below.

  Per-dimension sweeps:

  - `sweepAuditEvents(db, zoneId, retainDays)` — `DELETE FROM
    audit_events WHERE zone_id = $1 AND occurred_at < now() -
    interval '$2 days'` in 5000-row chunks. The CHECK constraint
    on `audit_events.zone_id IS NULL ↔ action LIKE 'platform.%'`
    means platform-scope rows are untouched (we never scope
    them to a zone).
  - `sweepImportFiles(db, zoneId, retainDays)` — selects expired
    `import_files` rows still missing a `purged_at`, calls
    `storage().delete(storageKey)` on each (best-effort), and
    flips `purged_at = now()` on the row. The row itself is
    **never hard-deleted** because `import_jobs(import_file_id)`
    is `restrict` — historical jobs would block the DELETE.
    Mirrors the report-job `expired` pattern.
  - `sweepImportRows(db, zoneId, retainDays)` — `DELETE FROM
    import_rows WHERE zone_id = $1 AND created_at < now() -
    interval '$2 days' AND import_job_id NOT IN (SELECT id FROM
    import_jobs WHERE zone_id = $1 AND status IN ('received',
    'parsing', 'parsed', 'matching', 'matched', 'scheduled',
    'committing'))`. Only protects **non-terminal** jobs;
    `failed` and `rolled_back` are terminal, so their rows age
    out (a re-upload would create a fresh job).
  - `sweepReportJobs(db, zoneId, retainDays)` — `DELETE FROM
    report_jobs WHERE zone_id = $1 AND status = 'expired' AND
    completed_at < now() - interval '$2 days'`. Sits on top of
    the existing artefact cleanup (which only flips to
    `expired`); this one removes the row itself after the
    window.

- `cron.ts` — registers a daily pg-boss schedule `zone.retention.sweep`
  at `0 4 * * *` (one hour after the report cleanup). The
  handler:
  1. Loads every non-soft-deleted zone (`zones.deleted_at IS NULL`).
  2. For each zone, loads the policy and calls each sweep
     function with the configured window. A `retainDays === 0`
     dimension is a hard no-op.
  3. Writes a **tenant-scope** `zone.retention.sweep` row PER
     ZONE (skipped on a no-op pass) carrying the per-dimension
     deletion counts, plus a single **platform-scope**
     `platform.retention.sweep.run` row PER PASS carrying the
     cross-tenant summary (always written, even when no zones
     changed).
- `*.test.ts` — vitest integration for each sweep with a
  seeded fixture (e.g. 100 audit rows spanning 10 years,
  `retainDays: 365` → leaves 365 rows give-or-take, deletes the
  rest in chunks). Confirms cross-zone isolation (rows in zone
  B are untouched) and the platform-scope row preservation for
  `audit_events`.

## Route

New endpoint:

`GET /api/tenant/zones/retention-policy` and
`PUT /api/tenant/zones/retention-policy` mounted on the
existing `tenantZonesRouter`.

- Auth: `zone_owner` only (write); `zone_owner` /
  `zone_admin` / `zone_auditor` (read). Settings of this gravity
  shouldn't sit under a finance role.
- Body: the JSON shape above. Zod validates.
- The service layer writes one audit row, emits before/after.

## UI

New panel on `/zone/settings/+page.svelte` (the page doesn't
exist yet — `find packages/web/src/routes -path "*settings*"`
shows only `church/settings` and `zone/giving-settings`; this
task creates `/zone/settings` since it's the natural home for
this and the future zone-export-bundle button).

Layout:

- Title: "Data retention".
- One number-input per dimension, labelled with the
  human-readable name + a one-sentence description (e.g.
  "Audit log — how long to keep entries before they are
  permanently deleted. Default: 5 years (1825 days).").
- "Restore defaults" button that resets every input to the
  schema default. Disabled when state already matches defaults.
- "Save" button. Disabled when the form matches the server
  snapshot.
- Below the form, a small "Last sweep" indicator showing the
  most recent `platform.zone.retention.sweep` audit timestamp
  for this zone (read via a new lightweight
  `GET /api/tenant/zones/retention-policy/last-sweep`
  endpoint or piggybacked on the GET above — TBD by reviewer,
  the latter is simpler).

The page is gated to `zone_owner`; non-owners see the values
read-only with no Save button (reuse the same predicate
extraction pattern as `lib/audit/access.ts`,
`lib/targets/access.ts`).

## Files

New:

- `packages/db/drizzle/0018_zone_retention_policy.sql`
- `packages/db/src/schema/zones.ts` — add column (modified).
- `packages/shared/src/schemas/zones.ts` —
  `zoneRetentionPolicySchema` + `defaultRetentionPolicy` const.
- `packages/api/src/services/retention/policy.ts`
- `packages/api/src/services/retention/policy.test.ts`
- `packages/api/src/services/retention/sweep.ts`
- `packages/api/src/services/retention/sweep.test.ts` — one
  describe block per dimension.
- `packages/api/src/services/retention/cron.ts` — pg-boss
  schedule + handler.
- `packages/api/src/services/retention/cron.test.ts` — proves
  the handler iterates every active zone, respects soft-delete
  on zones (`deleted_at IS NULL`), and writes the
  per-zone summary audit row.
- `packages/api/src/routes/tenant-zones.ts` — new GET / PUT
  endpoints (modified).
- `packages/api/src/routes/tenant-zones.test.ts` — three new
  cases: read default, update, non-owner write 403.
- `packages/web/src/routes/zone/settings/+page.svelte` — new
  page.
- `packages/web/src/routes/zone/settings/+page.server.ts` —
  loader fetching the policy.
- `packages/web/src/lib/retention/access.ts` +
  `access.test.ts` — `canEditRetention(auth) → boolean` mirror
  of the server gate.
- `packages/web/src/lib/nav.ts` — add `/zone/settings` to the
  zonal sidebar's "Administration" group.

Modified:

- `packages/api/src/server.ts` — boot the new
  `zone.retention.sweep` schedule alongside the existing report
  queue startup (single `await startRetentionSweep()` in the
  same boot hook).
- `docs/ROADMAP.md` — flip Phase 9 *"Retention configuration"*
  to done with a one-line summary.
- `docs/DOMAIN-MODEL.md` §11 (audit) — the existing "Retained
  per tenant retention policy" footnote now points to the
  shipped policy column.
- `docs/REPORTS.md` §1 — update the artefact-retention note to
  reference the configurable window.

## Tests

API:

- Per-dimension sweep tests as above.
- `cron.test.ts` — two-zone fixture proves cross-zone
  isolation + that a zero-value dimension is a no-op.
- `tenant-zones.test.ts` — GET / PUT happy + auth.

Shared:

- `zones.test.ts` — Zod schema rejects `retainDays: -1`,
  `retainDays: 'a'`, missing nested fields.

Web:

- `retention/access.test.ts` — same 6-case matrix as
  `audit/access.test.ts`.

## Non-goals (deferred)

- Per-dimension cron override (one daily sweep is sufficient
  for v1).
- A "preview deletions" dry-run mode (the audit row carries the
  count after the fact; that's enough for v1).
- Encrypted off-site archive of purged rows (Phase 11+).
- A platform-default policy table — the schema-default constants
  in `packages/shared` are the canonical defaults until a
  customer has a different policy across all their zones.
- UI for the dimension-by-dimension "last sweep" detail (one
  aggregate timestamp is enough; a per-dimension breakdown can
  ship later if anyone asks).
- Surfacing purged-count metrics on `/admin/zones/[slug]` (the
  audit log is the system of record; add a tile in a follow-up
  if it proves useful).

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A `zone_owner` can read + update the retention policy from
  `/zone/settings`; non-owners see read-only.
- The daily `zone.retention.sweep` schedule fires under
  pg-boss (manual trigger via `boss.send` returns counts that
  match the seeded fixture).
- An audit row lands per zone per sweep with the deletion
  totals.
- The defaults match the table above (5 / 1 / 0.25 / 0.02 /
  ∞ years).
- ROADMAP Phase 9 *"Retention configuration"* deliverable
  ticked.
