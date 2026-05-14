# Phase 7 — Online giving ledger report

Implements REPORTS.md §2.5 (`Report_Givings_Online_GeneralLedger`,
`Givings_Online_SelectForView` legacy mapping). Line-level ledger
of every online / bank-import contribution.

## MVP scope

- **Filters**:
  - `dateFrom`, `dateTo` (required, ISO yyyy-mm-dd, `dateFrom <= dateTo`)
  - `chapterId` (optional uuid)
  - `paymentMethodId` (optional uuid)
  - `givingTypeId` (optional uuid)
  - `accountId` (optional uuid)
  - `sourceType` (optional enum, restricted to `online | bank_import`)
- **Hard preset**: `source_type in ('online','bank_import')`. The
  `sourceType` filter narrows further; an `envelope` / `manual` /
  `oblation` value is rejected by the schema.
- **Rows**: one per `contribution_line` in scope.
- **Columns**: date, chapter ref + name, member ref + name, giving
  type, account, payment method, source, **transaction id**
  (`contributions.external_transaction_id`), currency, amount, status.
- **Subtotals**: per-currency grand totals. Sort by (account name nulls
  last, contribution date, contribution id) so the Excel reads as
  account-grouped within the date range.
- **Access**: standard. Zone readers see all; chapter readers see
  bound chapters; out-of-scope `chapterId` → 403.
- **Excel**: branded sheet, `escapeExcelText` on every text cell,
  per-currency money formatting.

## Non-goals (deferred)

- PDF (Phase 7-wide).
- Per-account subtotal rows in Excel.
- Saved filters.

## Files

- `packages/api/src/services/reports/online-giving-ledger.ts` — new spec
- `packages/api/src/services/reports/registry.ts` — register
- `packages/api/src/services/reports/reports.test.ts` — coverage
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  `online-giving-ledger` SHAPES entry. The `sourceType` select needs
  a narrower option list for this report than general-ledger
  (online + bank_import only). Easiest path: keep the shared filter
  state but show only the two valid options via a per-report check
  (we already do this for `pivotBy` in giving-by-chapter); the
  server-side schema rejects the others anyway.
- `packages/api/src/routes/tenant-reports.test.ts` — registry list
  assertion (now 8 reports).
- `docs/ROADMAP.md` — flip the queued bullet; bump audited status.

## Tests (vitest)

In `reports.test.ts`, new `describe("online-giving-ledger report")`:

1. `lists only online + bank_import sources with per-currency totals`
   — seed an envelope, an online, and a bank_import contribution;
   post all three. Run unfiltered over the window; assert exactly
   the two non-envelope rows appear and totals tie.
2. `exposes the external transaction id` — verify each row carries
   the `transactionId` we stored on the contribution.
3. `filters by sourceType (online vs bank_import)` — the schema
   rejects an envelope value; assert `parseReportFilters` raises
   `invalid_filters`.
4. `chapter-scoped caller clamped to bound chapters` + out-of-scope
   `chapterId` → `accessCheck === "forbidden"`.
5. `excel renders the branded header and escapes formula-injection
   in transaction ids` (the bank statement may carry an attacker-
   controlled reference string).

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- New tests pass.
- `/zone/reports` lists "Online giving ledger" with `online-giving-ledger` id.
- Roadmap audited-status block updated.
