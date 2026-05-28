# Roadmap

> Companion to [`PRD.md`](PRD.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`DOMAIN-MODEL.md`](DOMAIN-MODEL.md).
>
> The roadmap is in **phases**, not in calendar weeks. Each phase has explicit deliverables and an exit checklist. We move on when the checklist is green.
>
> Product name: **StewardLedger**. Primary domain: **`stewardledger.church`**.
> Tenant model: **the zone is the tenant**. Region is platform-curated reference data; Groups are an optional per-zone tier between Zone and Chapter (Phase 15, `feat/groups-hierarchy`).

---

## Phase 0 — Pre-build

Goals: lock down the baseline so the build doesn't drift.

Deliverables:

1. Register `stewardledger.church`, `stewardledger.com`, `stewardledger.app`, `stewardledger.io` (defensive).
2. Trademark search (US USPTO, UK IPO, EU EUIPO; classes 9 + 36) and file if clear.
3. Reserve `stewardledger` GitHub org / npm scope. Reserve social handles (X, LinkedIn, Instagram).
4. Brand kit (logo + palette + typography) — at least a working version. Mirrors the echurcher pattern.
5. Pricing page draft (per-zone flat fee, Founding / Standard / Premium tiers, annual prepay default).
6. New GitHub repo `tickideas/stewardledger`. Proprietary licence.
7. CI pipeline skeleton (lint + typecheck + test stubs).
8. Dokploy staging app + DNS records `*.stewardledger.church`, `api.stewardledger.church`, `demo.stewardledger.church`.

Exit checklist:

- [ ] All four domains registered and DNS in place.
- [ ] Trademark search completed; filing decision made.
- [ ] Repo created with monorepo skeleton (mirroring echurcher).
- [ ] CI green on a no-op commit.
- [ ] Dokploy staging app created and reachable on a placeholder.
- [ ] Specific price points for Founding / Standard / Premium signed off.

---

## Phase 1 — Foundations

Goals: scaffolding, auth, tenant resolution, the empty shell of every screen.

Deliverables:

- `apps/api` Hono app with health endpoints and Zod-validated route helpers.
- `apps/web` SvelteKit app with shell layout, dashboard skeleton, login.
- `packages/db` Drizzle schema for **identity, regions, zones, chapters, roles** + first migration.
- `packages/shared` initial Zod schemas + money/date utilities.
- Better Auth integrated (email + password, email OTP, magic link).
- Multi-tenant middleware (host → zone resolution).
- Role-based access middleware.
- Session expiry banner.
- Branded transactional email via useSend (welcome, OTP, password reset).
- Audit log table + write helper.
- `pg-boss` queue plumbing.
- Dockerfiles + `docker-compose.yml` + `docker-compose.prod.yml`.

Exit checklist:

- [x] A new zone can be created via a seed script.
- [x] An owner user can log in via OTP and magic link.
- [x] Subdomain resolution works against the dev box (`{slug}.localhost`).
- [x] Wildcard cert in staging.
- [x] Audit row written for every successful login.
- [x] CI runs unit tests + Drizzle migration tests.
- [x] Lighthouse mobile score ≥ 90 on the empty dashboard.

---

## Phase 2 — Onboarding & tenancy

Deliverables:

- Public marketing site landing page with sign-up CTA.
- **Public demo zone** (`demo.stewardledger.church`) seeded with realistic sandbox data; nightly reset job. Current local/demo tooling seeds three realistic demo zones (`demo-grace-uk`, `demo-lighthouse-us`, `demo-river-ng`) via `pnpm seed:demo -- --reset`.
- **Closed onboarding (current v1 behaviour):** StewardLedger is invitation-only — no public signup form. A platform admin uses `/admin/zones` → *Invite zone* to create the tenant and email the primary contact a `zone_owner` invitation (see `docs/ARCHITECTURE.md` §12.2 and the *Invite / resend / revoke* endpoints under `/api/admin/zones/...`). The Stripe self-service path is **deferred to Phase 10** and re-evaluated there.
  - Admin-issued invite captures: zone name, country, time zone, default currency, primary contact, region (typeahead or free-text).
  - StewardLedger team confirms plan tier and pricing out-of-band.
  - Zone is provisioned in `pending_setup` with default seeds; flips to `active` on owner accept.
  - Region selection: typeahead on existing regions; free-text fallback (creates `region_name_unverified`).
  - Owner accepts via `/invite/[token]`, sets a password, and walks through guided onboarding (chapters, members, first envelope batch).
  - Plan picked: Founding / Standard / Premium. Billing: invoice / bank transfer for the founding cohort; Stripe added in Phase 10.
- Zone settings (name, branding, default currency, time zone, fiscal year start).
- Chapter CRUD with reference-code generator (configurable format; legacy-style default).
- Chapter name history captured automatically.
- Per-chapter settings (`/church/settings`): chapter card, banking details (stored in `chapters.metadata.banking`), roster of bound users with revoke + self-lockout guard, scoped invitation management for `chapter_admin`s, and chapter batch templates for the Sunday-close flow (deep-link prefill from `/zone/contributions/batches/new?templateId=`).
- Invite users via email with role selection (zone-level or chapter-level) from `/zone/administrators`, and optionally send chapter-admin invitations while adding a chapter.
- Manage active user role bindings within the zone, including zone-admin revocation with a self-lockout guard.
- Custom domain attach (CNAME-based; gated to paid plans).
- **Platform admin**: regions reference list CRUD, unverified region inbox, and a super-admin zones dashboard (`/admin/zones`) with searchable/cursor-paginated tenants, chapter/member counts, and per-currency posted contribution subtotals.

