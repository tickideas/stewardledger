# Phase 7 — Giving by chapter (PIVOT) report

Implements REPORTS.md §2.7 (`Givings_All_BreakdownByChapter_PIVOTByCategory`,
`Givings_All_BreakdownByChapter_PIVOTByPeriod` legacy mapping).

## MVP scope

One report spec, registered, route-exposed, UI-driven, Excel-exportable.

- **Filters**:
  - `dateFrom`, `dateTo` (required, ISO yyyy-mm-dd, `dateFrom <= dateTo`)
  - `pivotBy` (enum: `category` | `givingType` | `month`) — required, no default; the legacy app shipped both `_PIVOTByCategory` and `_PIVOTByPeriod`, so we expose the choice.
  - `ministryYearId` (optional uuid) — when set, clamps to the selected ministry-year window.
  - `partnershipYearId` (optional uuid) — same idea.
  - `chapterId` (optional uuid) — single-chapter view.
- **Rows**: one per chapter × currency (single-currency report stays single-row per chapter; multi-currency zones still tie out by currency).
- **Columns**: base = chapter ref / chapter name / currency / total. Pivot columns are dynamic: one per active+inactive category/givingType/month present in the dataset (sorted by ordinal/name or chronologically for months).
- **Subtotals**: per-currency grand totals across chapters.
- **Access**: zone-wide reader = full dataset; chapter-scoped reader = clamped to bound chapters; an out-of-scope `chapterId` filter → 403. Mirrors `member-finance-summary.ts`.
- **Excel**: branded sheet, dynamic header row, money columns formatted by currency; reuse `addBrandedSheet` + `escapeExcelText` + `moneyFormatForCurrency`.

## Non-goals (deferred)

- PDF export (waits for Playwright/Chromium infra per ARCHITECTURE.md §2).
- Saved filters.
- Background generation.
- Charts in Excel.
- Cross-currency conversion (no FX in v1; per-currency rows).

## Data shape

Aggregate `contribution_lines` joined to `contributions` filtered by:
- `zone_id`
- `contribution_date in [dateFrom, dateTo]`
- `status in ('posted', 'reversed')` (reversal lines carry negative amounts so net ties)
- optional ministry-year / partnership-year window via `givingPeriods.ministryPeriodId → ministryPeriods.ministryYearId` (resp. partnership)
- optional `chapterId`
- chapter scope clamp for chapter-bound callers

For pivot dimension:
- `category`: `givingTypes.categoryId → givingCategories.id` (label = `shortCode - name` or `name`)
- `givingType`: `contributionLines.givingTypeId → givingTypes.id` (label = `shortCode - name` w/ `(inactive)` suffix; same convention as `member-finance-summary`)
- `month`: bucket by `EXTRACT(YEAR FROM contribution_date)` + `EXTRACT(MONTH FROM contribution_date)` → label `YYYY-MM`

Group rows by `(chapterId, currencyCode)`; pivot key by dimension. In-memory aggregation with `Decimal` (matches `member-finance-summary.ts` pattern).

## Files

- `packages/api/src/services/reports/giving-by-chapter.ts` — new spec
- `packages/api/src/services/reports/registry.ts` — register
- `packages/api/src/services/reports/reports.test.ts` — coverage
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` — add `pivotBy` + (already supports `chapterId`/`dateFrom`/`dateTo`) to SHAPES map; surface `pivotBy` select + optional ministryYearId/partnershipYearId text inputs (or just `pivotBy` for v1 — keep optional ones text-only).
- `docs/ROADMAP.md` — flip the bullet from "queued" / "next unimplemented" to done; bump audited status block.
- `docs/REPORTS.md` — no edits needed; spec already documented.

## Tests (vitest)

In `reports.test.ts`, new `describe("giving-by-chapter report")`:

1. `pivots by giving type and ties out per-currency totals`: seed 3 chapters × 2 giving types × posted contributions; assert one row per chapter, dynamic columns include both giving types, `total` matches sum, `subtotals` ties.
2. `pivots by category`: same dataset, different `pivotBy=category`; assert category-level columns aggregate the two giving types when they share a parent category (TITHE + OFFERING share defaults under different categories — verify via the seeded `givingCategories`).
3. `pivots by month`: two contributions in different months; assert two month columns emerge with chronological ordering.
4. `chapter-scoped caller sees only bound chapter rows`; out-of-scope `chapterId` filter → `accessCheck === "forbidden"`.
5. `reversal nets to zero` within the date range.
6. `excel renders the branded header and dynamic columns`.
7. `escapes formula-injection in dynamic chapter / category labels`.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- New tests pass.
- `/zone/reports` lists the new report; `/zone/reports/giving-by-chapter` renders the filter form, runs, and downloads a valid xlsx.
- Roadmap + audited-status block updated.

## Open questions

- None blocking. Ministry-year / partnership-year filters are optional in MVP; if the UI surfaces them as free-text uuid inputs (matching `importJobId`), that's consistent with the rest of the v1 reports page until typeaheads land.
