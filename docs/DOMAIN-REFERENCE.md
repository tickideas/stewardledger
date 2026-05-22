# Domain Reference

> Lessons distilled from the legacy Church Plus app and its SQL Server databases.
> **StewardLedger is not a migration of Church Plus.** This document exists so we don't lose the years of operational know-how baked into that codebase.
> If/when a future zone wants to leave Church Plus and onboard onto StewardLedger, an ETL can be built using this reference plus the schema map in [`DOMAIN-MODEL.md §13`](DOMAIN-MODEL.md#13-reference-legacy-domain--steward).

---

## 1. What the legacy app is

A single-tenant ASP.NET Core 6 application deployed per zone (e.g. UK Zone 1) on Windows + IIS. Internally branded **Church Plus / Financial Manager**.

Stack: ASP.NET Core 6 MVC, EF Core 6, SQL Server 2019, ASP.NET Core Identity, FluentValidation, NLog, EPPlus + NPOI + DinkToPdf, jQuery + Bootstrap 5 + DataTables, MailKit + SendGrid.

Solution structure (Onion Architecture):

- `FinancialManager.Model` — entities
- `FinancialManager.ViewModel` — request/response DTOs (~100)
- `FinancialManager.ModelValidator` — FluentValidation rules
- `FinancialManager.Data` — EF Core DbContext + repositories + entity configs
- `FinancialManager.Service` — application services (~30)
- `FinancialManager.Utility` — helpers, enums, datetime utilities
- `FinancialManager.Client` — MVC web app (24 controllers, Razor views, JS bundles)
- `EmailService` — MailKit-based sender

Databases per zone:

| Database | Purpose |
|---|---|
| `UKZ1_Main` | Live application data (members, giving, envelopes, periods, …) |
| `TransferHolding` | Statement / file-upload staging |
| `UKZ1_DEV` | Developer mirror with extra dedup views and helper procs |
| `UKZ1_ChurchTransaction` | `cto.*` schema — financial targets, paying-in books, ministry calendar, transactions |
| `ChurchPlusStaging` | Multi-tenant template (canonical Church Plus shape) |

Counts (in `UKZ1_Main` alone): 52 tables, 6 views, 21 functions, ~125 stored procedures, 5 triggers, ~58 foreign keys.

---

## 2. Domain vocabulary

| Legacy term | Definition |
|---|---|
| Zone | A single Christ Embassy zone (e.g. UK Zone 1). The deployed instance. |
| ChurchGroup | A grouping inside a zone. Sometimes used as a regional label (e.g. "Region South"); sometimes as a department/cluster. Inconsistent. |
| Chapter | A single local church / congregation. |
| Member | An individual in a chapter. |
| Meeting / Church Service | A specific service event (Sunday service, midweek, special programme). |
| MeetingType / ChurchServiceType | Category of service. |
| Giving | Money given by a member or chapter. |
| GivingCategory | Top-level category of giving (e.g. Tithe, Offering, Partnership). |
| GivingType | A specific giving line item (e.g. "Healing School Partnership"). |
| ChurchEnvelope | A physical envelope handed in at a service, containing one or more giving lines for a member. |
| OblationEnvelope | A special envelope tied to a service, allowing multiple members per envelope. |
| Givings (table) | Imported / online giving (one row per amount, derived from bank statements or online giving). |
| Account | A financial bucket the giving is allocated to (a fund). |
| PaymentMethod | Cash, cheque, card, bank transfer, online, etc. |
| GivingsPeriod | A specific date with all its derived calendar attributes (week, month, fiscal period, ministry period, partnership period). One row per date. |
| MinistryCalendar / MinistryYear | The Christ Embassy ministry calendar (typically March → February). |
| Partnership | Annual/period giving target for a giving type, per chapter. |
| PayingInBook | A range of receipt reference codes assigned to a chapter for a period. |

---

## 3. Workflows captured in the legacy app

Each is summarised here so we can rebuild the same operational fluency in StewardLedger without copying the implementation.

### 3.1 Sunday service close (envelope giving)

1. Treasurer opens the chapter dashboard.
2. Picks the service event (date + type).
3. Adds envelopes one by one: member, payment method, lines (giving type + amount).
4. Cash and cheque totals are computed at the envelope level and rolled up to a daily total.
5. Submits the batch.
6. Reports: weekly finance report by chapter, envelope ledger, top members.

Legacy artifacts:
- Tables: `ChurchEnvelope`, `ChurchEnvelopeGivings`, `ChurchEnvelopeMember`, `Meeting`, `MeetingType`.
- Procs: `ChurchEnvelope_Insert`, `ChurchEnvelope_SelectForView`, `ChurchEnvelopeGivings_Insert`, `ChurchEnvelope_WeeklyFinanceReport_PIVOT`, `ChurchEnvelope_WeeklyReport`.
- Triggers: `ChurchEnvelope_trg`, `ChurchEnvelopeGivings_trg` (history capture).

### 3.2 Online / bank-statement giving import

1. Zonal finance officer downloads a bank statement (CSV/XLSX).
2. Uploads it. Goes into `TransferHolding.ChurchPlusStatement_Holding`.
3. The system runs `ChurchPlusStatement_Holding_Update` to fill `MemberID`, `GivingTypeID`, `ChapterID`, `GivingsPeriodID` from raw codes.
4. Duplicates flagged via `ChurchPlusStatement_Holding_Duplicates_Sum`.
5. Officer reviews failures, fixes mappings.
6. Three commit modes:
   - **Assess only** — preview, no write.
   - **Assess + schedule** — moves into `ChurchPlusStatement_Schedule` for later.
   - **Assess + schedule + commit** — `ChurchPlus_Statement_BatchExecute` posts straight into `ukz1.Givings`.
7. `TransactionUpload` row added for idempotency.
8. Re-uploads detect duplicates by composite key.

Legacy artifacts:
- Tables: `ChurchPlusStatement_Holding`, `ChurchPlusStatement_Schedule`, `Givings`, `TransactionUpload`, `FileUpload_ProcessFile`, `FileUpload_ProcessFile_FailureType`, `FileUploadAccountSourceType`, `JobType`.
- Procs: ~25 in the `ChurchPlus_Statement_*` and `ChurchPlusStatement_FileUpload_*` family.
- TVPs: `ChurchPlus_StatementType`, `FileUpload_Member_Type`.

This is the legacy app's most valuable feature.

### 3.3 Member dedup

1. Member records arrive both manually and via bulk imports.
2. Dedup views surface duplicates by:
   - same name
   - same name + chapter
   - same name with different chapter
   - names with invalid characters
3. Officer chooses a primary, applies merge.
4. References in `ChurchEnvelope`, `Givings`, `MemberAddress` re-pointed.
5. Old member soft-deactivated.

Legacy artifacts:
- Views: `Member_Duplicate_All_MemberName`, `Member_Duplicate_Single_MemberNameWithDifferentChapterID`, `Member_Duplicate_All_MemberNameChapterID`, `Member_Duplicate_Single_MemberNameChapterID`, `Member_NameWithInvalidCharacterView`.
- Procs: `Member_Merge`, `Member_Merge_u`, `Member_MergeDetailsAndDelete_u`, `Member_MergeDuplicateFromFile`, `usp_Member_DeleteDuplicates`, `usp_Member_UpdateWithDuplicate`, `usp_ChapterMember_DeleteDuplicateMemberID`, `usp_ChurchEnvelope_UpdateDuplicateMemberID`.
- Member history: `Member_History` table + `Member_trg` trigger.

### 3.4 Partnership target tracking

1. Define a target per chapter + giving type + ministry year.
2. Track full target, monthly target, weekly breakdown, number of partners, full-target copies.
3. Compare actual giving (from `Givings` + envelope lines) against target.
4. Reports: top partners, top chapters, partnership progress per category.

Legacy artifacts:
- Tables: `cto.FinancialTarget`, `cto.MinistryCalendar`, `cto.GivingTypeAccount`, `cto.PayingInBook`, `PartnershipPeriod`.
- Procs: `Givings_All_PartnershipByCategory`, `Givings_All_PartnershipByChurchGroup`, `Givings_All_TopPartner`, `Givings_All_TopChapter`, `Givings_Partnership_TopChapter`, `Givings_Partnership_TopPartner`, `Givings_Partnership_BreakdownByChapter_PIVOTByCategory`, `Givings_Partnership_BreakdownByChapter_PIVOTByPeriod`, `Givings_Partnership_BreakdownByGroup_PIVOTByCategory`.

### 3.5 Member statements

1. Annual member statement PDF generated on demand or on schedule.
2. Branded with church/zone logo.
3. Lists every contribution by date, service, giving type, payment method, amount.
4. Total at bottom.

Legacy artifacts:
- Procs: `ChurchEnvelope_MemberFinanceStatement_PIVOTByPeriod`, `ChurchEnvelope_MemberFinanceSummary_PIVOTByPeriod`, `ChurchEnvelope_MemberFinanceSummaryView`, `Givings_All_Individual_PIVOTByPeriod`.
- Generated via DinkToPdf (we replace with Playwright-based HTML→PDF).

### 3.6 Reports (general)

The legacy app has 30+ named reports, almost all served by stored procedures with dynamic SQL PIVOT queries. We rebuild them as application services (see [`REPORTS.md`](REPORTS.md)).

---

## 4. Schema patterns to retain

### 4.1 Reference codes

`Member` has `ReferenceCode` (e.g. `M0000123`). `Chapter` has `ReferenceCode` (e.g. `LWUKZ100001` — generated from church group + year + sequence). Treasurers and pastors use these as primary identifiers.

We retain reference codes in StewardLedger, but the format is configurable per zone (the legacy format is the default).

### 4.2 Period dimension

`GivingsPeriod` is one row per date with every calendar attribute precomputed. This makes pivots and rollups trivial in SQL. StewardLedger keeps the same shape, scoped per zone.

### 4.3 Audit history triggers

The legacy app has triggers writing to `*_History` tables on update/delete:

- `Member_trg` → `Member_History`
- `ChurchEnvelope_trg` → `ChurchEnvelope_History`
- `ChurchEnvelopeGivings_trg` → `ChurchEnvelopeGivings_History`
- `Givings_trg` → `Givings_History`

StewardLedger replaces this with a single append-only `audit_events` table per tenant, plus posted-record immutability. Cleaner and more general.

### 4.4 Dedup strategy

The legacy dedup heuristics (name, name+chapter, name with diff chapter, invalid chars) are good. StewardLedger implements the same, plus surfaces them in a review queue rather than applying merges silently.

---

## 5. Patterns to deliberately drop

| Legacy pattern | Why we drop it |
|---|---|
| Stored procedures for business logic (~125 of them) | Untestable, ties us to SQL Server, hides invariants. Replace with application services. |
| Dynamic SQL PIVOT for reports | Hard to maintain, brittle when giving types change. Replace with application-side pivot. |
| Cross-database stored proc calls (`UKZ1_DEV.ukz1.*`, `TransferHolding.ukz1.*`) | Fragile, hard to deploy, breaks when DBs are renamed. Replace with single-DB design. |
| `varchar(50)` for `DateJoinedMinistry` and `FoundationSchoolGraduationDate` | Schema drift / partial dates. Replace with proper `date` and a free-text fallback in `metadata` only when unparseable. |
| `money` SQL Server type | Replaced by `numeric(19,4)` + explicit `currency_code`. |
| `float` for `cto.FinancialTarget` amounts | Replaced by `numeric(19,2)`. |
| Mutable financial records | Replaced by posted-immutable + reversal. |
| Ambiguous `ChurchGroup` (sometimes region-like, sometimes department-like) | `region` (reference data) holds the geographic-tier concept. The department/group concept is the StewardLedger `groups` table (see DOMAIN-MODEL.md §2.5). Per-zone opt-in. |
| ASP.NET Identity password hashes | Replaced by Better Auth (email OTP / magic link / password). Legacy hashes wouldn't migrate cleanly anyway. |
| EPPlus non-commercial | Replaced by `exceljs` (MIT, no licensing risk). |
| DinkToPdf / wkhtmltopdf | Replaced by Playwright Chromium HTML→PDF. |
| NLog → SQL `LogEvent` proc | Replaced by pino JSON + Loki/Grafana. |
| IIS in-process hosting | Replaced by Docker on Linux + Dokploy. |

---

## 6. Operational lessons

1. **Reports are the product.** Treasurers and pastors judge the app on whether they can produce the Excel/PDF they need. Any v1 missing a key report will lose trust.
2. **Bank statement formats vary.** The legacy app handles a few specific banks via custom holding logic. StewardLedger needs a pluggable parser registry.
3. **Member dedup is constant work.** A merge-proposal queue with audit is essential.
4. **Idempotent imports matter.** Treasurers re-run uploads when they're nervous; the system must never double-post.
5. **Period boundaries shift.** Ministry-year start can change; fiscal period close is a delicate operation. StewardLedger models periods explicitly with status transitions.
6. **Posted contributions get edited "just this once"** in the legacy app. That's the bug we fix with hard immutability + reversal.
7. **History triggers are not enough.** Auditors need actor (the human user, not the SQL login), reason, and IP. We capture that.

---

## 7. Source artifacts (for reference)

The decompiled C# is at `/tmp/decompiled/FinancialManager.*`. The exported SQL schemas are in the parent of this `docs/` folder:

| File | Purpose |
|---|---|
| `../05script.sql` | Older `UKZone1_Master` schema (predecessor; mostly superseded). |
| `../07script.sql` | Live `UKZ1_Main` schema. The primary reference for the domain. |
| `../TransferHolding.schema.sql` | Statement/file-upload staging schema. |
| `../UKZ1_DEV.sql` | Developer mirror with extras (dedup views, helper procs). |
| `../UKZ1_ChurchTransaction.sql` | `cto.*` schema — targets, paying-in books, ministry calendar. |
| `../ChurchPlusStaging.schema.sql` | Multi-tenant template schema. |

These are the historical artifacts. They don't drive StewardLedger's data; they inform StewardLedger's design.