Exit checklist:

- [x] Admin-issued zone invitation works end-to-end: `POST /api/admin/zones/invite` creates a `pending_setup` zone with a `zone_owner` invitation (covered by `signup.test.ts` for the service and `admin.test.ts` for the route).
- [x] Admin can resend or revoke a pending zone-owner invitation from `/admin/zones/[slug]` (covered by `admin.test.ts`).
- [x] A free-text region submitted at invite time appears in the platform-admin inbox (`GET /api/admin/regions/inbox`).
- [x] Super-admins can inspect all active zones from `/admin/zones`; platform-only super-admins with no tenant bindings land there after login.
- [x] Chapter admins can edit banking details, manage their roster, scope-invite teammates, and curate batch templates from `/church/settings`; tenant API enforces the chapter clamp regardless of payload (`tenant.test.ts` covers the cross-zone 404, cross-chapter 403, self-lockout 409, and the batch-template create / duplicate / role-bucket paths).
- [x] Demo seed data can be reset locally with `pnpm seed:demo -- --reset`; `create-admin` / `make-super-admin --confirm` bootstrap demo operator access.
- [x] Owner can add chapters and invite users (`POST /api/tenant/chapters`, `POST /api/tenant/invitations`), including chapter-scoped invitations during chapter creation.
- [ ] Custom domain verification flow works against a real DNS (paid plan only; deferred, not blocking Phase 4).
- [x] Two zones in the same Postgres DB cannot see each other's data (cross-tenant fuzz tests pass — 12 cases in `tenant.test.ts`).

---

## Phase 3 — Members

Deliverables:

- Member CRUD (full field set, with `metadata jsonb` for legacy/future extras).
- Address management.
- Title / marital status / member type lookups (per zone, with sensible seeds).
- Member bulk import (CSV + XLSX) reusing the import pipeline (Phase 6).
- Member bulk export (CSV + XLSX).
- Duplicate detection views (by name, by name+chapter, by name with diff chapter, invalid characters).
- Merge proposal queue + apply flow.
- Member dashboard.

Exit checklist:

- [ ] Bulk import 5000 rows under 60 seconds (deferred to Phase 6 alongside the flagship import pipeline).
- [ ] Duplicate detection finds the same dups as a hand-curated test dataset (deferred to Phase 6; the schema and apply-merge flow are in place).
- [x] Merge applies and audit log shows every reassignment (manual proposals via `/api/tenant/members/merge/{proposals,apply}`, address-reassignment + soft-delete + audit verified by `tenant-members.test.ts`).
- [x] No member can be hard-deleted (`DELETE /api/tenant/members/:id` soft-deletes via `deleted_at`; merge apply soft-deletes the absorbed row; route layer never issues a SQL `DELETE` against `members`).

---

## Phase 4 — Giving setup & periods

Deliverables:

- Giving categories (with parent/child).
- Giving types.
- Payment methods.
- Accounts (with optional currency override per account).
- Giving-type-to-account mappings.
- Service types.
- Service events (manual create, calendar view).
- Periods (giving / fiscal / ministry / partnership) seeded for current year on zone creation.

Implementation notes:

- Tenant API routes are in place for giving categories, giving types, payment methods, accounts, service types, and service events under `/api/tenant/giving/*`.
- Zonal admins manage giving categories, giving types, and service types from `/zone/giving-settings`; chapter admins can add giving types from `/church/settings`, with the resulting rows remaining zone-scoped for reporting consistency.
- Chapter settings now includes service-event creation and per-event attendance capture. Service attendance stays optional, but when recorded it is stored against `service_event_attendance`.

Exit checklist:

- [x] Seed scripts create a full year of `giving_periods` for a new zone in <5 seconds (`period-seed.test.ts` asserts the budget — picked to absorb CI-runner / cold-start variance; full-year seed runs comfortably under 1s on a warm test DB).
- [x] Period auto-derivation works on a test set of arbitrary dates (`period-seed.test.ts` covers Jan 1, end-of-Q1 Sunday, mid-Q3 Tuesday, ISO-week-52 Sunday, and the Dec-31-belongs-to-next-ISO-year edge case).
- [x] Account currency defaults from the zone, with override support for foreign-currency accounts (`accounts.currency_code` defaults from the zone in the API layer — `tenant-giving.test.ts`).
- [x] Contribution + batch schema permits overriding `currency_code`, and a database trigger keeps each line aligned with its parent contribution's currency (`contributions.test.ts`).
- [x] Service layer defaults `contribution.currency_code` from the zone when callers omit it; mismatched-currency contributions cannot be attached to a batch, enforced on attach and at batch-post time (`createContribution`, `postBatch`; `contributions-service.test.ts` and `tenant-contributions.test.ts`).

---

## Phase 5 — Contributions (manual + envelope batch)

Deliverables:

