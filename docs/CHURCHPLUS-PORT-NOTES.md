# Church Plus → StewardLedger Port Notes

> Companion to [`PRD.md`](PRD.md), [`DOMAIN-MODEL.md`](DOMAIN-MODEL.md), [`DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md), [`REPORTS.md`](REPORTS.md), [`ROADMAP.md`](ROADMAP.md).
> Status: Draft v0.1 — 2026-05-26
> Owner: Bryan
> Scope: Capabilities the live Church Plus + recovered `custom_client_app` codebase has that StewardLedger does **not** yet have, scored for whether/when to port.

---

## 0. How to read this document

For every capability:

- **What it is in Church Plus** — short description and the DocType / module that implements it.
- **Why it matters** — who relies on it and what would break in the field if we shipped without it.
- **What StewardLedger has today** — closest existing concept.
- **Port verdict** — one of:
  - **Port v1** — add before GA.
  - **Port v1.1** — schedule for the v1.1 hardening phase.
  - **Port v2** — backlog; nice to have, not blocking.
  - **Drop** — explicitly do not port (with reason).
- **Suggested phase / file targets** — exactly where it would slot in.

We deliberately translate from Church Plus *concepts* to StewardLedger primitives instead of porting their schemas verbatim. That keeps multi-tenancy, money-with-currency, immutability, and audit invariants intact.

---

## 1. Inventory snapshot (Church Plus side)

The recovered `custom_client_app` (live PROD HEAD `557f040`, plus the unmerged `6368834 Updated Structure`) contains these custom DocTypes that map roughly to features:

```
Member, Title, Family, Family Member
Chapter, Zone, Group
Church Service, Giving Type
Church Envelope, Online Giving, Online Giving Cart, Online Giving Stripe Price
Fundraising Campaign, Campaign Stripe Price,
Campaign Group Target, Campaign Chapter Target, Campaign Contribution
Bank Statement Upload, Bank Statement Import, Bank Statement Line,
Bank Statement Conflict, Bank Statement Transaction,
Paying Book Slip Allocation
Financial Target, Ministry Year
Custom Bank Account
(Apollo ICP Config — irrelevant; vendor-specific marketing)
```

Reports shipped:

```
Cash Reconciliation
Church Partnership Breakdown by Category
Church Partnership Breakdown by Month
Financial Target Balance
Individual Partnership Breakdown by Category
Individual Partnership Breakdown by Period
Individual Top Partner
Partnership by Church Groups
Top Family Report
```

API / utility modules with operational meaning:

```
api/campaign.py                 — fundraising campaign + stripe + reminders
api/online_giving.py            — public donation flow + cart + stripe
api/template_download_center.py — distribute Excel/PDF import templates
api/member_email_broadcast.py   — bulk email to verified members
api/member_email_verification.py — double opt-in verification flow
api/campaign_reminder.py        — scheduled campaign reminder send-outs
api/bulk_delete.py              — admin-only bulk row delete from listviews
api/data_import_utils.py        — normalisation helpers for legacy CSVs
utils/global_normalizer.py      — cross-doctype validate hook normaliser
utils/bulk_slip_import.py       — paying-in slip CSV/XLSX importer
utils/member_statement_generator.py — annual member statement PDF
overrides/bank_statement_processor.py — fuzzy member matching for imports
overrides/data_import.py        — custom Data Import behaviour
overrides/member.py             — member validations + giving_email_sent flag
overrides/church_envelope_bulk_import_val.py — envelope validation
overrides/user_permission.py    — chapter/group/zone permission cascades
```

Workspace / desk layout: production sidebar groups Home, Chapter Management, Chapter Details, Member Management, Member Records, Church Envelope Management, Church Envelopes, Campaign Management, Member Reports, Chapter Reports, Reports, Finance Management, Settings under module `Church Management`.

---

## 2. Capability matrix

### 2.1 Already covered in StewardLedger

These exist as equivalent primitives in StewardLedger and **do not need porting**. Listed so future readers don't re-port them.

| Church Plus | StewardLedger equivalent |
|---|---|
| `Member` DocType, ref codes | `members` (with `reference_code`, multi-tenant) |
| `Chapter`, `Zone`, `Group` | `chapters`, `zones`, `groups` (Phase 15) with composite cross-tenant FK guard |
| `Church Service` | `service_events` + `service_event_attendance` |
| `Giving Type`, `Giving Category` | `giving_types`, `giving_categories`, partnership flag (`has_partnership_target`) |
| `Church Envelope` (manual contribution capture) | `contribution_batches` + `contributions` with `source_type='envelope'` |
| `Bank Statement Upload/Import/Line/Conflict/Transaction` | `imports` pipeline (upload → match → schedule → commit/rollback) + `processed_transactions` idempotency |
| `Financial Target`, `Ministry Year` | `financial_targets` (chapter-scoped or zone-wide), `ministry_years` |
| `Paying Book Slip Allocation` | `paying_in_books` with reference-code range validation |
| `Member Statement`, partnership reports, top partner, top chapter, cash reconciliation, partnership progress | Phase 7 report suite (member-statement, partnership-progress, top-partners, top-chapters, online-giving-ledger, envelope-ledger, general-ledger, weekly-finance, audit-log, import-reconciliation, member-list, member-finance-summary, giving-by-chapter) |
| Bulk delete from list view (admin-only) | Tenant routes already enforce role gating; bulk delete affordance can be added per surface as needed |
| Bank statement fuzzy matching | `imports/match.ts` |
| Audit log of changes | `audit_events` + posted-immutability triggers + admin/zone audit surfaces |
| MFA / role-based access | Better Auth `twoFactor()` + per-zone `mfa_required_role_codes` |
| Data export bundle (GDPR) | `zone_exports`, `zone_export_jobs`, restore round-trip |
| Erasure / GDPR delete | `erasure_requests` with reversibility window + cron sweep |
| Reference code formats | `reference_code` configurable per zone |
| Period dimension | `giving_periods` table per zone |

### 2.2 To port — v1

Capabilities that StewardLedger should ship before GA (Phase 10). Each one is something a chapter or zonal treasurer will quickly notice the absence of.

#### 2.2.1 Family / household grouping

- **Church Plus**: `Family` + `Family Member` DocTypes, `Top Family Report`.
- **Why it matters**: pastors and treasurers regularly look at a household total (a family's combined partnership, a family's tithe), not just individual members. Used for pastoral visits, gift acknowledgement, and Top Family report.
- **StewardLedger today**: **Landed** on `feat/families-households` (Phase 10 GA exit-checklist item; see `docs/ROADMAP.md`).
- **Verdict**: **Port v1 — done.**
- **Implementation**:
  - Schema: `packages/db/src/schema/families.ts` (`families`, `family_members`), zone-scoped, soft-delete on `families`, archive-via-`left_at` on `family_members`. Composite cross-tenant FKs `(zone_id, chapter_id) → chapters(zone_id, id)`, `(zone_id, family_id) → families(zone_id, id)`, `(zone_id, member_id) → members(zone_id, id)`. Partial unique indexes enforce one open family per member and one primary contact per family. Drizzle migration `0024_families_and_family_members.sql` (+ paired `.down.sql`).
  - Service: `packages/api/src/services/families.ts` (create / update / soft-delete / member add / member archive / primary toggle / bulk transfer) + `services/family-codes.ts` for the `F{padded7}` reference code.
  - Tenant API: `/api/tenant/families` (list / detail / patch / delete) + `/api/tenant/families/:id/members` + `/api/tenant/families/:id/transfer` + `/api/tenant/members/:id/family` convenience.
  - Reports: `services/reports/top-family.ts` registered in `services/reports/registry.ts`; `services/reports/member-statement.ts` now carries `meta.household` and stamps a household band onto the Excel artefact.
  - UI: `/zone/families`, `/zone/families/[id]`, `/church/families`; household panel on `/zone/members/[id]`; household band on `/zone/members/[id]/statement`.
  - Audit events: `family.create`, `family.update`, `family.delete`, `family.member.add`, `family.member.update`, `family.primary_contact.set`, `family.member.remove`, `family.transfer`.
  - Tests: `packages/api/src/routes/tenant-families.test.ts` (16 cases incl. cross-tenant fuzz + composite FK guard), `packages/api/src/services/families.test.ts` (11 unit cases), `packages/api/src/services/families.schema.test.ts` (3 DB-level FK assertions), Top Family + member-statement-household-band tests added to `services/reports/reports.test.ts`.
  - Open question §5.3 (family granularity) answered: **household for v1** (one chapter, one address singleton, one open family per member). Kinship clusters remain a v2 concern.

#### 2.2.2 Bulk template download centre

- **Church Plus**: `api/template_download_center.py` + web page `template-download-center` distribute the exact Excel/CSV import templates expected by the importer (members, chapters, giving, envelope batch, etc).
- **Why it matters**: when a new chapter onboards, treasurers download the templates, fill them in, and re-upload. Without this, every new tenant calls support for the schema.
- **StewardLedger today**: importers exist (Phase 6) but there's no canonical "download an empty template" surface.
- **Verdict**: **Port v1.**
- **Suggested target**:
  - Service: `packages/api/src/services/imports/templates.ts` generating .xlsx via `exceljs` from the registered import parsers.
  - Route: `GET /api/tenant/imports/templates/:kind.xlsx`.
  - UI: link block on `/zone/imports` and `/church/imports`.

#### 2.2.3 Bulk slip / envelope import (XLSX/CSV)

- **Church Plus**: `utils/bulk_slip_import.py` ingests envelope CSV/XLSX in bulk, distinct from the bank statement import.
- **Why it matters**: chapters that still use physical paying-in books send batches of envelope rows on a spreadsheet. The bank statement pipeline is the wrong shape for this.
- **StewardLedger today**: `contribution_batches` exists for manual entry but no bulk upload path.
- **Verdict**: **Port v1.**
- **Suggested target**:
  - Parser: extend `packages/api/src/services/imports/parsers.ts` with an envelope-batch parser (zone + chapter + service event + member ref + giving-type rows).
  - Service: reuses the imports pipeline (`upload → match → schedule → commit`), but materialises a `contribution_batches`/`contributions` set instead of bank statement rows.
  - UI: `/church/imports` already exists; add an "Envelope batch" tab.

#### 2.2.4 Member email verification (double opt-in)

- **Church Plus**: `api/member_email_verification.py` with a verified/unverified flag; required by the campaign reminder and broadcast paths.
- **Why it matters**: anti-spam compliance for any future broadcast/comms feature. GDPR-aligned: only emails to verified members.
- **StewardLedger today**: nothing at the member level (Better Auth handles staff auth verification).
- **Verdict**: **Port v1.**
- **Suggested target**:
  - Schema: extend `members` with `email_verified_at` + `email_verification_token` (hashed) + `email_verification_status` ENUM.
  - Service: token issue / token verify / cancel / resend with rate limiting + `audit_events` rows.
  - Email template: useSend-rendered verification email.
  - Privacy note in `/zone/members/[id]` UI surface.

#### 2.2.5 Member statement PDF as bespoke layout

- **Church Plus**: annual member statement PDF (letter-style), via `utils/member_statement_generator.py`.
- **Why it matters**: this is the single most-printed document. The current `pdfkit` branded table is functional but doesn't read like a letter.
- **StewardLedger today**: member statement Excel + tabular PDF land in Phase 7. The bespoke layout is on the Playwright follow-up.
- **Verdict**: **Port v1** — promote from "deferred follow-up" to v1 GA blocker. Most legacy treasurers will judge the product on this single PDF.
- **Suggested target**:
  - Renderer: `packages/pdf/templates/member-statement.html` + Playwright route in `packages/api/src/services/reports/pdf/member-statement.ts`.
  - Branding inputs already exist on the report (`branding.ts`).

### 2.3 To port — v1.1

These add real value but are not GA blockers.

#### 2.3.1 Online giving (public donation flow)

- **Church Plus**: `api/online_giving.py`, `Online Giving Cart`, `Online Giving Stripe Price`, Stripe integration, public `Contribute` page.
- **Why it matters**: lets a chapter/zone accept online giving without a third-party processor frontend. A flagship public-facing feature.
- **StewardLedger today**: tenant `contributions` table accepts `source_type='online'`, but there's no public donation surface or Stripe integration yet.
- **Verdict**: **Port v1.1.** Significant scope: payment intent flow, webhook handling, idempotency, Stripe Connect per-zone account, currency handling, refund→reversal.
- **Suggested target**:
  - Phase: a new "**Phase 11.5 — Online giving**" between hardening and FX.
  - Schema: `online_giving_intents`, `stripe_prices`, `stripe_webhook_events`.
  - Route: public `GET /:zone/donate`, public `POST /api/public/online-giving/intent`.
  - Background worker: webhook reconciliation, retries, refund→reversal contributions.

#### 2.3.2 Fundraising campaigns

- **Church Plus**: `Fundraising Campaign`, `Campaign Stripe Price`, `Campaign Group Target`, `Campaign Chapter Target`, `Campaign Contribution`, campaign reminder cron.
- **Why it matters**: time-boxed asks (Christmas, building fund, missions) that are distinct from recurring partnership.
- **StewardLedger today**: nothing; `financial_targets` are partnership/ministry-year focused, not time-boxed campaigns.
- **Verdict**: **Port v1.1** (depends on online giving + comms).
- **Suggested target**:
  - Schema: `campaigns`, `campaign_targets` (chapter / group / zone scope), `campaign_contributions` (a tagged view over `contributions` instead of a separate ledger).
  - Reports: campaign progress, by-chapter, by-member.
  - UI: `/zone/campaigns`, `/church/campaigns`.
  - Reminder cron: pg-boss job with throttled email send.

#### 2.3.3 Member email broadcast + reminders

- **Church Plus**: `api/member_email_broadcast.py`, `api/campaign_reminder.py`.
- **Why it matters**: send a chapter-scoped or zone-scoped message to verified members; remind campaign contributors.
- **StewardLedger today**: transactional email via useSend; no broadcast UI.
- **Verdict**: **Port v1.1** (after member verification lands in v1).
- **Suggested target**:
  - Schema: `email_broadcasts`, `email_broadcast_recipients`, `email_broadcast_events`.
  - Worker: queued send with per-zone rate limiting.
  - UI: `/zone/broadcasts` admin-only; preview + dry-run mandatory.

#### 2.3.4 Custom bank accounts per chapter

- **Church Plus**: `Custom Bank Account` DocType — per-chapter bank reference for slip allocation and reconciliation.
- **Why it matters**: chapters that run multiple bank accounts (e.g. main + missions) need their import streams labelled.
- **StewardLedger today**: `accounts` exist as funds, not as bank accounts.
- **Verdict**: **Port v1.1.**
- **Suggested target**:
  - Schema: `bank_accounts` (zone, chapter?, currency, IBAN, sort code, account number) — strictly metadata; no API access to actual banking.
  - Linked from `imports` rows and `contribution_batches`.

### 2.4 To port — v2

#### 2.4.1 Cross-doctype validation normaliser

- **Church Plus**: `utils/global_normalizer.py` is wired into every doctype `validate` hook to normalise case, whitespace, phone numbers, etc.
- **Why it matters**: legacy data is messy; without normalisation, dedup heuristics misfire.
- **StewardLedger today**: per-route normalisation only.
- **Verdict**: **Port v2.** We already have Zod at the boundary doing most of this. Worth revisiting if dedup recall drops.

#### 2.4.2 Apollo / Marketing automation hooks

- **Church Plus**: `Apollo ICP Config`, client scripts to hide elements; LinkedIn / Expandi server scripts in the latest `6368834`.
- **Why it matters**: it doesn't, for church finance.
- **Verdict**: **Drop.**

#### 2.4.3 KingsChat integration

- **Church Plus**: KingsChat username on Member; mentioned in shared `schemas.ts:517`.
- **Why it matters**: church-specific social ID; pastoral comms surface (future).
- **Verdict**: **Port v2** as opt-in metadata only; integration TBD.

### 2.5 Explicitly drop

| Capability | Reason |
|---|---|
| Stored-procedure business logic | Already on the do-not-port list (DOMAIN-REFERENCE §5). |
| Bitbucket-stored backup files (`*.backup`, `*.v2`, `*.old`) | Source-control noise; never the source of truth. |
| Apollo / Expandi / LinkedIn marketing automation | Not church finance scope. |
| Dynamic SQL pivot in reports | Replaced by app-side pivot. |
| Single-tenant deployment shape | StewardLedger is multi-tenant from day one. |
| `=7.0.0` accidental requirement artifact | Already documented in ChurchPlus side. |
| Workspace JSON fixtures as the source of truth for sidebar | StewardLedger composes navigation from role bindings, not JSON fixtures. |
| `Apollo ICP Config` DocType | Marketing-vendor specific. |

---

## 3. Suggested roadmap edits

If you accept the above, ROADMAP.md changes are minimal:

1. **Phase 7 (current focus)**: promote bespoke member-statement PDF from "Playwright follow-up" to a Phase 7 GA blocker. (Section 2.2.5 above.)
2. **Phase 10 — Billing & GA**: add three exit-checklist items before sign-off:
   - Family / household grouping (§2.2.1)
   - Bulk template download centre (§2.2.2)
   - Bulk slip / envelope import (§2.2.3)
   - Member email verification (§2.2.4)
3. **Phase 11 — Hardening (v1.1)**: insert as new bullets:
   - Online giving + Stripe Connect (§2.3.1)
   - Fundraising campaigns (§2.3.2)
   - Member email broadcast + reminders (§2.3.3)
   - Custom bank accounts per chapter (§2.3.4)
4. **Beyond**: leave §2.4 items in the v2 / backlog bucket.

These edits keep ROADMAP.md's existing structure intact and slot in concrete work items.

---

## 4. Source artifacts referenced

- `/home/bryan/workspace/churchplusv2/consolidated/apps/custom_client_app/custom_client_app/custom_client_app/` — recovered live PROD source for `custom_client_app`.
- `/home/bryan/workspace/churchplusv2/consolidated/.archive/custom_client_app.git/` — read-only sidecar of upstream Bitbucket history.
- Live PROD HEAD at time of writing: `557f040 Updated Email Options`. Unmerged top commit on `main`: `6368834 Updated Structure` (mostly backup-file cleanup + dev placeholders + fixture re-export noise; one meaningful change to the `Member List View Styling` client script).
- This document does **not** depend on the upstream PHP/EFCore Church Plus codebase referenced by `DOMAIN-REFERENCE.md`; it is scoped to the Bitbucket `custom_client_app` only.

---

## 5. Open questions

1. **Do any current Church Plus tenants want to migrate?** If yes, ETL needs to land before §2.3 work (and DOMAIN-REFERENCE §1 ETL plan needs to be promoted).
2. **Online giving regulatory posture.** Each region has its own rules (UK Gift Aid, US 501(c)(3) acknowledgements, Nigerian VAT). The §2.3.1 schema should leave room for region-specific receipts.
3. ~~**Family model granularity.** Is "family" a household (one address) or a kinship cluster (can span addresses)? Recommend household for v1, kinship in v2.~~ **Resolved**: shipped as a chapter-scoped household in `feat/families-households`. Kinship clusters remain a v2 concern.
4. **Comms throttling defaults.** What per-zone send rate caps do we want by default? Recommend 100/hour for v1.1, configurable per zone, MFA-required to raise.
