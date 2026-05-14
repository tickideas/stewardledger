# Phase 7 — Envelope ledger report

Implements REPORTS.md §2.4 (`Report_ChurchEnvelope_Ledger`,
`ChurchEnvelope_MemberFinanceReportView` legacy mapping). One row
per envelope (= one row per `contributions` with
`source_type='envelope'`) with the line breakdown rendered inline.

## MVP scope

- **Filters**:
  - `dateFrom`, `dateTo` (required, ISO yyyy-mm-dd, `dateFrom <= dateTo`)
  - `chapterId` (optional uuid)
  - `memberId` (optional uuid)
- **Hard preset**: `source_type='envelope'`.
- **Rows**: one per posted envelope contribution.
- **Columns**: envelope id (`contributions.reference_code` →
  fallback batch ref), date, service event (date + service-type
  name), member ref, member name, chapter ref, chapter name,
  payment method, lines (built-server-side as
  `"SHORTCODE 100.0000, SHORTCODE2 25.0000"`), currency, total,
  status.
- **Subtotals**: per-currency grand total across envelopes.
- **Access**: zone readers see all; chapter readers see their
  bound chapters; out-of-scope `chapterId` → 403; out-of-scope
  `memberId` (member sits in a chapter the caller doesn't own)
  → 403, same existence-oracle fold as `member-statement.ts`.
- **Excel**: branded sheet, escapeExcelText on every string,
  per-currency money formatting on total.

## Non-goals (deferred)

- PDF (Phase 7-wide).
- Per-line breakdown as separate rows — the "lines (giving type +
  amount)" inline summary keeps the row-per-envelope semantics
  the legacy report had; v1 ships inline.
- Group-by-month subtotal rows in Excel (queued; the row sort
  already groups visually).
- Saved filters / background generation.

## Files

- `packages/api/src/services/reports/envelope-ledger.ts` — new spec
- `packages/api/src/services/reports/registry.ts` — register
- `packages/api/src/services/reports/reports.test.ts` — coverage
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  add `envelope-ledger` to SHAPES (chapterId / memberId / date range
  inputs already exist).
- `packages/api/src/routes/tenant-reports.test.ts` — registry list
  assertion (now 7 reports).
- `docs/ROADMAP.md` — flip the queued bullet; bump audited status.

## Tests (vitest)

In `reports.test.ts`, new `describe("envelope-ledger report")`:

1. `lists envelope contributions and rolls up lines to a per-envelope total` — seed 2 envelope contributions, post via an envelope-source batch, run report. Assert row count = 2, line summary contains both giving-type short codes, totals tie.
2. `excludes non-envelope sources` — also create a `manual` contribution; assert it's absent from the result.
3. `filters by chapter and by member` — assert each filter narrows the result correctly.
4. `chapter-scoped caller is clamped to bound chapters`; out-of-scope `chapterId` → `accessCheck === "forbidden"`.
5. `out-of-scope memberId folds into 403 (existence-oracle guard)` — chapter-scoped caller probes a random uuid; should get `ReportError("forbidden")` from `fetch`, not an empty 200, mirroring `member-statement.ts`'s pattern.
6. `excel renders the branded header and escapes formula-injection in member names`.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- New tests pass.
- `/zone/reports` lists "Envelope ledger" with `envelope-ledger` id.
- Roadmap audited-status block updated.
