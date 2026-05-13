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
| Exports | Excel via `exceljs`; PDF via Playwright + branded HTML template. |
| Branding | Zone logo, name, address, currency on every export. |
| Saved filters | Per user, per zone. |
| Scheduling | Optional: weekly/monthly delivery via email. |
| Permissions | Role-aware; viewers cannot export raw PII. Cross-zone reports are platform-admin only (v1.1). |

---

## 2. v1 report inventory

### 2.1 Member statement (annual)

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

- **Filters**: zone, chapter, member or all, date range, payment method, giving type.
- **Columns**: member ref, member name, payment method, period, giving types (pivoted as columns).
- **Group by**: member.
- **Export**: Excel, PDF.
- **Legacy mapping**: `Givings_All_MemberFinanceSummaryView`, `ChurchEnvelope_MemberFinanceSummaryView`, `MemberFinanceReport`, `MemberFinanceReport_PIVOT` (legacy).
- **Acceptance**: per-member sums match legacy values; pivot column names follow giving types sorted by ordinal, with inactive historical giving types clearly marked.

### 2.3 Weekly finance report

- **Filters**: zone, chapter (optional), date range or "this week".
- **Columns**: service date, service type, week-in-month, men/women/teens/children/first-timers/new-converts, cash, cheque, line totals.
- **Group by**: chapter, week.
- **Export**: Excel.
- **Legacy mapping**: `ChurchEnvelope_WeeklyFinanceReport_PIVOT`, `ChurchEnvelope_WeeklyFinanceReportView`, `Chapter_WeeklyIncomeAndAttendance`.
- **Acceptance**: weekly totals tie to legacy weekly report.

### 2.4 Envelope ledger

- **Filters**: zone, chapter, member (optional), date range.
- **Columns**: envelope id, member, service event, payment method, lines (giving type + amount), total.
- **Group by**: month / chapter.
- **Export**: Excel, PDF.
- **Legacy mapping**: `Report_ChurchEnvelope_Ledger`, `ChurchEnvelope_MemberFinanceReportView`.
- **Acceptance**: line counts and totals match legacy.

### 2.5 Online giving ledger

- **Filters**: zone, chapter (optional), date range, payment method.
- **Columns**: date, member, chapter, giving type, account, transaction id, amount, currency.
- **Group by**: date / chapter.
- **Export**: Excel.
- **Legacy mapping**: `Report_Givings_Online_GeneralLedger`, `Givings_Online_SelectForView`, `Givings_Online_Individual_PIVOTByCategory`.
- **Acceptance**: full reconciliation of all `source_type='online'` and `'bank_import'` contributions in the period.

### 2.6 General ledger (giving)

- **Filters**: zone, chapter, date range, account, giving type.
- **Columns**: date, chapter, member, giving type, account, payment method, amount, currency.
- **Group by**: account / giving type (per currency).
- **Export**: Excel.
- **Legacy mapping**: `Report_Givings_All_GeneralLedger`, `Givings_All_SelectForView`, `Givings_All_SelectForView_PIVOTByCategory`.
- **Acceptance**: reconciles to envelope ledger + online ledger sum.

### 2.7 Giving by chapter (PIVOT by category / period)

- **Filters**: zone, date range, ministry-year option, partnership-period option.
- **Rows**: chapter.
- **Columns** (pivoted): giving categories or giving types or periods.
- **Export**: Excel.
- **Legacy mapping**: `Givings_All_BreakdownByChapter_PIVOTByCategory`, `Givings_All_BreakdownByChapter_PIVOTByPeriod`.

### 2.8 Top partners

- **Filters**: zone, chapter (optional), date range, top N.
- **Columns**: rank, member, total contributions, partnership category breakdown.
- **Export**: Excel, PDF.
- **Legacy mapping**: `Givings_All_TopPartner`, `Givings_Partnership_TopPartner`.

### 2.9 Top chapters

- Same as 2.8, with chapters.
- **Legacy mapping**: `Givings_All_TopChapter`, `Givings_Partnership_TopChapter`.

### 2.10 Partnership progress

- **Filters**: zone, chapter, ministry year, giving type with `has_partnership_target = true`.
- **Columns**: target, achieved, % progress, weekly / monthly breakdown vs actual, projected end-of-year.
- **Export**: Excel, PDF.
- **Legacy mapping**: `Givings_All_PartnershipByCategory`, `Givings_All_PartnershipByChurchGroup`, `Givings_All_MemberPartnershipBreakdownByMonth_PIVOT`.
- **Acceptance**: matches legacy values; chart shows weekly progression.

### 2.11 Statement import reconciliation

- **Filters**: zone, import job id or date range.
- **Columns**: file name, uploaded by, total rows, matched, unmatched, duplicates, failed, committed, contributions posted, total amount, status.
- **Export**: Excel.
- **Legacy mapping**: combinations of `ChurchPlus_Statement_Uploaded`, `ChurchPlus_Statement_NotUploaded`, `ChurchPlus_Statement_Duplicates`.
- **Acceptance**: every row of every imported file is accounted for.

### 2.12 Member list

- **Filters**: zone, chapter, status (active/inactive), member type, date joined ministry range, age range.
- **Columns**: member ref, full name, gender, date of birth, mobile, email, chapter, member type, marital status, date joined ministry.
- **Export**: Excel.
- **Legacy mapping**: `Member_SelectAll`, member dashboards.

### 2.13 Audit log report

- **Filters**: zone, actor, entity type, entity id, action, date range.
- **Columns**: occurred_at, actor, action, entity, before/after diff.
- **Export**: Excel.

### 2.14 Chapter dashboard

- Cards: total members, active members, weekly giving, monthly giving, top giving types, target progress.
- Drilldowns to the reports above.

### 2.15 Zone dashboard

- Cards: total chapters, total members, monthly giving (per currency), partnership progress, top chapters, top partners, recent imports.

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
