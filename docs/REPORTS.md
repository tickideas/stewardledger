# Reports

> Companion to [`PRD.md`](PRD.md), [`DOMAIN-MODEL.md`](DOMAIN-MODEL.md), [`ROADMAP.md`](ROADMAP.md).
>
> Reports are core, not auxiliary. The legacy app has more reporting procedures than CRUD. We rebuild them as application services with consistent UX, cached data, and PDF/Excel export.
>
> Format for every report:
> - **Filters**, **columns**, **grouping**, **export formats**, **legacy mapping**, **acceptance**.

---

## 1. Common patterns

| Concern | Approach |
|---|---|
| Filters | Date range, chapter, zone-wide, giving type, giving category, member, payment method, period type, currency. |
| Pagination | Default 100, max 1000 per page; large reports stream as a background job. |
| Aggregations | Sum, count, average per period or per category, **always grouped by currency**. |
| Pivots | Server fetches normalised rows; client pivots in Svelte (small) or worker pivots (large). |
| Exports | Excel via `exceljs`; PDF via `pdfkit` for the tabular reports (generic branded-table renderer). Bespoke HTML/CSS layouts (member-statement letter, partnership receipts) will switch to Playwright + branded templates in a follow-up. |
| Branding | Zone logo, name, address, currency on every export. |
| Saved filters | Per user, per zone. |
| Scheduling | Optional: weekly/monthly delivery via email. |
| Permissions | Role-aware; viewers cannot export raw PII. Group-tier readers see report rows clamped through `visibleChapterIds(ctx)`. Cross-zone reports are platform-admin only (v1.1). |

---

## 2. v1 report inventory

> **Status legend** (per-report markers below):
> - **Done** — spec, route, UI, and tests landed; Excel + PDF artefacts verified end-to-end.
> - **Queued** — not yet implemented.
> - Every tabular report is rendered to PDF via the generic branded-table renderer in `packages/api/src/services/reports/pdf/branded-table.ts`. Bespoke layouts (letter-style member statement, partnership receipts) will switch to Playwright + HTML/CSS in a follow-up PR per ARCHITECTURE.md §2.

### 2.1 Member statement (annual)

