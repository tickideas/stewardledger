# Roadmap

> Companion to [`PRD.md`](PRD.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`DOMAIN-MODEL.md`](DOMAIN-MODEL.md).
>
> The roadmap is in **phases**, not in calendar weeks. Each phase has explicit deliverables and an exit checklist. We move on when the checklist is green.
>
> Product name: **StewardLedger**. Primary domain: **`stewardledger.church`**.
> Tenant model: **the zone is the tenant**. Region is platform-curated reference data.

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
- **Public demo zone** (`demo.stewardledger.church`) seeded with realistic sandbox data; nightly reset job.
- Paid signup flow:
  - Sales / signup form (zone name, country, time zone, default currency, billing contact, expected chapters/members).
  - StewardLedger team confirms plan tier and pricing.
  - Zone is provisioned (subdomain, branding placeholder, default seeds).
  - Region selection: typeahead on existing regions; free-text fallback (creates `region_name_unverified`).
  - Owner is invited as `zone_owner` and walks through guided onboarding (chapters, members, first envelope batch).
  - Plan picked: Founding / Standard / Premium. Billing via Stripe (default) or invoice (first cohort).
- Zone settings (name, branding, default currency, time zone, fiscal year start).
- Chapter CRUD with reference-code generator (configurable format; legacy-style default).
- Chapter name history captured automatically.
- Invite users via email with role selection (zone-level or chapter-level).
- Manage user roles within the zone.
- Custom domain attach (CNAME-based; gated to paid plans).
- **Platform admin**: regions reference list CRUD, unverified region inbox.

Exit checklist:

- [x] Self-service signup works end-to-end (covered by `signup.test.ts`; staging deploy still pending).
- [x] A free-text region submitted at signup appears in the platform-admin inbox (`GET /api/admin/regions/inbox`).
- [x] Owner can add chapters and invite users (`POST /api/tenant/chapters`, `POST /api/tenant/invitations`).
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

Exit checklist:

- [x] Seed scripts create a full year of `giving_periods` for a new zone in <5 seconds (`period-seed.test.ts` asserts the budget — picked to absorb CI-runner / cold-start variance; full-year seed runs comfortably under 1s on a warm test DB).
- [x] Period auto-derivation works on a test set of arbitrary dates (`period-seed.test.ts` covers Jan 1, end-of-Q1 Sunday, mid-Q3 Tuesday, ISO-week-52 Sunday, and the Dec-31-belongs-to-next-ISO-year edge case).
- [x] Account currency defaults from the zone, with override support for foreign-currency accounts (`accounts.currency_code` defaults from the zone in the API layer — `tenant-giving.test.ts`).
- [x] Contribution + batch schema permits overriding `currency_code`, and a database trigger keeps each line aligned with its parent contribution's currency (`contributions.test.ts`). *(Service-layer default of `contribution.currency_code` from the zone is wired up in Phase 5 alongside the contribution write paths.)*

---

## Phase 5 — Contributions (manual + envelope batch) *(current focus)*

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
- Routes / UI for the treasurer flow are not yet built.

Exit checklist:

- [ ] A treasurer can record a Sunday batch in under 5 minutes for a 30-member service.
- [x] Posted contributions are immutable; the immutability is enforced at the DB level (triggers `contributions_posted_guard`, `contributions_no_delete_when_posted`, `contribution_lines_posted_guard`; verified by `contributions.test.ts`).
- [ ] Member running totals match per-member sum across all sources.
- [ ] Mixed-currency batches are forbidden (a batch is single-currency); UI forces a clear choice. *(line-currency match enforced at the DB level; UI gate pending.)*

---

## Phase 6 — Imports pipeline (flagship)

Deliverables:

- Import file upload (CSV/XLSX) with checksum + storage in object storage.
- Background `import.parse` job populating `import_rows`.
- Background `import.match` job filling member / chapter / giving type / period.
- Failure catalog + per-row failure capture.
- Schedule (preview before commit).
- Atomic commit job posting validated rows into contributions.
- Re-upload duplicate detection.
- Bank-format pluggable parsers (CSV first, then bank-specific).
- Import dashboard: history, status, retry, rollback.
- Replay-friendly: a job can be re-run safely; idempotency keys per row.

Exit checklist:

- [ ] One canonical statement file imports end-to-end into contributions atomically.
- [ ] Failed rows are listed with human-readable reasons and an inline "fix" UI.
- [ ] A second upload of the same file produces zero new contributions (full idempotency via `processed_transactions`).
- [ ] An import job can be rolled back; the audit log shows the rollback.

---

## Phase 7 — Reports v1

Deliverables (full list in [`REPORTS.md`](REPORTS.md)):

- Member statement (annual, period; PDF + Excel; branded).
- Giving by chapter / zone / period / category / giving type (PIVOT in app code).
- Top partners, top chapters.
- Partnership progress.
- Weekly finance report.
- Envelope ledger.
- Online giving ledger.
- Statement import reconciliation report.
- Member list (active, by chapter, by status).
- Saved filters.
- Background `report.generate` jobs with email-when-ready.

Exit checklist:

- [ ] Each v1 report ties out against a hand-curated test dataset.
- [ ] All exports work in Excel and PDF.
- [ ] Reports of >100k rows stream/paginate, never time out.
- [ ] Multi-currency reports show per-currency subtotals (no silent FX).

---

## Phase 8 — Targets & partnership

Deliverables:

- Financial target setup per chapter + giving type + ministry year.
- Optional zone-wide targets that aggregate across chapters.
- Paying-in book reference ranges.
- Partnership progress dashboard.
- Top partners by category and by month.

Exit checklist:

- [ ] Targets feed into reports and dashboards.
- [ ] Reference-code ranges validate during contribution entry.

---

## Phase 9 — Audit, exports, retention, MFA

Deliverables:

- Per-zone audit search.
- Per-zone data export bundle (Postgres dump + uploaded files + reports archive).
- Retention configuration.
- GDPR data subject request workflow (export and erase).
- TOTP MFA (mandatory for `zone_owner` and `zone_finance_admin` roles by default; configurable).

Exit checklist:

- [ ] An exported bundle contains every record for that zone and is independently restorable.
- [ ] An "erase" request can be applied with full audit and reversibility window.
- [ ] MFA can be enforced at the role level.

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

## Cross-phase practices

| Practice | Detail |
|---|---|
| **Tests** | Vitest unit + integration. Playwright e2e on smoke pages. Drizzle migration roundtrip tests. Cross-tenant fuzz tests. |
| **Migrations** | `drizzle-kit migrate`. Forward-only. Reversible via paired down-scripts. |
| **Reviews** | Every PR reviewed; financial code paths require a second reviewer. |
| **Feature flags** | Per-zone flags for risky features (e.g. import auto-commit, MFA enforcement, custom domains). |
| **Docs** | Each phase ends with updated PRD/Architecture/Domain docs reflecting reality. |
| **Telemetry** | Each new screen emits a tagged event; we measure adoption per zone per week. |
