# Phase 8 — Financial targets (foundation PR)

First of three PRs that close Phase 8:

- **This PR (foundation)**: `financial_targets` schema + CRUD
  endpoints + tests. No reports yet, no UI page yet — just the
  data store and API contract.
- **Follow-up PR**: `partnership-progress` report (REPORTS.md
  §2.10) consuming targets + posted contributions.
- **Follow-up PR**: `paying_in_books` schema + reference-code
  range validation at contribution-entry time (the second exit
  checklist item).

## Schema (per DOMAIN-MODEL.md §8)

```sql
financial_targets
  id text pk
  zone_id text not null references zones on delete cascade
  chapter_id text null references chapters (zone_id, id)
                                       -- null = zone-wide target
  giving_type_id text not null references giving_types (zone_id, id)
  ministry_year_id text not null references ministry_years (zone_id, id)
  full_target numeric(19,4) not null
  monthly_target numeric(19,4) null
  weekly_breakdown numeric(19,4) null
  full_target_copies int null
  number_of_partners int null
  currency_code text not null
  created_at, updated_at timestamptz

  -- A given (zone, chapter, giving_type, ministry_year) tuple can
  -- only hold one target row. Zone-wide targets (chapter_id null)
  -- use a partial unique index because PG treats NULL distinctly
  -- in a normal unique constraint.
  unique partial idx: (zone_id, giving_type_id, ministry_year_id)
                      where chapter_id is null
  unique idx:         (zone_id, chapter_id, giving_type_id,
                       ministry_year_id) where chapter_id not null

  check full_target >= 0 and (monthly_target is null or
        monthly_target >= 0) and ...

  index (zone_id, ministry_year_id, giving_type_id)
```

Soft-delete: not added — targets are zone-policy data; if a
treasurer wants to retract a target they update or delete the row
outright. Audit covers history.

## API

`/api/tenant/targets` mounted on tenantRouter:

- `GET /api/tenant/targets` — list with optional filters
  `chapterId`, `givingTypeId`, `ministryYearId`. Zone readers see
  every target; chapter readers see only their bound chapters'
  rows plus zone-wide (`chapter_id is null`) rows.
- `POST /api/tenant/targets` — create. Validates the
  `(zone, chapter?, giving_type, ministry_year)` tuple is unique
  (the partial unique indexes enforce it server-side); confirms
  `giving_type.has_partnership_target = true` is **not** required
  (general financial targets aren't partnership-only); confirms
  the ministry year belongs to the zone and the chapter (if
  supplied) too.
- `PATCH /api/tenant/targets/:id` — partial update of the money
  fields + `number_of_partners` + `full_target_copies`. The tuple
  columns are immutable post-create (a different (chapter, type,
  year) is a different target).
- `DELETE /api/tenant/targets/:id` — hard delete with audit
  (targets aren't soft-deletable; the audit log keeps history).

Access:

- READ: any zone reader + any chapter reader (clamped to bound
  chapters + zone-wide rows).
- WRITE: zone finance admin / zone admin / zone owner + chapter
  admin (chapter-scoped writes only). Chapter treasurers can't
  set targets — that's a finance-admin call.

## Files

- `packages/db/src/schema/targets.ts` — new schema module + types.
- `packages/db/src/schema/index.ts` — export.
- `packages/db/drizzle/0004_*.sql` — generated migration.
- `packages/shared/src/schemas.ts` — Zod schemas for create /
  update / list filter.
- `packages/api/src/routes/tenant-targets.ts` — router.
- `packages/api/src/routes/tenant.ts` — mount it.
- `packages/api/src/routes/tenant-targets.test.ts` — coverage.
- `docs/ROADMAP.md` — bump Phase 8 status block.
- `docs/DOMAIN-MODEL.md` — note that the schema is implemented
  (4dp money, the partial unique pattern).

## Non-goals (deferred)

- **Partnership-progress report** — separate PR, consumes this.
- **Paying-in books** — separate PR (last in the trio).
- **UI** — the API contract is enough for the partnership report
  to plug into; the target-entry UI ships alongside the
  partnership dashboard.

## Tests (vitest)

### `describe("tenant targets routes")`

1. **POST** creates a chapter-scoped target.
2. **POST** creates a zone-wide target (`chapterId: null`).
3. **POST** rejects a duplicate
   `(zone, chapter, giving_type, ministry_year)` tuple with 409.
4. **POST** rejects when giving_type is in another zone (404).
5. **POST** rejects when ministry_year is in another zone (404).
6. **POST** rejects negative money values via the Zod schema
   (400).
7. **GET** lists targets for the caller; chapter treasurer sees
   only their chapter + zone-wide.
8. **PATCH** updates money fields; tuple columns rejected.
9. **DELETE** removes the row + writes an audit event.
10. **Cross-tenant** zone A's target endpoints are inaccessible
    from zone B.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- Migration applies cleanly via `pnpm test:db:push`.
- API contract documented in the route module header.
