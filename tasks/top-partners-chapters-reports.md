# Phase 7 — Top partners & top chapters reports

Implements REPORTS.md §2.8 (`Givings_All_TopPartner`,
`Givings_Partnership_TopPartner`) and §2.9
(`Givings_All_TopChapter`, `Givings_Partnership_TopChapter`)
together because they share aggregation shape — the only thing
that changes is the group key (member vs chapter).

## MVP scope

Two specs, both registered, route-exposed, UI-driven, Excel-exportable.

### Top partners

- **Filters**:
  - `dateFrom`, `dateTo` (required, ISO yyyy-mm-dd, `dateFrom <= dateTo`)
  - `chapterId` (optional uuid)
  - `topN` (optional int, default 20, min 1, max 200)
  - `partnershipOnly` (optional bool, default false) — when true,
    only sums lines whose giving type has
    `has_partnership_target = true` (covers the legacy
    `Givings_Partnership_TopPartner` variant).
- **Rows**: one per member ranked by total giving over the window,
  highest first. Members with zero in the window are omitted.
- **Columns**: rank, member ref, member name, chapter ref + name,
  total contributions, currency.
- **Subtotals**: per-currency grand total of the visible (top-N) rows.
- **Access**: zone-wide readers see all; chapter-scoped readers
  are clamped to their bound chapters; out-of-scope `chapterId`
  → 403.
- **Excel**: branded sheet, `escapeExcelText` on every text cell,
  per-currency money formatting.

### Top chapters

Same shape as top-partners except the group key is the chapter:

- **Rows**: one per chapter ranked by total giving.
- **Columns**: rank, chapter ref, chapter name, total contributions,
  currency.
- **Filters**: same as top-partners minus `chapterId` (filtering by
  a single chapter and then ranking chapters would always return
  one row — pointless). `partnershipOnly` is supported.
- **Access**: zone-wide readers see all; chapter-scoped readers see
  only their bound chapters (so the report only ranks chapters they
  can already see).

## Per-currency ranking

Money is per-currency in v1 (no FX). Each row already carries its
currency; the rank is computed per currency. A zone that uses two
currencies will see two parallel top-N lists. The legacy reports
were single-currency by design; the v1 behaviour is the multi-
currency-safe extension of that.

## Non-goals (deferred)

- PDF (Phase 7-wide).
- Partnership-category breakdown columns on top-partners (legacy
  had per-category sub-totals); v1 keeps the row shape flat and
  defers the breakdown to a later iteration that lands alongside
  the partnership-progress report (§2.10).
- Saved filters.

## Files

- `packages/api/src/services/reports/top-partners.ts` — new spec
- `packages/api/src/services/reports/top-chapters.ts` — new spec
- `packages/api/src/services/reports/registry.ts` — register both
- `packages/api/src/services/reports/reports.test.ts` — coverage for both
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  SHAPES entries for both; new `topN` integer input + a
  `partnershipOnly` checkbox.
- `packages/api/src/routes/tenant-reports.test.ts` — registry list
  assertion (now 10 reports).
- `docs/ROADMAP.md` — flip the bullet; bump audited status.

## Tests (vitest)

### `describe("top-partners report")`

1. Ranks members by total giving over the window, highest first;
   `total` ties per currency.
2. Honours `topN` — N=2 returns the top 2 even when 3+ members
   gave.
3. `partnershipOnly` restricts to giving types with
   `has_partnership_target=true` (the seed includes one such type,
   `PARTNER`).
4. Chapter-scoped caller clamped to bound chapters; out-of-scope
   `chapterId` → `accessCheck === "forbidden"`.
5. Excel renders + formula-injection escape on dynamic member
   names (poisoned via `firstName`).

### `describe("top-chapters report")`

1. Ranks chapters by total giving over the window, highest first.
2. Honours `topN`.
3. Chapter-scoped caller sees only their bound chapters (no
   `chapterId` filter; the report is zone-wide by intent but
   clamped by the caller's bindings).
4. Excel renders + branded header sanity check.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- `/zone/reports` lists "Top partners" and "Top chapters".
- Roadmap audited-status block updated.