- Contribution batch screen (treasurer's Sunday close):
  - pick service event
  - add contribution rows for members
  - split by giving type
  - cash/cheque totals
  - submit/approve/post
- Contribution detail page.
- Edit (audit-logged) and post.
- Void with reason.
- Reverse with linked corrected contribution.
- Member statement preview.

Implementation notes:

- DB layer (`contribution_batches`, `contributions`, `contribution_lines`, `contribution_members`) is in place with composite `(zone_id, id)` cross-tenant FKs and posted-immutability triggers (`packages/db/src/schema/contributions.ts`, `packages/db/src/bootstrap-triggers.ts`). Triggers are applied via `pnpm --filter @stewardledger/db db:bootstrap`, which `test:db:push` now runs automatically.
- Service + tenant API layer for contributions and batches is in place (`packages/api/src/services/contributions.ts`, `packages/api/src/services/contribution-batches.ts`, `packages/api/src/routes/tenant-contributions.ts`). Endpoints: `GET/POST/PATCH/DELETE /api/tenant/contributions(/:id)`, `POST :id/{post,void,reverse}`, `GET/POST/PATCH /api/tenant/contribution-batches(/:id)`, `POST :id/{submit,approve,post,void}`.
- Contribution batch creation now requires a service event for every role, including zone admins. Draft batch updates may change the event but cannot clear it.
- Reversals follow the negative-amount sign convention (see `docs/DOMAIN-MODEL.md` §6 "Sign convention").
- Treasurer SvelteKit UI is in place under `/contributions` (`packages/web/src/routes/contributions/`): batches list with chapter + status filters, new-batch form (chapter / service event / payment method / source), batch detail with inline add-row form (member typeahead, multi-line giving-type splits, cash + cheque totals) and submit / approve / post / void actions, contribution detail with post / void / reverse / delete-draft, and a member statement preview at `/members/[id]/statement` (per-currency totals; reuses `GET /api/tenant/contributions?memberId=…&dateFrom=…&dateTo=…`).

Exit checklist:

- [ ] A treasurer can record a Sunday batch in under 5 minutes for a 30-member service. *(SvelteKit UI in `packages/web/src/routes/contributions/batches/[id]/+page.svelte` is built — server-side member typeahead with stale-result protection, multi-line splits, persistent date/source, Tab + Enter row submission, sign-convention guards. Member-resolution rules are unit-tested in `packages/web/src/lib/contributions/member-selection.test.ts` (9 cases). Still pending before this can be ticked: a Playwright happy-path spec covering new-batch → add 30 rows → submit → approve → post, plus a real 30-member timed run on staging.)*
- [x] Posted contributions are immutable; the immutability is enforced at the DB level (triggers `contributions_posted_guard`, `contributions_no_delete_when_posted`, `contribution_lines_posted_guard`; verified by `contributions.test.ts`).
- [x] Service-layer state machine: draft → posted, posted → voided / reversed; reversal emits a corrective contribution with negated amounts (`contributions-service.test.ts`, `tenant-contributions.test.ts`).
- [ ] Member running totals match per-member sum across all sources. *(Reports land in Phase 7. The Phase 5 statement preview at `/members/[id]/statement` already groups posted contributions by currency over a date window.)*
- [x] Mixed-currency batches are forbidden — a batch is single-currency; the service layer rejects mismatched attaches and re-checks at batch-post time. The UI inherits the single-currency invariant by inserting every row at the batch's `currencyCode`.

---

## Phase 6 — Imports pipeline (flagship)

Deliverables:

- Import file upload (CSV in Phase 6; XLSX deferred until a hardened parser lands) with checksum + storage in object storage.
- Background `import.parse` job populating `import_rows`.
- Background `import.match` job filling member / chapter / giving type / period.
- Failure catalog + per-row failure capture.
- Schedule (preview before commit).
- Atomic commit job posting validated rows into contributions.
- Re-upload duplicate detection.
- Bank-format pluggable parsers (CSV first, then bank-specific).
- Import dashboard: statement-import history, status, downloadable CSV templates, chapter-scoped upload, row preview, commit, rollback. Member, target, setup, retry, and inline row-fix flows are deferred to Phase 6 polish.
- Replay-friendly: a job can be re-run safely; idempotency keys per row.

Implementation notes:

- Schema (`packages/db/src/schema/imports.ts`): `import_files`, `import_jobs`, `import_rows`, `import_row_failures`, `import_failure_types` (platform-default catalog + per-zone overrides, split partial unique indexes so the platform catalog is race-safe), `import_schedules` (partial unique on (zone, job) where committed_at and rolled_back_at are null — only one active schedule per job), `processed_transactions`. Composite `(zone_id, id)` FKs across the board.
- Object storage adapter at `packages/api/src/services/storage.ts` ships an FS backend by default (`STORAGE_ROOT`, anchored at repo root); S3 / R2 / B2 are a one-class swap. Storage keys are tenant-scoped: `{zoneId}/imports/{yyyy}/{mm}/{fileId}-{sha8}.{ext}`. Path resolution uses the same `resolve + startsWith(root + sep)` guard pattern as `db:bootstrap`'s ENV_FILE check.
- Pluggable parsers in `packages/api/src/services/imports/parsers.ts` cover CSV (RFC4180 via papaparse, UK/ISO date handling, bracketed-negative + currency-symbol tolerant) with parser-level row/column/cell caps; XLSX imports are intentionally disabled until StewardLedger ships a hardened parser. Header aliasing means a bank statement only needs the obvious labels.
- Pipeline orchestration in `packages/api/src/services/imports/index.ts`: `uploadImport` → `runImportJob` → `scheduleImport` → `commitImport` → `rollbackImport`. Upload metadata + bytes are persisted in a short tx; parse/match run synchronously outside that tx for Phase 6; row/failure persistence plus the final `matched` status update commit atomically in a second tx. pg-boss wraps `runImportJob` later without service-layer changes.
- Concurrency safety: every lifecycle transition (`received→parsing`, `matched→scheduled`, `scheduled→committing`, `committed→rolled_back`) is a conditional UPDATE — the WHERE clause filters by current status, so two parallel callers cannot both succeed. The upload path races on the split chapter-aware checksum/source partial unique indexes and falls back to the reuse branch on 23505. `storage().put` happens after the file row is inserted; if a later DB write rolls back, the service best-effort deletes the orphaned object because object storage is not transactional.
- Bulk commit: the commit path uses bounded-size chunked writes (insert drafts → insert lines → bulk-promote to posted → insert processed_transactions → backfill import_rows.contribution_id via chunked `UPDATE … FROM (VALUES …)`). Round trips scale by chunks rather than rows, and each statement stays below Postgres' bind-parameter ceiling. Audit emits `contribution.create` + `contribution.post` per row, mirroring Phase 5.
- Tenant API at `/api/tenant/imports[/:id][/rows|/schedule|/commit|/rollback]` (`packages/api/src/routes/tenant-imports.ts`). Phase 6 accepts statement CSV imports only; unsupported file types fail with `unsupported_file_type` until their dedicated strategies exist. Chapter scope is enforced at every endpoint: a `CHAPTER_TREASURER` bound to Chapter A cannot upload, read, schedule, commit, or roll back jobs tied to Chapter B (or zone-wide jobs with `chapter_id IS NULL`). Bookkeepers upload + read; treasurers / finance admins schedule, commit, and roll back.
- SvelteKit dashboard at `/imports` (list + upload) and `/imports/[id]` (summary stats, row preview with per-row failures, action buttons). The zone upload screen exposes a zone-wide CSV template with a `chapter` column for zone writers, while chapter-scoped uploaders get a chapter template without that column. Upload uses the canonical `PUBLIC_API_URL` from `$lib/env` (the pre-review code's `VITE_PUBLIC_API_URL` typo silently broke split-host production deploys).
- Idempotency: re-uploading the same bytes returns the existing job (file-level), and the matcher flags rows whose `external_transaction_id` is already in `processed_transactions` (row-level). Commit skips duplicates; rollback voids the committed contributions, snapshots the freed external ids into the audit `after` payload, and deletes the `processed_transactions` rows so a corrected re-upload can replace them.

Exit checklist:

- [x] One canonical statement file imports end-to-end into contributions atomically (`imports.test.ts` "uploads, matches, schedules, commits…").
- [x] Failed rows are listed with machine-readable reasons in the dashboard; manual correction currently means fixing the source CSV and re-uploading. Human-readable failure descriptions plus inline row-fix endpoint/UI are deferred to Phase 6 polish.
- [x] A second upload of the same file produces zero new contributions (full idempotency via `processed_transactions`; covered by the "re-uploading new bytes with already-seen external ids" test).
- [x] An import job can be rolled back; the audit log shows the rollback (`rollbackImport` writes `import.rollback` + per-contribution `contribution.void` events; verified by the "rolls back a committed job" test).

---

## Phase 7 — Reports v1

Deliverables (full list in [`REPORTS.md`](REPORTS.md)):

- Member statement (annual, period; PDF + Excel; branded). *(Excel + PDF landed; bespoke letter-style PDF deferred until Playwright lands.)*
- Member finance summary (range; pivot by giving type). *(Excel + PDF landed.)*
- Giving by chapter / zone / period / category / giving type (PIVOT in app code). *(Excel + PDF landed; pivots by giving type, category, or month with optional ministry / partnership year clamps.)*
- General ledger (giving). *(Excel + PDF landed; flat line-level ledger with chapter / account / giving type / payment method / source filters.)*
- Envelope ledger. *(Excel + PDF landed; one row per posted envelope contribution with rolled-up line breakdown.)*
- Online giving ledger. *(Excel + PDF landed; preset on `source_type in ('online','bank_import')` with transaction-id column.)*
- Top partners, top chapters. *(Excel + PDF landed; per-currency ranking with `topN` (default 20) and `partnershipOnly` toggle.)*
- Audit log report. *(Excel + PDF landed; reads `audit_events`; admin-only access — owner / admin / finance_admin only, viewer roles denied.)*
- Partnership progress. *(queued; depends on Phase 8 targets)*
- Weekly finance report. *(Excel + PDF landed; reads `service_events` joined with the new `service_event_attendance` sibling table, rolls up per-event cash / cheque / line totals per currency.)*
- Statement import reconciliation report. *(Excel + PDF landed.)*
- Member list (active, by chapter, by status). *(Excel + PDF landed.)*
- Saved filters. *(Personal-per-user named filter bundles per report, persisted in `saved_report_filters` (migration 0009). CRUD under `/api/tenant/reports/:id/saved-filters[/:filterId]`; the per-report UI at `/zone/reports/[id]` surfaces a pill picker + inline "Save current filters as…" form. Payloads re-validate against each report's existing Zod filter schema on write. Per-row audit (create / update / delete). Cross-user + cross-tenant isolation tested.)*
- Background `report.generate` jobs with email-when-ready. *(Landed. `report_jobs` table; endpoints `POST /api/tenant/reports/:id/jobs`, `GET /api/tenant/reports/jobs[/:jobId][/download]`. pg-boss-backed worker (`services/queue.ts` + `services/reports/jobs-pgboss.ts`) replaces the original in-process polling loop; the route contract is unchanged. `services/reports/email.ts` sends a branded success / failure mail through the existing `usesend` adapter and stamps `email_sent_at` for idempotency. `services/reports/cleanup.ts` runs as a daily pg-boss schedule (03:00 UTC), drops expired artefact blobs, and flips the row to `status='expired'` (kept for audit; download returns 404). A boot-time sweep recovers any `queued` rows orphaned by a crash between `INSERT` + `boss.send`. Single Drizzle migration `0017_report_jobs_pr2.sql` adds `email_sent_at` + the `expired` status check.)*

Implementation notes:

- The report pattern lives at `packages/api/src/services/reports/`. Each report is a `ReportSpec<F, R>` (`types.ts`) — a Zod filter schema, a `fetch` that returns rows + per-currency subtotals, a `columns()` projection used by both the screen and exports, and per-format renderers. The registry (`registry.ts`) exposes a flat list to `/api/tenant/reports`; adding a report is one spec + one registry entry.
- Money is always grouped by currency. The `CurrencySubtotal` shape is consistent across reports, and the helper in `member-statement.ts` is the canonical pattern for new reports. No silent FX in v1 (DOMAIN-MODEL.md §6).
- Role gating: `services/reports/access.ts` enforces read vs export tiers. Viewers (zone_auditor / zone_pastor_viewer) can READ on screen but cannot DOWNLOAD an Excel artefact; finance + treasurer roles can export. Spec-level `accessCheck` adds row-level scope (e.g. `member-statement` denies a chapter treasurer asking for a member outside their bindings).
- Branding: `loadReportBranding` pulls the zone's name + country + default currency and `addBrandedSheet` stamps a frozen 4-row branded header onto every Excel artefact.
- Tenant routes at `/api/tenant/reports[/:id/data|/:id/export.xlsx]` (`packages/api/src/routes/tenant-reports.ts`). Filters arrive as query params so a treasurer can bookmark a URL and re-run the same report.
- SvelteKit UI at `/reports` (picker) and `/reports/[id]` (filter form + table + Excel download). The per-report shell is metadata-driven from `columns()` so adding a report on the API lights it up here without UI changes.

Audited implementation status (2026-05-13):

- [x] Report registry / tenant routes / generic Svelte report UI are in place (`packages/api/src/services/reports/{registry,types}.ts`, `packages/api/src/routes/tenant-reports.ts`, `packages/web/src/routes/zone/reports/`).
- [x] Member statement data + Excel export are implemented and tested (`member-statement.ts`, `reports.test.ts`, `tenant-reports.test.ts`).
- [x] Member finance summary data + Excel export are implemented and tested (`member-finance-summary.ts`, `reports.test.ts`, `tenant-reports.test.ts`).
- [x] Statement import reconciliation data + Excel export are implemented and tested (`import-reconciliation.ts`, `reports.test.ts`).
- [x] Member list data + Excel export are implemented and tested (`member-list.ts`, `reports.test.ts`).
- [x] Giving by chapter (PIVOT by giving type / category / month) data + Excel export are implemented and tested (`giving-by-chapter.ts`, `reports.test.ts`).
- [x] General ledger (giving) data + Excel export are implemented and tested (`general-ledger.ts`, `reports.test.ts`).
- [x] Envelope ledger data + Excel export are implemented and tested (`envelope-ledger.ts`, `reports.test.ts`).
- [x] Online giving ledger data + Excel export are implemented and tested (`online-giving-ledger.ts`, `reports.test.ts`).
- [x] Top partners + top chapters data + Excel exports are implemented and tested (`top-partners.ts`, `top-chapters.ts`, `reports.test.ts`).
- [x] Audit log report data + Excel export are implemented and tested (`audit-log.ts`, `reports.test.ts`).
- [x] Zone dashboard endpoint + UI are implemented and tested (`services/dashboards/zone-dashboard.ts`, `routes/tenant-dashboard.ts`, `routes/zone/dashboard/+page.svelte`).
- [x] Chapter dashboard endpoint + UI are implemented and tested (`services/dashboards/chapter-dashboard.ts`, `routes/tenant-dashboard.ts`, `routes/church/overview/+page.svelte`).
- [x] Weekly finance report data + Excel export are implemented and tested (`weekly-finance.ts`, `reports.test.ts`); attendance lives in `service_event_attendance` (migration `0002_hesitant_human_robot.sql`).
- [x] PDF export infrastructure (`pdfkit`-based generic branded-table renderer at `services/reports/pdf/branded-table.ts`; `GET /api/tenant/reports/:id/export.pdf` route; UI "Download PDF" alongside "Download Excel").
- [ ] **Bespoke letter-style member statement PDF (GA blocker).** Promoted from "Playwright follow-up" because the annual member statement is the single most-printed document and treasurers will compare it line-for-line to the legacy letter. Playwright + HTML/CSS template at `packages/pdf/templates/member-statement.html`, rendered via `packages/api/src/services/reports/pdf/member-statement.ts`, branding inputs reused from `services/reports/branding.ts`. See [`CHURCHPLUS-PORT-NOTES.md` §2.2.5](CHURCHPLUS-PORT-NOTES.md#225-member-statement-pdf-as-bespoke-layout).
- [ ] Bespoke partnership receipt PDF (post-GA follow-up; not blocking).
- [x] Saved filters.
- [x] Background `report.generate` worker + object-storage retention for large exports. *(pg-boss-backed worker + email-when-ready + daily expiry-cleanup job all landed.)*

Exit checklist:

- [x] Each v1 report ties out against a hand-curated test dataset. *(All 14 v1 reports — member-statement, member-finance-summary, import-reconciliation, member-list, giving-by-chapter, general-ledger, envelope-ledger, online-giving-ledger, top-partners, top-chapters, audit-log, weekly-finance, partnership-progress — covered in `reports.test.ts`.)*
- [x] All exports work in Excel and PDF. *(Generic `pdfkit`-based renderer at `services/reports/pdf/branded-table.ts` backs every shipped report; bespoke letter-style layouts are tracked separately on the Playwright follow-up.)*
- [ ] Reports of >100k rows stream/paginate, never time out. *(queued; the registry shape supports paginated `fetch` already.)*
- [x] Multi-currency reports show per-currency subtotals (no silent FX). *(`CurrencySubtotal[]` returned by every spec; reports never call `addMoney` across currencies.)*

---

## Phase 8 — Targets & partnership *(current focus)*

Deliverables:

- Financial target setup per chapter + giving type + ministry year. *(Schema, CRUD API, and `/zone/targets` UI landed.)*
- Optional zone-wide targets that aggregate across chapters. *(Supported by the partial unique indexes on `financial_targets`; `chapter_id IS NULL` = zone-wide.)*
- Paying-in book reference ranges. *(Schema, tenant API, validation hook, and `/zone/paying-in-books` UI landed.)*
- Partnership progress dashboard. *(Standalone `/zone/partnership-progress` dashboard landed; zone/chapter dashboard cards now summarize current ministry-year target progress by currency.)*
- Top partners by category and by month. *(Partnership-progress report covers target progress by partnership-tagged giving type; member-level monthly/category pivots remain queued.)*

Audited implementation status:

- [x] `financial_targets` schema + Drizzle migration (`0004_little_mad_thinker.sql`) with partial unique indexes for chapter-scoped vs zone-wide rows + non-negative money / count CHECKs.
- [x] Tenant API `/api/tenant/targets` with role-aware read/write (zone finance admin or chapter admin only writes; treasurers read but cannot write).
- [x] Partnership-progress report (REPORTS.md §2.10, `services/reports/partnership-progress.ts`) — consumes `financial_targets` joined with partnership-tagged giving types; Excel + PDF auto-render via the established renderers.
- [x] `paying_in_books` schema + Drizzle migration (`0005_shiny_micromacro.sql`); tenant API `/api/tenant/paying-in-books` with role-aware read/write.
- [x] Reference-code range validation at contribution-batch create + update (`services/paying-in-books/validate.ts`); rejects with `reference_code_not_in_book` → 422.
- [x] UI: paying-in book setup at `/zone/paying-in-books` (list + filter + create + edit + delete with role-aware write gating).
- [x] UI: target setup at `/zone/targets` (filters, pagination, create / edit / delete with role-aware write gating).
- [x] UI: standalone partnership progress dashboard at `/zone/partnership-progress` (ministry-year / chapter / giving-type filters, progress bars, Excel export link).
- [x] Zone and chapter dashboard cards consume target progress via `services/dashboards/partnership-progress.ts`, with zone cards summarizing zone-wide targets when present (otherwise chapter-scoped targets) and chapter cards summarizing that chapter only.

Exit checklist:

- [x] Targets feed into reports and dashboards. *(Partnership-progress report, standalone partnership dashboard, and main zone/chapter dashboard cards consume `financial_targets`.)*
- [x] Reference-code ranges validate during contribution entry. *(Validator fires from `createBatch` + `updateDraftBatch` when a `referenceCode` is supplied.)*

---

## Phase 9 — Audit, exports, retention, MFA

Deliverables:

- Platform-admin management UI at `/admin/administrators`. *(Landed: super-admin can invite a new platform admin (POST `/api/admin/administrators/invite` → email with magic link → POST `/api/public/platform-invitations/accept` to set a password), grant a role to an existing user by email, revoke individual roles, and promote/demote the super-admin bit. Refuses demoting the only remaining super-admin (`last_super_admin` 409). New schema: `platform_invitations` and a nullable `audit_events.zone_id` with a CHECK that `platform.*` actions have NULL zone_id while everything else stays tenant-scoped.)*
- Per-zone audit search. *(UI landed at `/zone/audit`; reuses `/api/tenant/reports/audit-log/data` so search + Excel/PDF export stay aligned. Admin-only — zone owner / admin / finance admin; viewer + chapter roles denied. See `packages/web/src/routes/zone/audit/+page.svelte` and the access predicate at `packages/web/src/lib/audit/access.ts`.)*
- Per-zone data export bundle (Postgres dump + uploaded files + reports archive). *(Landed: `zone_exports` schema, zone-scoped table registry with FK-order coverage test, streamed `tar.gz` bundle generator under a REPEATABLE READ snapshot, owner-only `POST/GET/download` routes with a 24h per-zone cooldown, pg-boss queue + email + boot-sweep mirroring the report-jobs pattern, daily expiry sweep at `0 5 * * *`, and a `/zone/settings` UI surface that pairs the request affordance with the retention-policy editor. `scripts/restore-export.ts` walks the registry's restore order, rewrites `zone_id` + storage-key prefixes, nulls / remaps `*_by_user_id` columns, and re-uploads import + report blobs at the new zone keys — the round-trip test in `services/exports/restore.test.ts` ticks the Phase 9 exit criterion.)*
- Retention configuration.
- GDPR data subject request workflow (export and erase). *(**Landed across 3 PRs.** PR 1: `erasure_requests` schema with a partial unique index per scope + a relaxed CHECK that lets `member_id` be NULL on terminal-status rows so the FK SET NULL outlives the parent member. PR 2: service layer (`services/erasure/{requests,scrub-member,scrub-zone,cron}.ts`) with the pure PII scrub patch, the zone-decommission orchestrator (manual deletes for the three RESTRICT-FK children `members` / `chapters` / `groups` before the zone CASCADE), `applyErasureRequest` claiming rows via `SELECT … FOR UPDATE SKIP LOCKED` so concurrent workers can't double-apply, and the daily pg-boss `erasure.apply.sweep` at 05:00 UTC. Tenant routes at `POST /api/tenant/members/:id/erasure-requests`, `POST /api/tenant/zones/erasure-requests`, `DELETE /api/tenant/erasure-requests/:id`, `GET /api/tenant/erasure-requests` (owner / admin / finance_admin for member-scope; owner-only for zone-scope); admin parallel at `/api/admin/zones/:slug/erasure-requests` (super-admin only). The cancel UX motivated a design refinement vs the original task: scheduling a zone-erase no longer soft-decommissions the zone immediately (which would 404 the cancel UI through the tenant middleware) — soft-decommission happens in the apply path, immediately before the hard-purge. PR 3: UI surface — a Privacy panel on `/zone/members/[id]` with a request / cancel modal that renders an "Erased member #ref" banner once the scrub fires; a red-bordered Decommission card on `/zone/settings` gated on a recent (≤ 7 days) completed export with type-the-slug confirmation; a super-admin parallel decommission card on `/admin/zones/[slug]` that requires the bundle ID by hand. Restore-helper now honours the schema's restore contract: every `pending` `erasure_requests` row is auto-cancelled on import (`auto-cancelled on bundle restore` reason marker) so the target's cron sweep doesn't fire an erase scheduled on a different environment.)*
- TOTP MFA (opt-in per zone; the platform admin chooses which role codes require it). *(PR 1 + PR 2 landed: Better Auth `twoFactor()` plugin enabled, `two_factor` table + `user.two_factor_enabled` migration, enrollment surface at `/account/security` open to every authenticated user, password sign-in handles `twoFactorRedirect`. PR 2 closes the OTP / magic-link bypass via a `hooks.before` plugin (`packages/api/src/services/mfa-policy.ts`) and adds per-zone enforcement via the new `zones.mfa_required_role_codes text[]` column — a user holding a listed role lands on `/account/security?required=1` until they enrol. Default for new zones is empty (opt-in per zone). Editing now ships in the platform-admin UI: the "Two-factor enforcement" card on `/admin/zones/[slug]` flips the column via `PATCH /api/admin/zones/:slug/mfa-required-role-codes` (super-admin only) and surfaces an `enrolled / required` blast-radius counter before the operator commits.)*

Exit checklist:

- [x] Audit search surface is live at `/zone/audit` for admin-tier roles, with date / actor / action / entity filters and inline before/after JSON expansion.
- [x] An exported bundle contains every record for that zone and is independently restorable. *(`scripts/restore-export.ts` + the round-trip test in `packages/api/src/services/exports/restore.test.ts`; restores under a fresh `--target-zone-id` and re-uploads every import + report blob byte-for-byte.)*
- [x] An "erase" request can be applied with full audit and reversibility window. *(Member-scope + zone-scope erases land in `erasure_requests` with a per-row reversibility window; tenant-scope audit rows (`member.erase.scheduled` / `.cancelled` / `.applied`) and platform-scope rows (`platform.zone.erase.scheduled` / `.cancelled` / `.applied`, plus a daily `platform.erasure.sweep.run` summary) carry the full state-transition trail. UI surfaces the cancel handle for the whole window; the cron sweep at 05:00 UTC applies past-due rows. Restore-helper auto-cancels every pending row on bundle import so the trail survives without firing stale instructions.)*
- [x] MFA can be enforced at the role level. *(Per-zone `mfa_required_role_codes` is the canonical knob; the bypass-closure middleware refuses OTP / magic-link sign-in for any MFA-enrolled account.)*

---

## Phase 10 — Billing & GA

> Until this phase, billing is **invoice / bank transfer only** for the founding cohort. Stripe is added here for general availability.

Deliverables:

- Stripe integration (Customer + Subscription + Customer Portal + Webhooks).
- Plans: Founding, Standard, Premium (per-zone flat fee, annual prepay default).
- Invoice billing flow retained alongside Stripe (chosen at signup).
- Past-due flow: 14-day grace → read-only → suspend. No data deletion without explicit owner request.
- Billing currency at the billing-party level (USD/GBP), not the zone's operating currency.
- Marketing site polish, pricing page, status page.
- Self-service signup live to public (Stripe path).
- Support inbox + FAQ.
- Capacity plan signed off.
- On-call rota.
- Backup verification by restore drill.

Exit checklist:

- [ ] First non-friendly tenant signs up via Stripe and onboards without our intervention.
- [ ] Backup restore drill passes in staging.
- [ ] Stripe events (subscription.created, .updated, .deleted, invoice.payment_failed) handled end-to-end.
- [ ] Invoice path still works alongside Stripe.
- [x] **Family / household grouping** shipped (zone-scoped `families` + `family_members`, household totals on the member statement, Top Family report). See [`CHURCHPLUS-PORT-NOTES.md` §2.2.1](CHURCHPLUS-PORT-NOTES.md#221-family--household-grouping). Landed on `feat/families-households` (migration `0024_families_and_family_members.sql`); schema lives at `packages/db/src/schema/families.ts`; service at `packages/api/src/services/families.ts`; tenant routes at `/api/tenant/families`; Top Family report at `services/reports/top-family.ts`; UI under `/zone/families` and `/church/families`; member-statement `meta.household` band lights up automatically when the member belongs to an open household.
- [ ] **Bulk template download centre** shipped (one-click empty-template downloads for every registered importer, surfaced on `/zone/imports` and `/church/imports`). See [`CHURCHPLUS-PORT-NOTES.md` §2.2.2](CHURCHPLUS-PORT-NOTES.md#222-bulk-template-download-centre). Current branch `feature/template-download-centre` ships the registry, branded XLSX generation, tenant routes, and UI for enabled statement importers; the `envelope-batch` template is staged but hidden until the §2.2.3 importer is enabled.
- [ ] **Bulk slip / envelope import** shipped (envelope-batch parser plugged into the existing `upload → match → schedule → commit` pipeline, surfaced as a new tab on `/church/imports`). See [`CHURCHPLUS-PORT-NOTES.md` §2.2.3](CHURCHPLUS-PORT-NOTES.md#223-bulk-slip--envelope-import-xlsxcsv).
- [ ] **Member email verification (double opt-in)** shipped (`members.email_verification_status`, token issue/verify endpoints, rate-limited resend, GDPR-aligned audit trail). Required by the v1.1 broadcasts + campaign-reminder work. See [`CHURCHPLUS-PORT-NOTES.md` §2.2.4](CHURCHPLUS-PORT-NOTES.md#224-member-email-verification-double-opt-in).

---

## Phase 11 — Hardening (v1.1)

Deliverables:

- PostgreSQL Row-Level Security policies for sensitive tables.
- OpenTelemetry tracing.
- SSO (Google / Microsoft) optional.
- Performance tuning + materialized views for top reports.
- API rate limiting.
- Per-chapter branding overrides (zone admin discretion).
- Optional invoice-based billing automation (alongside Stripe).
- **Online giving (public donation flow) + Stripe Connect per-zone account** — public `/:zone/donate` page, payment-intent flow, webhook reconciliation, refund→reversal mapping, per-currency handling. See [`CHURCHPLUS-PORT-NOTES.md` §2.3.1](CHURCHPLUS-PORT-NOTES.md#231-online-giving-public-donation-flow).
- **Fundraising campaigns** — time-boxed asks distinct from partnership: `campaigns`, `campaign_targets` (zone / group / chapter scope), campaign-tagged contributions, campaign progress reports, reminder cron. Depends on online giving + comms. See [`CHURCHPLUS-PORT-NOTES.md` §2.3.2](CHURCHPLUS-PORT-NOTES.md#232-fundraising-campaigns).
- **Member email broadcast + reminders** — chapter- or zone-scoped sends to verified members only; queued workers with per-zone send-rate caps; preview + dry-run mandatory; MFA-required to raise the cap. Depends on Phase 10 member email verification. See [`CHURCHPLUS-PORT-NOTES.md` §2.3.3](CHURCHPLUS-PORT-NOTES.md#233-member-email-broadcast--reminders).
- **Custom bank accounts per chapter** — `bank_accounts` metadata table (zone, chapter?, currency, IBAN / sort code / account number) linked from imports and contribution batches. See [`CHURCHPLUS-PORT-NOTES.md` §2.3.4](CHURCHPLUS-PORT-NOTES.md#234-custom-bank-accounts-per-chapter).

---

## Phase 12 — FX & cross-currency reporting (v1.2)

Deliverables:

- FX rate snapshots (daily ECB or similar) ingested into a `fx_rates` table.
- Optional report toggle: "show all amounts in {currency} using {snapshot date}".
- Members with addresses in multiple countries can have multi-currency statements.

Excluded from v1 because it adds friction; deferred deliberately.

---

## Phase 13 — Accounting layer (v2 path)

Bring proper double-entry into the product.

Deliverables:

- Chart of accounts.
- Funds.
- Journal entries / journal lines (balanced, immutable, reversible).
- Posting from contributions into the ledger.
- Bank accounts and reconciliation.
- Expenses / vendors / approvals.
- Budgets.
- Income statement, balance sheet, trial balance, cashbook, fund balance.

This is intentionally **out of v1 scope**. The data model supports it (the `contributions` model maps cleanly to ledger postings), but we ship stewardship-first.

---

## Phase 14 — Beyond

Speculative; add when justified by customer demand.

- Member self-service portal (giving history + statement download).
- Online giving (Stripe / GoCardless).
- Mobile app for treasurers.
- AI categorisation for unmatched bank-statement lines.
- Direct integration with echurcher for online-giving capture.
- Partner API for integrations.
- Optional ETL from legacy Church Plus for zones who want to migrate later.

---

## Phase 15 — Groups hierarchy

Introduced a per-zone opt-in `groups` layer between Zone and Chapter:

- `groups` and `chapter_group_history` tables; point-in-time chapter moves.
- Two new roles: `group_admin` (chapter-admin-equivalent) and `group_pastor_viewer` (read-only).
- `/group/*` surface mirrors `/zone/*` narrowed to bound groups.
- `visibleChapterIds(ctx)` chokepoint centralises read-narrowing across all tenant routes.
- One-way enable toggle gated on every chapter being assigned to a group.

Spec: `docs/superpowers/specs/2026-05-22-groups-hierarchy-design.md`
Plan: `docs/superpowers/plans/2026-05-22-groups-hierarchy.md`

---

## Cross-phase practices

| Practice | Detail |
|---|---|
| **Tests** | Vitest unit + integration. Playwright e2e on smoke pages. Drizzle migration roundtrip tests. Cross-tenant fuzz tests. |
| **Migrations** | `drizzle-kit migrate`. Forward-only. Reversible via paired down-scripts. |
| **Reviews** | Every PR reviewed; financial code paths require a second reviewer. |
| **Feature flags** | Per-zone flags for risky features (e.g. import auto-commit, MFA enforcement, custom domains). |
| **Docs** | Each phase ends with updated PRD/Architecture/Domain docs reflecting reality. |
| **Telemetry** | Each new screen emits a tagged event; we measure adoption per zone per week. |
