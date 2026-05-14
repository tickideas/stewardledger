# Phase 7 — Weekly finance report (REPORTS.md §2.3)

Closes the last v1 report blocked by a schema gap. Adds a sibling
`service_event_attendance` table for the headcount fields the
legacy `ChurchEnvelope_WeeklyFinanceReport_PIVOT` keys off, then
ships a `weekly-finance` Excel report following the now-established
pattern.

## Why a sibling table, not new columns on `service_events`

- Attendance is per-occurrence and likely to grow more columns
  (legacy reports key off it; future ministries may add columns
  like ushers / first-time-visitors / baptisms).
- Optional by design: a chapter that doesn't record attendance
  yet still has perfectly valid service events.
- A 1:1 sibling keeps `service_events` lean (the primary join key
  in giving / batches / contributions); attendance lives next to
  it and joins only when the report needs it.
- Soft-delete / replace semantics: rewriting attendance is a
  single-row upsert rather than a 6-column UPDATE on the parent.

## MVP scope

### Schema

`packages/db/src/schema/giving.ts` gets a new `serviceEventAttendance`
table:

```
service_event_attendance (
  id text primary key,
  zone_id text not null references zones(id) on delete cascade,
  service_event_id text not null,
  men integer not null default 0,
  women integer not null default 0,
  teens integer not null default 0,
  children integer not null default 0,
  first_timers integer not null default 0,
  new_converts integer not null default 0,
  notes text,
  recorded_by_user_id text references user(id) on delete set null,
  created_at, updated_at timestamps,

  unique (zone_id, service_event_id),  -- 1:1
  foreign key (zone_id, service_event_id) references service_events
    on delete cascade,
  check (men >= 0 and women >= 0 and ...),  -- non-negative counts
)
```

Index on `(zone_id, service_event_id)`. Soft-delete: not needed —
attendance is rewritable and the parent `service_events` doesn't
soft-delete either; a void/correction is a row update.

Migration generated via `drizzle-kit generate`.

### API

`PUT /api/tenant/giving/service-events/:id/attendance` — upsert.
Body is the count fields + optional notes. Idempotent.

`GET /api/tenant/giving/service-events/:id/attendance` — read
back the recorded attendance (or 404 if not yet entered).

Access: same role gating as service-event write
(`hasZoneEventWrite || hasChapterEventWrite`) for `PUT`, same
read gating for `GET`. Audited on each write.

No UI in this PR — the existing service-event UI is itself a
Phase 4 deferral. A follow-up PR adds the attendance inputs.

### Report

`weekly-finance` registered in the report registry.

- **Filters**:
  - `dateFrom`, `dateTo` (required, ISO yyyy-mm-dd, `dateFrom <= dateTo`)
  - `chapterId` (optional uuid; chapter readers clamped to bindings)
- **Rows**: one per `service_event` in the window. Joins
  `service_event_attendance` (left join — attendance is optional),
  rolls up `contribution_batches.cash_total / cheque_total` and
  `sum(contribution_lines.amount)` for posted+reversed contributions
  attached to the event.
- **Columns**: service date, week-in-month, service type, chapter
  ref + name, men, women, teens, children, first-timers,
  new-converts, total attendance, cash, cheque, line total, currency.
- **Order**: chapter ref asc, service date asc, service type asc.
- **Per-currency**: rows are per (event, currency); subtotals
  grouped by currency.
- **Export**: Excel; PDF deferred Phase-7-wide.

### "Week-in-month"

Computed in app code from the service date:
`Math.ceil(dayOfMonth / 7)` — gives 1..5. Matches the legacy
report's grouping. We don't expose it as a filter; it's a
display column for the treasurer scanning the sheet.

## Non-goals (deferred)

- **Service-event UI** — service-event detail page doesn't exist
  yet (Phase 4 backlog); attendance entry will follow.
- **PDF** — Phase 7-wide deferral.
- **Saved filters**.
- **Attendance trends** — Phase 7+ if anyone asks.

## Files

- `packages/db/src/schema/giving.ts` — new
  `serviceEventAttendance` table + types.
- `packages/db/drizzle/0002_*.sql` — generated migration.
- `packages/shared/src/schemas.ts` —
  `serviceEventAttendanceUpsertSchema` + inferred type.
- `packages/api/src/routes/tenant-giving-events.ts` —
  add `GET / PUT /service-events/:id/attendance`.
- `packages/api/src/routes/tenant-giving.test.ts` —
  cover the attendance endpoints (read, upsert, replace,
  cross-tenant denial, chapter-scope denial).
- `packages/api/src/services/reports/weekly-finance.ts` — new
  report spec.
- `packages/api/src/services/reports/registry.ts` — register.
- `packages/api/src/services/reports/reports.test.ts` — cover the
  weekly-finance report (happy path, attendance-missing fallback,
  chapter clamp, formula-injection escape on service-type name).
- `packages/api/src/routes/tenant-reports.test.ts` — bump the
  registry-list assertion to 12 entries including
  `weekly-finance`.
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  SHAPES entry: `dateFrom`, `dateTo`, `chapterId`.
- `docs/REPORTS.md` §2.3 — flip status to Done.
- `docs/ROADMAP.md` — bump audited-status block.

## Tests (vitest)

### `describe("service_event_attendance routes")`

1. PUT creates a row.
2. PUT idempotent — second PUT updates in place.
3. GET returns the row; 404 if not recorded.
4. Cross-tenant: zone A treasurer cannot PUT to zone B's event.
5. Out-of-scope chapter: a treasurer bound to chapter B cannot
   PUT attendance for a service event in chapter A.

### `describe("weekly-finance report")`

1. **Happy path**: seed a chapter with two service events,
   attendance + a batch + posted contributions on each; the
   payload has two rows with correct headcount + cash + cheque +
   line totals; per-currency subtotal ties out.
2. **Missing attendance**: a service event with no
   `service_event_attendance` row yields a row with zero counts
   (left join semantics).
3. **Chapter clamp**: a chapter-bound treasurer reading the
   report sees only their chapter's events.
4. **Formula-injection escape** on service-type name.
5. **Reversal nets to zero**: a posted-then-reversed contribution
   on a service event contributes zero to the line total.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- `/zone/reports` lists "Weekly finance".
- REPORTS.md §2.3 + ROADMAP audited-status block updated.
- Migration applies cleanly on test DB; `db:push` reconciles.