**Status**: Done. `packages/api/src/services/reports/member-statement.ts`. When the member belongs to an open household the `fetch` result carries a `meta.household` block (family ref, name, per-currency totals over the same date window) and the Excel renderer stamps a household band below the totals — see [`CHURCHPLUS-PORT-NOTES.md` §2.2.1](CHURCHPLUS-PORT-NOTES.md#221-family--household-grouping).

- **Filters**: zone, member, year (or custom range), giving type filter (optional), include voided (no by default).
- **Columns**: date, service event, giving type, account, payment method, amount; running total.
- **Group by**: month / period; grand total at end.
- **Export**: PDF (default), Excel.
- **Legacy mapping**:
  - `ChurchEnvelope_MemberFinanceStatement_PIVOTByPeriod`
  - `Givings_All_Individual_PIVOTByPeriod`
  - `Givings_All_IndividualBreakdownByCategory_PIVOTByPeriod`
- **Acceptance**: per-member yearly total ties to legacy `MemberFinanceStatementSummary` PDF row-for-row for the pilot tenant.

### 2.2 Member finance summary (range)

**Status**: Done. `packages/api/src/services/reports/member-finance-summary.ts`.

- **Filters**: zone, chapter, member or all, date range, payment method, giving type.
- **Columns**: member ref, member name, payment method, period, giving types (pivoted as columns).
- **Group by**: member.
- **Export**: Excel, PDF.
- **Legacy mapping**: `Givings_All_MemberFinanceSummaryView`, `ChurchEnvelope_MemberFinanceSummaryView`, `MemberFinanceReport`, `MemberFinanceReport_PIVOT` (legacy).
- **Acceptance**: per-member sums match legacy values; pivot column names follow giving types sorted by ordinal, with inactive historical giving types clearly marked.

### 2.3 Weekly finance report

**Status**: Done. `packages/api/src/services/reports/weekly-finance.ts`. Attendance lives in the new `service_event_attendance` sibling table (1:1 with `service_events`); read / upsert at `GET/PUT /api/tenant/giving/service-events/:id/attendance`.

- **Filters**: date range, chapter (optional, clamped to bound chapters for chapter readers).
- **Columns**: service date, week-in-month, service type, chapter ref + name, men/women/teens/children/first-timers/new-converts + total attendance, cash, cheque, line total, currency.
- **Group by**: chapter ref, service date, service type.
- **Export**: Excel.
- **Legacy mapping**: `ChurchEnvelope_WeeklyFinanceReport_PIVOT`, `ChurchEnvelope_WeeklyFinanceReportView`, `Chapter_WeeklyIncomeAndAttendance`.
- **Acceptance**: weekly totals tie to a hand-curated dataset in `reports.test.ts`. Reversal-pair contributions net to zero in line totals; missing attendance renders as zero counts.

### 2.4 Envelope ledger

**Status**: Done. `packages/api/src/services/reports/envelope-ledger.ts`.

- **Filters**: zone, chapter, member (optional), date range.
- **Columns**: envelope id, member, service event, payment method, lines (giving type + amount), total.
- **Group by**: month / chapter.
- **Export**: Excel, PDF.
- **Legacy mapping**: `Report_ChurchEnvelope_Ledger`, `ChurchEnvelope_MemberFinanceReportView`.
- **Acceptance**: line counts and totals match legacy.

### 2.5 Online giving ledger

**Status**: Done. `packages/api/src/services/reports/online-giving-ledger.ts`.

- **Filters**: zone, chapter (optional), date range, payment method.
- **Columns**: date, member, chapter, giving type, account, transaction id, amount, currency.
- **Group by**: date / chapter.
- **Export**: Excel.
- **Legacy mapping**: `Report_Givings_Online_GeneralLedger`, `Givings_Online_SelectForView`, `Givings_Online_Individual_PIVOTByCategory`.
- **Acceptance**: full reconciliation of all `source_type='online'` and `'bank_import'` contributions in the period.

### 2.6 General ledger (giving)

**Status**: Done. `packages/api/src/services/reports/general-ledger.ts`.

- **Filters**: zone, chapter, date range, account, giving type.
- **Columns**: date, chapter, member, giving type, account, payment method, amount, currency.
- **Group by**: account / giving type (per currency).
- **Export**: Excel.
- **Legacy mapping**: `Report_Givings_All_GeneralLedger`, `Givings_All_SelectForView`, `Givings_All_SelectForView_PIVOTByCategory`.
- **Acceptance**: reconciles to envelope ledger + online ledger sum.

### 2.7 Giving by chapter (PIVOT by category / period)

**Status**: Done. `packages/api/src/services/reports/giving-by-chapter.ts` — pivots by giving type, category, or month with optional ministry-year / partnership-year window clamps.

- **Filters**: zone, date range, ministry-year option, partnership-period option.
- **Rows**: chapter.
- **Columns** (pivoted): giving categories or giving types or periods.
- **Export**: Excel.
- **Legacy mapping**: `Givings_All_BreakdownByChapter_PIVOTByCategory`, `Givings_All_BreakdownByChapter_PIVOTByPeriod`.

### 2.8 Top partners

**Status**: Done. `packages/api/src/services/reports/top-partners.ts` — per-currency ranking, `topN` (default 20), `partnershipOnly` toggle covers the legacy `Givings_Partnership_TopPartner` variant. Per-category breakdown columns are deferred to land alongside §2.10 partnership progress.

- **Filters**: zone, chapter (optional), date range, top N.
- **Columns**: rank, member, total contributions, partnership category breakdown.
- **Export**: Excel, PDF.
- **Legacy mapping**: `Givings_All_TopPartner`, `Givings_Partnership_TopPartner`.

### 2.9 Top chapters

**Status**: Done. `packages/api/src/services/reports/top-chapters.ts` — same shape as top-partners with chapter as the group key.

- Same as 2.8, with chapters.
- **Legacy mapping**: `Givings_All_TopChapter`, `Givings_Partnership_TopChapter`.

### 2.10 Partnership progress

**Status**: Done. `packages/api/src/services/reports/partnership-progress.ts`. Consumes `financial_targets` joined with the partnership-tagged giving types.

- **Filters**: ministry year (required), chapter (optional), giving type (optional, partnership-tagged types only).
- **Columns**: chapter, giving type, ministry year, currency, target, monthly target, weekly target, achieved (posted+reversed lines in the ministry-year window), % progress, weekly average actual, monthly average actual, projected end-of-year, target copies, number of partners.
- **Export**: Excel + PDF.
- **Legacy mapping**: `Givings_All_PartnershipByCategory`, `Givings_All_PartnershipByChurchGroup`. (`MemberPartnershipBreakdownByMonth_PIVOT` is a separate member-level pivot deferred to a follow-up.)
- **Acceptance**: hand-curated dataset in `reports.test.ts` covers target vs achieved math, zone-wide vs chapter-scoped aggregation, reversal-nets-to-zero invariant, partnership-type-only filter, and chapter clamp.

### 2.11 Statement import reconciliation

**Status**: Done. `packages/api/src/services/reports/import-reconciliation.ts`.

- **Filters**: zone, import job id or date range.
- **Columns**: file name, uploaded by, total rows, matched, unmatched, duplicates, failed, committed, contributions posted, total amount, status.
- **Export**: Excel.
- **Legacy mapping**: combinations of `ChurchPlus_Statement_Uploaded`, `ChurchPlus_Statement_NotUploaded`, `ChurchPlus_Statement_Duplicates`.
- **Acceptance**: every row of every imported file is accounted for.

### 2.12 Member list

**Status**: Done. `packages/api/src/services/reports/member-list.ts`.

- **Filters**: zone, chapter, status (active/inactive), member type, date joined ministry range, age range.
- **Columns**: member ref, full name, gender, date of birth, mobile, email, chapter, member type, marital status, date joined ministry.
- **Export**: Excel.
- **Legacy mapping**: `Member_SelectAll`, member dashboards.

### 2.13 Audit log report

**Status**: Done. `packages/api/src/services/reports/audit-log.ts` reads the existing `audit_events` table.

- **Filters**: actor user id, entity type, entity id, action, date range.
- **Columns**: occurred_at, actor email, role, action, entity type/id, reason, before/after JSON.
- **Export**: Excel.

### 2.14 Chapter dashboard

**Status**: Done. Server-aggregated payload via `GET /api/tenant/dashboard/chapter/:chapterId`; UI at `/church/overview`. Service: `packages/api/src/services/dashboards/chapter-dashboard.ts`.

- Cards: total / active / inactive members, pending batches (count + per-currency totals), weekly giving, monthly giving, year-to-date giving, top 5 giving types, top 5 partners, 5 most recent posted contributions.
- Target progress card deferred (depends on Phase 8 financial targets).

### 2.16 Top families

**Status**: Done. `packages/api/src/services/reports/top-family.ts`.

- **Filters**: zone, chapter (optional), date range, top N (default 20), `partnershipOnly` toggle.
- **Columns**: rank, family ref, family name, chapter ref, chapter name, member count, currency, total.
- **Group by**: per-currency ranking (no silent FX).
- **Export**: Excel + PDF (via the generic branded-table renderer).
- **Legacy mapping**: `Top Family Report` (Church Plus `custom_client_app`). See [`CHURCHPLUS-PORT-NOTES.md` §2.2.1](CHURCHPLUS-PORT-NOTES.md#221-family--household-grouping).
- **Acceptance**: per-family totals match the sum of member contributions; reversal pairs net to zero and drop a household out of the ranking when the only giving was reversed; partnership-only filter restricts to `has_partnership_target = true` giving types.

### 2.15 Zone dashboard

**Status**: Done. Server-aggregated payload via `GET /api/tenant/dashboard/zone`; UI at `/zone/dashboard` (the default zonal landing). Service: `packages/api/src/services/dashboards/zone-dashboard.ts`.

- Cards: total / active chapters, total / active / inactive members, monthly giving (per currency), year-to-date giving (per currency), top 5 chapters, top 5 partners, 5 most recent imports.
- Partnership progress card deferred (depends on Phase 8 financial targets).

---

## 3. Out-of-v1 reports (planned)

- Trial balance, income statement, balance sheet (v2 with double-entry).
- Cashbook (v2).
- Bank reconciliation (v2).
- Budget vs actual (v2).
- Tax/charity giving statements per jurisdiction (UK Gift Aid, US 501(c)(3) annual statement, etc.) — v1.1 if a tenant requires.
- Anomaly detection (AI) — v3+.

---

## 4. Implementation notes

- Reports are services in `packages/api/src/services/reports/<report-id>.ts`, each exporting:
  ```ts
  type ReportSpec<F, R> = {
    id: string;
    title: string;
    description: string;
    filtersSchema: ZodTypeAny;
    fetch(
      database: Database,
      ctx: AuthorizedContext,
      filters: F
    ): Promise<ReportFetchResult<R>>; // { rows, columns?, subtotals?, meta? }
    columns(filters: F): ReportColumn[];
    excel(
      rows: R[],
      subtotals: CurrencySubtotal[] | undefined,
      filters: F,
      branding: ReportBranding
    ): Promise<Uint8Array>;
    accessCheck?: (ctx: AuthorizedContext, filters: F) => string | null;
  };
  ```
- A registry exposes reports to the API and the UI; both read the same `columns()` to render screen and exports consistently.
- Big reports run as `report.generate` jobs and email a download link when ready.
- All exports go to object storage and are retained per tenant retention policy.
- Reports never read across tenants. Cross-tenant aggregation is platform-admin-only.

---

## 5. Acceptance for the v1 report set

- Every report in §2 ties out against a hand-curated test dataset.
- Excel and PDF exports work in both Microsoft Excel and Google Sheets / preview tools.
- Branded headers (logo, zone name, currency) appear on every export.
- Reports of >100k rows complete within 60 seconds (background job) and are downloadable.
- All reports respect role-based permissions; viewers cannot export PII fields.
- Multi-currency reports show per-currency subtotals; no silent FX conversion in v1.
