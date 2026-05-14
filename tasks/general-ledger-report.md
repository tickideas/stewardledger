# Phase 7 — General ledger (giving) report

Implements REPORTS.md §2.6 (`Report_Givings_All_GeneralLedger` legacy
mapping). Flat line-level ledger for all posted contributions — the
foundation that envelope ledger (§2.4) and online ledger (§2.5)
become simple preset filters of in follow-up PRs.

## MVP scope

A spec, registered, route-exposed, UI-driven, Excel-exportable.

- **Filters**:
  - `dateFrom`, `dateTo` (required, ISO yyyy-mm-dd, `dateFrom <= dateTo`)
  - `chapterId` (optional uuid)
  - `accountId` (optional uuid)
  - `givingTypeId` (optional uuid)
  - `paymentMethodId` (optional uuid)
  - `sourceType` (optional enum, matches `contributions.source_type`)
- **Rows**: one per `contribution_line` in scope.
- **Columns**: date, chapter ref + name, member ref + name, giving type,
  account, payment method, source, currency, amount, status, reversal-of?
- **Subtotals**: per-currency grand totals. The legacy "group by
  account / giving type per currency" intent is preserved by sorting
  rows by `(accountName, givingTypeName, contributionDate)` so the
  Excel sheet reads as grouped without needing pivot machinery.
- **Access**: zone-wide readers see everything; chapter-scoped readers
  see only contributions in their bound chapters; out-of-scope
  `chapterId` filter → 403. Standard pattern.
- **Excel**: branded sheet, `escapeExcelText` on every string column,
  per-currency money formatting.

## Non-goals (deferred)

- Per-account / per-giving-type subtotal rows on the Excel (legacy
  did this; nice-to-have but the ordered rows + per-currency grand
  total satisfy §2.6's acceptance for v1).
- PDF export (Phase 7-wide deferral; awaits Playwright/Chromium).
- Saved filters / scheduled delivery (Phase 7 deferrals).
- Pagination (queued; the registry already supports a paginated
  `fetch` shape and we'll wire it when the >100k-row exit criterion
  is addressed).

## Files

- `packages/api/src/services/reports/general-ledger.ts` — new spec
- `packages/api/src/services/reports/registry.ts` — register
- `packages/api/src/services/reports/reports.test.ts` — coverage
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  add `general-ledger` to SHAPES; add `accountId` + `sourceType`
  inputs (chapterId / giving type / payment method / date range
  inputs already exist).
- `packages/api/src/routes/tenant-reports.test.ts` — registry list
  assertion (add `general-ledger`).
- `docs/ROADMAP.md` — flip the queued bullet to done; bump audited
  status block.

## Tests (vitest)

In `reports.test.ts`, new `describe("general-ledger report")`:

1. `lists posted lines with per-currency totals` — seed 3
   contributions (2 chapters, 2 giving types, 2 payment methods),
   post them, run the report unfiltered over a window. Assert row
   count = total lines; per-currency subtotal ties.
2. `filters by chapter` — same dataset; pass `chapterId`, assert
   only that chapter's lines appear.
3. `filters by giving type` — pass `givingTypeId`, assert only
   matching lines.
4. `filters by account` — line.account_id defaults to the giving
   type's account; pass `accountId`, assert filtered rows.
5. `filters by source type` — assert `sourceType=manual` excludes
   `online`.
6. `excludes drafts and voided; includes reversals` — net should
   match the existing reversal-nets-to-zero pattern (the original
   + the reversal both appear, net = 0).
7. `chapter-scoped caller is clamped to bound chapters`; out-of-scope
   `chapterId` filter → `accessCheck === "forbidden"`.
8. `excel renders the branded header and escapes formula injection`
   in member full names.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- New tests pass.
- `/zone/reports` lists "General ledger (giving)"; the per-report
  page renders the filter form, runs, and downloads a valid xlsx.
- Roadmap audited-status block updated.

## Open questions

- The legacy `Report_Givings_All_GeneralLedger` includes a "reversal
  of" column. We expose the reversed-from contribution id when
  present (column `reversalOfContributionId`) so a treasurer
  reconciling against the legacy artefact can match rows.
