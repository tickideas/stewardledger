# Phase 9 — Audit-search UI

Per ROADMAP.md Phase 9 deliverable #1 — "Per-zone audit search."
The `audit_events` schema is mature, the `audit-log` report is
already in the registry (admin-only read, Excel + PDF export), but
there is no interactive search surface. Phase 8 left three CRUD
dashboards live; the next high-value follow-on is the bespoke
audit search.

## MVP scope

One zonal page at `/zone/audit` (sidebar entry under "Insight"),
backed by the **existing** `/api/tenant/reports/audit-log/data`
endpoint. No new API routes — the spec already supports every
filter we need, the access gate is already admin-only, and the
endpoint already includes the `actorEmail` join we want to show.

Re-using the report endpoint avoids drift between the search
surface and the audit-log Excel/PDF export. Same data, two
presentations.

### Filters (form on the page)

- `dateFrom`, `dateTo` (required; defaults to the past 7 days).
- `actorUserId` (optional; free-text — `user.id` is a Better Auth
  string, not a uuid. A typeahead is a follow-up.)
- `action` (optional free-text).
- `entityType` (optional free-text).
- `entityId` (optional free-text).

A "Reset" button restores the 7-day window and clears every other
input. A "Search" button (also auto-runs on first load) fires the
request.

### Result table

One row per event. Columns rendered:

- **When** — local time, formatted via `Intl.DateTimeFormat`
  (the endpoint ships ISO strings; we render in the browser's
  timezone, with a `title=` tooltip of the original ISO string
  for auditors who need UTC).
- **Actor** — `actorEmail` if joined, otherwise the raw
  `actorUserId` (and `actorRoleCode` shown as a subtle eyebrow).
- **Action** — e.g. `chapter.banking.update`.
- **Entity** — `entityType` plus a truncated `entityId`.
- **Reason** — if set.

An expandable detail row shows the `before` / `after` JSON in
`<pre class="sl-mono">` blocks side by side, with a small "Copy
JSON" affordance per blob. Truncation marker is preserved
(`…(truncated)`) so the operator knows when a payload was clipped
by the export pipeline — though for the on-screen view we render
the **untruncated** value from the API (the export's
`EXCEL_CELL_CHAR_LIMIT` is only for the spreadsheet cell).

Wait — the data endpoint stringifies via the spec's `fetch()`
helper, which **does** apply `EXCEL_CELL_CHAR_LIMIT` to every
row. That's fine for v1; we surface the truncation marker
explicitly. A future iteration can add a `?raw=true` variant or
a per-event detail endpoint.

### Pagination

Same `limit + 1` probe pattern as `/zone/paying-in-books` (set
`PAGE_SIZE = 50`, request 51 rows via a `limit` filter…).

BUT — the audit-log report doesn't currently accept a `limit` /
`offset` filter; the date window is the throttle. For v1 we
keep the client-side filter (date window is the user's control)
and render every row returned, capped via a hard
`MAX_RESULTS = 1_000` defensive client-side slice. A header
banner shows "showing first 1,000 of N events; narrow the date
range to see more" when we hit the cap.

A proper server-side paginator (limit + offset against
`audit_events.id` as a stable tie-breaker) is a follow-up if
1,000-event windows turn out to be common.

### Access

The same admin-only gate the report enforces (`hasZoneAdminRole`
in `services/reports/access.ts`). On the UI:

- Extract a write predicate at `packages/web/src/lib/audit/
  access.ts` (`canSearchAudit(auth) → boolean`) — mirrors the
  server gate verbatim, with the same role list. Unit-tested.
- The `/zone/audit` page calls `canSearchAudit(auth)` after
  resolving `/api/tenant/me`. On `false`, renders a 403-shaped
  "Audit search requires zone admin / finance admin / owner."
  card instead of issuing a request that would 403 anyway.

### Race + freshness pattern

Same `refreshToken` increment-and-check used in
`paying-in-books/+page.svelte`. A user mashing "Search" or
fiddling with the form cannot have a stale fetch clobber a
fresh result.

### Nav

Add `{ href: "/zone/audit", label: "Audit search" }` to the
"Insight" group in `ZONAL_NAV`, placed between "Dashboard" and
"Partnership progress."

## Non-goals (deferred)

- Actor typeahead (paste / autocomplete the raw `user.id` for
  v1).
- Server-side pagination (date window throttles; 1,000-row
  client cap as the safety net).
- Saved searches (Phase 7's saved-filters lane).
- Per-event detail page (the inline JSON expansion is the v1
  surface).
- A "subscribe to alerts when X happens" feature (out of scope).
- Reading from a denormalised search index. The base table is
  fine for v1; revisit if `audit_events` for a single zone
  pushes past O(100k) rows over a week.

## Files

New:

- `packages/web/src/lib/audit/access.ts` — predicate + tests.
- `packages/web/src/lib/audit/access.test.ts` — 6 cases
  covering admin / finance / owner pass; auditor / pastor /
  chapter-roles / unauthenticated deny.
- `packages/web/src/routes/zone/audit/+page.svelte` — the
  search surface.

Modified:

- `packages/web/src/lib/nav.ts` — add the Insight entry.
- `docs/ROADMAP.md` — flip Phase 9 §1 "Per-zone audit search"
  to delivered.
- `docs/REPORTS.md` — cross-reference the search surface from
  §2.13 if appropriate.

## Tests

`audit/access.test.ts` — vitest unit:

1. `zone_owner` → `true`.
2. `zone_admin` → `true`.
3. `zone_finance_admin` → `true`.
4. `zone_auditor` → `false` (intentional — see REPORTS.md
   §2.13 / the audit-log spec's `accessCheck`).
5. `chapter_admin` → `false`.
6. `null` (unauthenticated) / empty roles → `false`.

No new API tests — the data endpoint is already covered by
`reports.test.ts` + `tenant-reports.test.ts`.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- `/zone/audit` is reachable from the sidebar.
- A `zone_owner` can search, narrow by action / entity type /
  date, and expand a row to read its before/after JSON.
- A `zone_auditor` lands on the 403 card.
- The form survives a stale fetch (race-guarded).
- Roadmap Phase 9 §1 ticked.
