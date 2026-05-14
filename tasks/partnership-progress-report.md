# Phase 8 — Partnership progress report (REPORTS.md §2.10)

Last unimplemented v1 report. Closes Phase 7's report inventory
once this lands. Consumes the `financial_targets` table shipped
in PR #30.

## Scope

One `partnership-progress` report registered alongside the
existing 13. Standard `ReportSpec` shape — Excel + PDF render
automatically via the established renderers.

### Filters

```
dateFrom?            ISO yyyy-mm-dd (default: ministry year start)
dateTo?              ISO yyyy-mm-dd (default: ministry year end, clamped to today for "achieved")
ministryYearId       required UUID (a target is per ministry year)
chapterId?           optional UUID (clamped to bound chapters for chapter readers)
givingTypeId?        optional UUID; otherwise every partnership giving type in scope
```

Targets considered: rows in `financial_targets` joined with
`giving_types` where `has_partnership_target = true`. Both
chapter-scoped (`chapter_id IS NOT NULL`) and zone-wide
(`chapter_id IS NULL`) targets are surfaced.

### Rows

One row per (target row, currency) — because a single target
ships in one currency, that's effectively one row per target.
Columns:

- chapter ref + name (or "All chapters" for zone-wide targets)
- giving type code + name
- ministry year label
- currency code
- target (full_target)
- monthly target (or null)
- weekly breakdown (or null)
- achieved (sum of posted+reversed lines in the ministry-year
  window, filtered to the target's chapter + giving type)
- percent progress (achieved / target × 100, clamped at 999.9
  for display)
- weekly average actual (achieved / weeks elapsed)
- monthly average actual (achieved / months elapsed)
- projected end-of-year (weekly average × total weeks in year)
- target copies / number of partners (passthrough)

### Aggregation rules

- Sum `contribution_lines.amount` for posted-and-reversed
  contributions where `contribution_date BETWEEN ministry_year`.
- For chapter-scoped targets: clamp to that chapter.
- For zone-wide targets: sum across the whole zone (chapter
  filter does not apply).
- The match-currency-code constraint matters here: a 1000 GBP
  target only sums GBP lines; USD lines on the same giving type
  are excluded.

### Access

- READ: any zone reader; chapter readers clamped to their
  bound chapters + zone-wide targets.
- EXPORT: existing route export gate (finance tier + chapter
  treasurer for chapter-bound).

## Files

- `packages/api/src/services/reports/partnership-progress.ts` —
  new spec.
- `packages/api/src/services/reports/registry.ts` — register.
- `packages/api/src/services/reports/reports.test.ts` — coverage.
- `packages/api/src/routes/tenant-reports.test.ts` — bump registry
  list assertion to 13 entries.
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  SHAPES entry (`dateFrom`/`dateTo`/`chapterId`/`givingTypeId`/
  `ministryYearId`).
- `docs/REPORTS.md` §2.10 → Done.
- `docs/ROADMAP.md` — bump Phase 7 + Phase 8 status blocks.

## Tests (vitest)

### `describe("partnership-progress report")`

1. **Happy path**: seed a chapter target on TITHE (partnership-
   tagged) + a partnership giving type (`PARTNER`, already
   seeded with `has_partnership_target=true`); post a couple of
   contributions; the report row carries the right target /
   achieved / percent.
2. **Filters out non-partnership giving types**: a target on
   OFFERING (which has `has_partnership_target=false`) should
   NOT appear in the report.
3. **Zone-wide target**: a `chapter_id IS NULL` target sums
   across all chapters; chapter-scoped target sums only that
   chapter.
4. **Reversal nets to zero**: a posted-then-reversed
   contribution contributes zero to `achieved`.
5. **Chapter-scoped reader**: clamped to bound chapters; an
   out-of-scope `chapterId` filter → `forbidden`. Zone-wide
   targets remain visible.
6. **Excel + PDF render**: both export buffers produced.
7. **Formula-injection escape on giving type name** (PDF/Excel
   both via the shared `escapeExcelText` path).

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- `/zone/reports` lists "Partnership progress".
- REPORTS.md §2.10 + ROADMAP.md Phase 8 audited status updated.
- v1 report inventory now 14/14 complete.

## Non-goals (deferred)

- **Member-level partnership breakdown** (the legacy
  `MemberPartnershipBreakdownByMonth_PIVOT` view) — separate
  pivot report, out of scope for this PR.
- **Paying-in books / reference-code validation** — separate
  Phase 8 PR.
- **UI: target setup screen + partnership-progress dashboard**
  — a follow-up; the API contract is sufficient for the report
  to land.
