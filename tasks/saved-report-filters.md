# Phase 7 — Saved report filters

Per ROADMAP Phase 7 *Saved filters* (queued). Lets a user persist
a named bundle of filter values for any registered report and
re-run it later without re-keying. Treasurers running the same
"this week's giving" or "monthly partnership progress" almost
always re-key the same set of inputs every time.

## MVP scope

One table, one CRUD service, two routes, a small picker on
`/zone/reports/[id]`. No cross-user sharing in v1 — saved
filters are personal (`(user_id, zone_id, report_id, name)`
unique). A future iteration can add a "shared with zone" flag.

### Schema

New table `saved_report_filters`:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | uuid default |
| `zone_id` | text NOT NULL FK -> zones.id | tenant boundary |
| `user_id` | text NOT NULL FK -> user.id | owner; cascade on user delete |
| `report_id` | text NOT NULL | matches `ReportSpec.id` (free-text; the registry is the source of truth — a stale row from a removed report is a no-op) |
| `name` | text NOT NULL | user-chosen label, max 80 chars |
| `filters` | jsonb NOT NULL default `'{}'` | the parsed filter object the report's Zod schema accepts |
| `created_at` | timestamptz NOT NULL default now() | |
| `updated_at` | timestamptz NOT NULL default now() | |

Indexes:
- `unique (user_id, zone_id, report_id, lower(name))` so a user
  can't have two "monthly close" entries on the same report.
- `index (zone_id, user_id, report_id)` for the list endpoint.

### API

Mounted under the existing `/api/tenant/reports` router so the
permission gating stays uniform.

- `GET    /api/tenant/reports/:id/saved-filters` —
  list current user's saved filters for this report.
- `POST   /api/tenant/reports/:id/saved-filters` —
  body `{ name, filters }`. Validates `filters` against the
  report's Zod schema (re-uses `parseReportFilters`). 409 on
  duplicate name. Returns the inserted row.
- `PATCH  /api/tenant/reports/:id/saved-filters/:filterId` —
  body `{ name?, filters? }`. Same validation rules; rename
  hits the unique constraint just like create.
- `DELETE /api/tenant/reports/:id/saved-filters/:filterId` —
  hard delete. Audit row written.

Access:
- Read + write: any caller who can READ the report (i.e. the
  existing `canReadReports` gate). A user can only read / mutate
  their own rows; we don't expose bindings owned by other
  users. No spec-level `accessCheck` runs on saved filters
  themselves — they're metadata, not report rows. The user is
  free to save filters that, when *executed*, would 403 (e.g.
  a treasurer saving a member-statement filter for a member
  outside their chapters); the execution-time check still
  fires.

Audit: `saved_report_filter.create / .update / .delete`,
entity_type `saved_report_filter`, entity_id the row id, after
payload includes the report id + filter shape.

### UI

Small additions to `/zone/reports/[id]/+page.svelte`:

- Above the filter form, a row showing the user's saved filters
  for this report as pill buttons. Clicking one populates the
  form fields. An "×" on each pill deletes it (with confirm).
- Below the run button, "Save current filters as…" opens a
  small inline name input + Save button. Submitting POSTs
  `/api/tenant/reports/:id/saved-filters` with the
  `currentParams()` payload. Error states surface inline.
- A "Saved" badge appears next to the report header when the
  current form values exactly match an existing saved-filter
  payload (cheap deep-equal check).

The page is already plumbing `currentParams()` for run + export,
so the persistence path piggybacks on the same builder. We
serialise to JSON via the URLSearchParams entries so the saved
shape matches what the report's Zod schema validates on read.

### Tests

- DB: migration roundtrip via the existing test DB.
- API: 8 tests in `tenant-reports-saved-filters.test.ts`
  covering create / list / update / delete / cross-user
  isolation / cross-tenant fuzz / duplicate-name 409 / invalid
  filters 400 (uses an invalid `dateFrom > dateTo` member-
  statement payload).
- Web: no new tests; the page changes are dispatch + form work
  that the existing `member-selection.test.ts`-style approach
  doesn't cover well. Inline `currentParams()` re-use means
  there's nothing genuinely new to unit-test.

### Non-goals (deferred)

- Sharing across users / zones (v1 is personal).
- Default filter applied automatically on report open.
- Schedule a saved filter to email-as-attachment (Phase 7
  background-worker territory).
- Bulk import / export of saved filters.
- A separate /zone/reports/saved-filters management page; the
  per-report inline UI is enough for v1.

## Files

New:
- `packages/db/src/schema/saved-report-filters.ts`
- `packages/db/drizzle/0009_*.sql`
- `packages/api/src/services/reports/saved-filters.ts`
- `packages/api/src/routes/tenant-reports-saved-filters.test.ts`

Modified:
- `packages/db/src/schema/index.ts` — barrel export.
- `packages/api/src/routes/tenant-reports.ts` — mount the
  saved-filters sub-router (4 routes).
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  picker + save / delete UI.
- `docs/ROADMAP.md` — flip Phase 7 *Saved filters* to landed.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A treasurer can save a named filter set for any report,
  re-apply it with one click, rename it, and delete it.
- Cross-user / cross-tenant isolation enforced at the API
  layer (tested).
- Roadmap Phase 7 *Saved filters* `[x]`.
