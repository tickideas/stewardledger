# Product Requirements Document (PRD)

> **Project**: StewardLedger — modern, multi-tenant church finance & stewardship platform
> **Status**: Draft v0.2
> **Owner**: Bryan
> **Last updated**: 2026-05-07

---

## 0. Executive summary

StewardLedger is a **brand-new, multi-tenant SaaS product** for church finance and stewardship. It is **not a migration** of the legacy ASP.NET 6 / SQL Server "Church Plus" application, although Church Plus's well-trodden domain model is the source of design lessons.

StewardLedger is being built for a **new market** — regions and zones across Christ Embassy and (in time) other churches who want a modern, audit-grade, mobile-friendly platform for tracking giving, partnership, and chapter-level finance.

The legacy Church Plus continues to run independently on its own infrastructure for UK Zone 1. We do **not** depend on it, do **not** synchronize with it, and do **not** require a cutover. Migration tooling can be added later if/when an existing zone wants to move.

Key product attributes:

1. Built on the same modern stack you already operate for echurcher (TypeScript, Hono, SvelteKit, PostgreSQL, Drizzle, Better Auth, Docker, Dokploy) — in a **separate repo, separate Dokploy app**, with no shared monorepo.
2. Multi-tenant from day one. Hierarchy: **Region (reference data) → Zone (tenant) → Chapter → Member**. The customer who signs up and pays is a zone.
3. Multi-currency from launch. Each zone picks a default currency; per-fund/account override allowed; reports use native amounts with per-currency subtotals; FX deferred to v1.2.
4. Custom domains as a **paid feature** (CNAME-based, like echurcher).
5. Pricing: **flat fee per active zone**. **No free trial** — instead, a public demo zone (`demo.stewardledger.church`) for evaluation, and high-touch guided onboarding at paid signup.
6. **Immutable contribution ledger** with strong audit trails. Foundation for full double-entry accounting in a later phase.
7. **Statement / file import pipeline** as the flagship operational feature: upload → parse → match → preview → atomic commit, all as resumable background jobs.
8. Polished, fast, mobile-friendly admin UX for chapter treasurers, zonal finance officers, and platform operators.
9. SaaS-grade hygiene: per-tenant isolation, audit logging, retention controls, role-based access, GDPR-aware data export and deletion.

This PRD is paired with:

- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — system design, stack, deployment
- [`docs/DOMAIN-MODEL.md`](DOMAIN-MODEL.md) — full StewardLedger schema
- [`docs/DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md) — lessons distilled from the legacy Church Plus DB and decompiled .NET code, used as design reference only
- [`docs/ROADMAP.md`](ROADMAP.md) — phased build plan, milestones, deliverables
- [`docs/REPORTS.md`](REPORTS.md) — full report inventory and specs

---

## 1. Background and motivation

### 1.1 Reference: the legacy Church Plus app

A legacy product called **Church Plus / Financial Manager** has been operating for UK Zone 1 for several years. It is **not the project we are building**, but it is the closest existing model of what church-finance users in this market expect. We have full read access to its schema and decompiled source, and we use it as the **domain reference**.

Legacy stack (for context only):

| Layer | Legacy tech |
|---|---|
| Web framework | ASP.NET Core 6 MVC + Razor + jQuery + Bootstrap 5 + DataTables |
| Auth | ASP.NET Core Identity |
| ORM | EF Core 6 + SQL Server |
| Reporting | EPPlus, NPOI, DinkToPdf |
| Hosting | IIS / Windows Server |
| Project structure | Onion: `FinancialManager.{Model, ViewModel, ModelValidator, Data, Service, Utility, Client, EmailService}` |

What the legacy product gives us as a reference (not to copy):

- A working domain vocabulary (zones, chapters, members, giving categories, giving types, envelopes, periods, partnership).
- ~125 stored procedures encoding years of finance-team workflow and edge cases.
- A working bank statement / file import pipeline shape (holding → schedule → commit).
- A library of reports finance teams actually run.
- Real data shape for member dedup heuristics.

Full legacy artifacts referenced in [`DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md).

### 1.2 Why a brand-new product, not a rewrite

We explicitly **chose not to migrate** the legacy product. Reasons:

1. **New market, new positioning.** StewardLedger is a SaaS product. The legacy app is a single-tenant Windows-deployed app for one zone. The shape of the business is different.
2. **Clean, modern stack** — same as echurcher. Reuses ops playbook.
3. **Multi-tenant from day one.** Every architectural decision (`region_id`, currency per region, role bindings, custom domains) presumes many tenants.
4. **No legacy debt.** No EOL framework, no `money` columns, no stored-proc-driven business logic, no cross-database calls, no plaintext secrets in config files, no Windows/IIS coupling.
5. **No cutover risk.** Legacy app keeps running, untouched, for whoever is using it today. StewardLedger goes to market on its own merits.
6. **Audit-grade design.** Posted contributions are immutable and corrected via reversal — easier to bake in from day one than retrofit.

### 1.3 Strategic direction

- Build for **multi-tenancy from day one**. Zone is the tenant; region is reference data; chapters belong to zones.
- **Multi-currency from launch.** FX deferred to v1.2.
- **Custom domains as a paid feature.**
- **Pricing per active zone.** No free trial; a public demo zone + guided paid onboarding instead.
- Use the **same stack as echurcher** (Hono + SvelteKit + Postgres + Drizzle) to reuse tooling, ops, hosting on Dokploy.
- Keep the new product **strictly separate** from the echurcher monorepo. Echurcher = online church/community. StewardLedger = financial stewardship.
- Position the product as a **stewardship & finance platform** that can later host a full ledger.
- Treat the **statement-import pipeline** as the flagship operational feature.

---

## 2. Product naming

The legacy product is "Church Plus". The new product needs a fresh name.

### 2.1 Chosen name

**Product name: StewardLedger.**
**Primary domain: `stewardledger.church`.**

Reasoning:

- "Steward" is the exact word treasurers and pastors already use; biblical resonance without being kitschy.
- "Ledger" makes the financial nature unmistakable and distinguishes the product from the many other "Steward*" names already in the market.
- The compound is unique enough to give us a clean trademark path and is pronounceable in English without confusion.
- `stewardledger.church` is on-brand, signals the audience (churches), and avoids the crowded `.com` space.

### 2.2 Brand surface

- **Wordmark**: `StewardLedger` (single token, capital S and L).
- **Conversational**: "Steward Ledger" (two words) is acceptable in marketing copy and headlines, but never as the wordmark.
- **App / domain**: `stewardledger.church`.
- **Tenant subdomain pattern**: `{zone-slug}.stewardledger.church`.
- **API host**: `api.stewardledger.church`.
- **Email sender domain**: `stewardledger.church` via the shared useSend stack.
- **Demo**: `demo.stewardledger.church`.

### 2.3 Pre-launch verification

Before the public launch, complete:

1. Trademark search (US USPTO, UK IPO, EU EUIPO; classes 9 + 36).
2. Register `stewardledger.church`, `stewardledger.com`, `stewardledger.app`, `stewardledger.io` (defensive).
3. Reserve handles on X, LinkedIn, Instagram (for company page only).
4. Reserve `stewardledger` on npm and GitHub (org name).

---

## 3. Vision and positioning

### 3.1 Vision statement

> **StewardLedger is the church finance ledger. From a single member's giving to a zone's annual partnership, every contribution is recorded once, traceable forever, and reportable in seconds.**

### 3.2 Audience

| Persona | Needs |
|---|---|
| **Zonal pastor / leader** | Visibility into giving and partnership across all churches in their zone. Compare branches. Track financial targets. |
| **Zonal finance officer** | Imports bank statements, reconciles online giving, generates monthly/quarterly reports, runs partnership periods. |
| **Church treasurer** | Records envelope giving for each service, reconciles cash and cheque totals, manages members, runs church-level reports. |
| **Member / partner** | Receives accurate, branded annual giving statements. (Future: self-service giving and statement download.) |
| **Auditor** | Reads-only access. Sees full audit trail, history, who-did-what. |
| **Platform operator (us)** | Onboards new zones, monitors usage, manages billing, supports tenants. |

### 3.3 Differentiators

1. **Multi-tenant from day one** — many zones, each with many churches. Tenant isolation, branded experience per zone, custom domain support.
2. **Statement import pipeline** — preview, validate, schedule, atomic commit. No more batch SQL runs.
3. **Immutable contribution ledger** — posted contributions cannot be silently mutated; corrections are reversals.
4. **Cohesive periods model** — fiscal, ministry and giving periods all aligned in one place.
5. **Modern UX** — fast, mobile-friendly, opinionated. Treasurers can do a Sunday close in minutes.
6. **API-first** — every screen is backed by a typed API; integrations and a future member self-service portal are practical.

---

## 4. Scope

### 4.1 In scope (v1)

- Multi-tenant onboarding (regions, zones, chapters)
- Auth (email + password, email OTP, magic link, social later)
- RBAC: roles per region, per zone, per chapter
- Member management (CRUD, addresses, deduplication, merge)
- Giving setup (categories, types, payment methods, accounts/funds, service types)
- Period model (giving period, fiscal period, ministry period, partnership year)
- Service / meeting recording
- Church envelope giving (header + lines)
- Online / manual contribution entry
- Bank statement file import (CSV/XLSX) with the full preview → validate → schedule → commit pipeline
- Member bulk import
- Contribution editing with audit trail
- Member statements (annual, period)
- Reports (top of legacy report list, see [`docs/REPORTS.md`](REPORTS.md))
- Financial targets per chapter / zone / giving type / ministry year
- Paying-in book reference ranges
- Email branded notifications
- Excel and PDF exports
- Audit log
- Per-tenant data export (GDPR)
- Platform admin console (tenants, billing, support)

### 4.2 Out of scope for v1 (planned for later phases)

- Full double-entry accounting (chart of accounts, journal entries, balance sheet, income statement)
- Expense management, vendors, AP
- Bank account reconciliation
- Budgeting and forecasting
- Online giving collection (taking actual payments via Stripe / GoCardless)
- Member self-service portal
- Mobile apps (iOS/Android)
- AI-driven categorization or anomaly detection
- Direct integration with church streaming products (echurcher)
- **Data migration from the legacy Church Plus app.** StewardLedger is launched as a new product for a new market. The legacy UK Zone 1 deployment continues to run independently; we don't rely on its data. Migration tooling can be built later if/when an existing zone wants to move.

### 4.3 Non-goals

- Not replacing accounting software like QuickBooks/Xero in v1 — StewardLedger records giving and stewardship, with optional ledger later.
- Not building yet-another-online-giving-checkout — focus first on capture and reporting; payments come later.

---

## 5. Multi-tenancy model

### 5.1 Hierarchy

```txt
Platform (StewardLedger)
└── Region                  (reference data — curated by platform admins; not a tenant)
    └── Zone                (THE TENANT — signs up, pays, has subdomain, owns data)
        ├── Settings, branding, billing
        ├── Roles / Users
        └── Chapter         (a local church / congregation)
            ├── Services / Meetings
            ├── Members
            ├── Envelopes
            ├── Contributions
            └── Targets
```

Key principles:

- **The Zone is the SaaS tenant.** A zone signs up, pays the per-zone fee, owns its subdomain, and isolates its data from every other tenant.
- **Region is a categorization, not a tenant.** Every zone selects (or types) the region it belongs to during signup. Regions are reference data — a curated list maintained by platform admins, used for cross-zone grouping, comparison reports, and (when applicable) platform-level rollups.
- A zone has many **chapters**.
- A chapter has many **members**.
- This mirrors how the legacy Church Plus is deployed today (one zone per database). We just take it multi-tenant.

Why regions are reference-only, not tenants:

- Two zones in the same region rarely share users, settings, or data.
- Each zone runs its own finances, has its own treasurer, its own targets, its own fiscal calendar.
- Forcing a region admin tier above zones would slow down sign-up and add a hierarchy that paying customers don't actually want.
- Cross-zone visibility (regional pastor's view) is reporting only and is delivered through platform-admin-curated rollups, not as a tenancy layer.

Regions during sign-up:

- The signup form shows a typeahead of known regions.
- If a zone's region isn't in the list, they enter free text. The zone is created with `region_id = null` and `region_name_unverified = '<text>'`.
- A platform admin reviews unverified entries and either maps the zone to an existing region or creates a new region row. Until that happens, the zone works fully — region grouping just shows "Pending".
- A zone can change its region later (subject to platform-admin approval if moving away from a verified region).

### 5.2 Tenant isolation

- **Single PostgreSQL cluster, single database, row-level multi-tenancy** (echurcher pattern).
- Every domain table has `zone_id uuid not null` — the tenant boundary.
- Chapter-scoped tables also have `chapter_id`.
- Most tables denormalize `region_id` (nullable) for fast region-aware reports; a region change at the zone level fans out to update those columns.
- Composite default indexes on `(zone_id, ...)` for hot tables.
- API middleware resolves the tenant from the authenticated session and `Host` header (subdomain or attached custom domain).
- Optional Postgres RLS policies for defence in depth (post-v1 hardening).
- A platform-admin context can read across tenants but never silently writes.

### 5.3 Subdomains and branding

- Every zone gets a canonical subdomain `{slug}.stewardledger.church` (or final brand domain).
- **Custom domain support is a paid feature** (CNAME based, similar to echurcher).
- Branded login, email templates, and PDF/Excel report headers per zone.
- Per-chapter branding is out of scope for v1 (each chapter inherits its zone's branding).

### 5.4 Data residency and export

- Per-tenant export bundle (Postgres dump + uploaded files + reports archive) on demand.
- Per-tenant deletion process with retention window.

---

## 6. Roles and permissions

A user is bound to a role at one of three scopes: **platform**, **zone** (the tenant), or **chapter** (within a zone). There are no "region" roles; regions are reference data only.

### 6.1 Platform-level roles

Not bound to any tenant.

| Role | Description |
|---|---|
| `super_admin` | Full platform admin, all tenants, all data. |
| `support_admin` | Read-only across tenants, plus write access to support tickets and FAQ. |
| `billing_admin` | Plans, subscriptions, invoices. |
| `region_curator` | Maintains the regions reference list. Reviews unverified region submissions from new zones and approves/edits them. |

Delegation lives in `/admin/administrators` (super-admin only). It exposes both *invite a new admin* and *grant a role to an existing user*; revoke is a soft-revoke (sets `revoked_at` on the `platform_role_bindings` row). The super-admin bit on `user.is_super_admin` is layered on top via a separate Promote / Demote action — the system refuses to demote the only remaining super-admin (`last_super_admin` 409).

### 6.2 Zone-level roles

Apply across the whole tenant (every chapter in the zone).

| Role | Description |
|---|---|
| `zone_owner` | Full zone access. Cannot be removed if sole owner. |
| `zone_admin` | Manage all zone settings, all chapters, all users in the zone. |
| `zone_finance_admin` | All finance operations across the zone. Cannot manage users. |
| `zone_auditor` | Read-only across the entire zone, including history. |
| `zone_pastor_viewer` | Read-only summaries, dashboards, top reports. No raw PII. |

### 6.3 Chapter-level roles

Apply to a single chapter only.

| Role | Description |
|---|---|
| `chapter_admin` | Manage chapter settings and chapter-scoped users. |
| `chapter_treasurer` | Full finance operations on that chapter (contributions, envelopes, reports). |
| `chapter_bookkeeper` | Data entry on contributions and envelopes; cannot post/approve. |
| `chapter_pastor_viewer` | Read-only chapter summaries. |

### 6.4 Permissions model

Permissions are derived from role bindings (`user_id` × `zone_id` × optional `chapter_id` × `role`). The API middleware computes the effective permission set per request. Write actions on financial records always require an explicit role check; default is deny.

A user can hold **multiple bindings** — e.g. `chapter_treasurer` at chapter A, plus `zone_pastor_viewer` zone-wide.

Users are global accounts (one per email). A user can belong to many zones (different role per zone). Sign-in is global; the user picks which zone to enter on the login screen if they have access to more than one.

---

## 7. Functional requirements

### 7.1 Authentication

- Email + password signup with confirmation email.
- Email OTP login (preferred for finance roles).
- Magic link fallback.
- Password reset via signed token email.
- "Remember me" 35-day session.
- Session expiry warning (configurable, default 5 minutes before expiry).
- Optional MFA (TOTP) v1.1.
- Optional SSO (Google / Microsoft) v2.

### 7.2 Onboarding

> **Current behaviour (v1):** StewardLedger is **invitation-only**. There is no public signup form — a platform admin creates the zone via `POST /api/admin/zones/invite` (UI: `/admin/zones`) and emails the primary contact a `zone_owner` invitation. See `docs/ARCHITECTURE.md` §12.2. The Stripe self-service flow described below is **roadmap content**, not current behaviour, and Phase 10 will revisit whether to re-open public signup.

**The customer is a zone.** There is no free trial — a zone is a 50-chapter, multi-thousand-member operation, not a one-person product. Instead:

#### Public demo (anyone)

- `demo.stewardledger.church` is a public, read-or-write sandbox seeded with a fictional zone ("Demo Zone", a few chapters, a few hundred members, a year of synthesized giving).
- Data resets nightly.
- Demo users can click through every screen and run every report.
- Marketing site links go straight here for evaluation.

#### Paid signup

1. Sales / signup form collects: zone name, country, time zone, default currency, billing contact, intended start month, expected number of chapters, expected number of members.
2. StewardLedger team confirms plan tier and pricing. (First cohort: invoice / bank transfer. Standard cohort: Stripe checkout.)
3. Zone is provisioned: subdomain, branding placeholder, default seeds (giving categories, payment methods, period rows for the current year).
4. Region selection: typeahead on the curated regions list, or free text (`region_name_unverified`) reviewed by platform admins later.
5. **Guided onboarding session** (~60–90 min, video call): a StewardLedger customer-success contact walks the zone owner through:
   - Inviting the zonal finance officer and chapter pastors / treasurers.
   - Adding chapters in bulk.
   - Importing members in bulk.
   - Running the first envelope batch end-to-end.
   - First bank statement upload.
6. After session: zone owner gets a checklist with the remaining setup tasks, plus a direct line to support.

### 7.3 Member management

- CRUD members with required fields (FirstName, LastName, Title, etc.).
- Address management (one or many addresses, primary address).
- Bulk import (CSV/XLSX) with row-level validation, failure reasons, and preview.
- Bulk export (CSV/XLSX).
- Duplicate detection workflow: by name, by name+chapter, by name with different chapter, by invalid characters (heuristics inspired by the legacy `Member_Duplicate_*` views).
- Merge proposal queue (admin reviews and approves merges).
- Member reference codes (auto-generated, e.g. `M0000001`).
- Soft-delete with audit; never hard-delete by default.

### 7.4 Giving setup

- Giving categories (with parent/child).
- Giving types (linked to category, with flags `is_zonal`, `is_church`, `has_partnership_target`).
- Payment methods (cash, cheque, card, bank transfer, online, mobile money).
- Accounts/funds (where giving is allocated).
- Giving-type-to-account mapping.
- Service types and service events (with date, period auto-derivation).
- Calendars: fiscal year, ministry year, partnership period, giving period — all reconciled in one model.

### 7.5 Contributions (the heart of the app)

A single unified `contributions` model handles every kind of giving capture: physical envelopes, oblation/special multi-member envelopes, online giving, and bank-imported giving. Each contribution has lines (one per giving type).

Required:

- Manual single contribution entry (envelope-style: header + lines).
- Batch contribution entry for a service event (treasurer's Sunday workflow).
- Online giving entry / reconciliation.
- Bank statement import → contributions.
- Editing with full audit; posted contributions are not mutated, they are reversed/adjusted.
- Voiding with reason.
- Splitting (one envelope = multiple giving types).
- Linking parent/child envelopes (e.g. an envelope contains a child sub-envelope).
- Linking multiple members to one contribution (oblation-style).
- Per-member running totals and statements.
- Each contribution carries an explicit `currency_code` so multi-currency tenants are supported natively.

### 7.6 Statement / file import pipeline

This is the **flagship operational feature**. The model is:

```txt
ImportFile (uploaded) →
ImportJob (parse) →
ImportRow[] (one per file row) →
match members / branches / giving types →
ImportRowFailure[] (validation errors) →
Schedule (preview) →
Commit (atomic post into contributions) →
ProcessedTransaction (audit handle)
```

User flow:

1. Treasurer uploads CSV/XLSX statement.
2. Background job parses and validates.
3. UI shows preview: matched rows, unmatched rows, duplicates, validation errors.
4. Treasurer fixes mappings (member matching by reference code or name) inline.
5. Treasurer either:
   - **Assess only** — no commit.
   - **Assess and schedule** — saves a draft to commit later.
   - **Assess, schedule, commit** — posts straight through.
6. On commit, all valid rows post atomically. Failed rows stay in the import job.
7. Re-uploads detect duplicates by `(statement_date, member, amount, giving_type, branch, account)`.

Detailed in [`REPORTS.md`](REPORTS.md) and the rebuild order in [`ROADMAP.md`](ROADMAP.md).

### 7.7 Reports

Full inventory in [`REPORTS.md`](REPORTS.md). High level v1 set:

- Member statement (annual / period, PDF + Excel)
- Giving by member, chapter, zone, period, category, giving type
- Top partners, top chapters
- Partnership progress
- Weekly finance report
- Envelope ledger
- Online giving ledger
- Statement import reconciliation report
- Member list (active, by chapter, by status)
- Cross-zone region rollups (platform-admin only; opt-in per zone)

Reports are:
- Filtered by chapter / zone / period.
- Pivotable in the UI.
- Exportable to Excel (xlsx) and PDF.
- Saveable as named filters.
- Currency-aware: each row carries its native currency; mixed-currency totals show per-currency subtotals (no automatic FX in v1).

### 7.8 Targets and partnership

- Define a financial target per chapter + giving type + ministry year (within a zone).
- Optionally define zone-wide targets that aggregate across chapters.
- Track full target, monthly target, weekly breakdown, number of partners.
- Show progress against target on dashboards.
- Partnership periods (current ministry year, partnership year, partnership period code).

### 7.9 Audit trail

- Append-only `audit_events` table per zone.
- Every write captures: actor, action, entity, before/after JSON, IP, user agent, request id.
- Posted financial records are immutable in the strict sense; corrections are recorded as separate reversal/adjustment contributions.

### 7.10 Notifications

- Branded transactional emails (welcome, password reset, OTP, statement ready).
- In-app notifications (v1.1).
- Webhooks for integrations (later).

### 7.11 Platform admin

- Tenants (zones) list with health (active users, last activity, plan, MRR).
- Per-zone drill down (chapters, contributions volume, last import, support tickets).
- **Regions reference list** — maintained by `region_curator` role. CRUD regions, review unverified region submissions from new zones, merge duplicates.
- Plans and billing.
- Support inbox.
- Feature flags.

### 7.12 Pricing & billing

- **Per-zone flat fee.** No free trial.
- Plan tiers (working assumption, finalize before launch):
  - **Standard** — base price/month per active zone. All core features.
  - **Premium** — standard + custom domain, mandatory MFA, priority support.
  - **Founding zones** — discounted first-year price for the first cohort, in exchange for design-partner feedback.
- **Annual prepay** is the default; monthly billing available on request.
- A user account (org / individual) can own multiple zones; each active zone is billed independently.
- Stripe integration (Customer + Subscription + Customer Portal + Webhooks) for self-service signup, **plus** invoice-based billing (bank transfer) for zones that prefer it (first cohort and on request).
- Billing currency matches the billing contact's preference (commonly USD or GBP), **not** the zone's operating currency — this avoids FX confusion when zones operate in non-USD currencies.
- Past-due flow: 14-day grace → read-only mode → suspend. **No data deletion** without explicit owner request. Detailed in `BILLING.md` (drafted in Phase 10).

---

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | P95 < 300ms for typical screen loads. Reports stream / paginate. Imports run as background jobs. |
| Security | OWASP top 10 hardened. CSRF tokens. Strict CSP. Cookie hardening. Secret rotation playbook. No secrets in repo. |
| Privacy | GDPR-aware. Per-tenant export & deletion. Audit access to PII. |
| Reliability | Zero-downtime deploys. Daily encrypted Postgres backups with PITR. Monthly restore drill. |
| Observability | Structured JSON logs. Request id propagation. Metrics (RPS, p50/p95, error rate). Per-tenant usage. |
| Accessibility | WCAG 2.1 AA. Keyboard navigation. Color-contrast checked. |
| Internationalization | i18n-ready. v1 ships English UI. **Multi-currency at launch**: every region picks a default currency, every account/fund can override, every contribution carries its own currency. Time zones per region. |
| Browser support | Latest 2 versions of Chrome, Edge, Safari, Firefox. Mobile Safari + Android Chrome. |
| Data integrity | All money as `numeric(19,4)` with explicit `currency_code`. No float math. Strict input validation. |
| Backups | Daily full + WAL archive. Per-tenant on-demand export. |

---

## 9. Tech stack

Final stack (full justification in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)):

| Layer | Choice |
|---|---|
| Frontend | SvelteKit 2 (Svelte 5), Tailwind 4 |
| API | Hono on Node 22 LTS |
| Validation / types | Zod end-to-end |
| Database | PostgreSQL 17 |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Auth | Better Auth (email OTP, magic link, password) |
| Background jobs | pg-boss (initially) — Postgres-native, no extra infra |
| Object storage | S3-compatible (R2 / MinIO / Backblaze B2) |
| File parsing | xlsx, papaparse, exceljs |
| PDF | Playwright (HTML→PDF) or @sparticuz/chromium with playwright-core |
| Excel export | exceljs |
| Email | useSend (self-hosted), shared with echurcher infra |
| Logging | pino (JSON) + Loki/Grafana later |
| Tests | Vitest, Playwright |
| Monorepo | pnpm workspaces + Turborepo |
| CI | GitHub Actions |
| Deploy | Docker + Dokploy (same as echurcher) |

We deliberately mirror the echurcher stack so the operations playbook (build, deploy, monitor, secret management) is shared, even though the codebases are separate.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Stored procedure logic is subtle and undocumented | Decompiled C# source has been recovered; we document every proc's intent in [`docs/DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md) before reimplementing the equivalent application service. |
| Multi-tenant complexity | Borrow proven patterns from echurcher. Strict middleware. Add Postgres RLS in v1.1. |
| Reports drive 60% of perceived value; missing one loses trust with finance users | Inventory all legacy reports first (see [`REPORTS.md`](REPORTS.md)). Treat as acceptance criteria. Validate against the same inputs the legacy app produces, on a sandbox copy of the legacy DB. |
| Bank statement formats vary | Build a pluggable parser registry. Support CSV first, common bank formats second. |
| Member dedup is hard | Implement the proven legacy heuristics, plus surface them in a review queue (no silent automatic merge). |
| Scope creep into accounting | v1 explicitly excludes ledger. Stewardship-first. Architecture leaves room for Phase 13. |
| Multi-currency adds friction at launch | Native amounts only in v1 (no automatic FX conversion). Per-region default currency. Cross-region rollups deferred to v1.1. |
| New market means no installed base to fall back on | Public demo zone, branded experience from day one, founding-zones discount, guided onboarding. Treat first 5 zones as design partners. |

---

## 11. Open questions for product owner

**Decided:**

1. ✅ **Product name**: **StewardLedger**. Primary domain: **`stewardledger.church`**. Trademark search to run before launch.
2. ✅ **Hierarchy**: Region (reference data) → Zone (tenant) → Chapter → Member. The zone is the SaaS customer.
3. ✅ **Currency**: multi-currency at launch. Each zone picks a default currency; per-fund/account override allowed; reports show native amounts with per-currency subtotals. **FX deferred to v1.2.**
4. ✅ **Custom domains**: paid feature.
5. ✅ **Plan structure**: flat fee per active zone.
6. ✅ **Annual prepay default.** Monthly billing on request.
7. ✅ **First cohort billing: invoice / bank transfer.** Stripe self-service is built in Phase 10 and used from general availability onwards.
8. ✅ **Legacy**: no migration. StewardLedger is a brand-new product for a new market.
9. ✅ **Ministry year**: same in practice across Christ Embassy zones, but **kept configurable per zone** so other denominations can adopt later.
10. ✅ **Cross-zone region rollup reports**: not in scope. Each zone is strictly siloed.
11. ✅ **No free trial.** Replaced by:
    - **Public demo zone** (`demo.stewardledger.church`) seeded with realistic sandbox data, resets nightly. Anyone can poke around without signing up.
    - **Guided onboarding** at paid signup (a StewardLedger team member walks the zone owner through chapters, members import, and first Sunday close).
    - **Founding-zones discount** for the first cohort.

**Still open:**

1. Specific price points for Founding / Standard / Premium tiers.
2. Annual-prepay refund policy (recommend pro-rated refund within first 30 days, none thereafter).
3. Whether MFA is mandatory or just default-on for Premium.

---

## 12. Acceptance criteria for v1 launch

A zone can, end-to-end, on its own:

1. Sign up, pick a region (or submit a free-text region), add chapters, invite users, assign roles at zone or chapter level.
2. Import its member list (CSV/XLSX) with errors surfaced row-by-row.
3. Define giving categories, types, payment methods, accounts; with the zone's default currency and any account-level overrides.
4. Record a Sunday service: envelope batch at a chapter with multiple members and split giving types.
5. Upload a bank statement (CSV/XLSX) at the zone level, preview matches, fix unmatched rows, commit atomically.
6. Run all v1 reports (see [`REPORTS.md`](REPORTS.md)) — zone-wide or chapter-scoped — and export to Excel and PDF.
7. Generate a member's annual giving statement (PDF, branded).
8. Set financial targets at the chapter and zone level for a ministry year; see progress.
9. Audit every change made by any user.
10. Export the full tenant data on request.

For us:

- 99.9% uptime over the first 90 days post-launch.
- Zero plaintext secrets in the repo.
- Daily backup and tested monthly restore.
- First 5 zones onboard themselves with a single guided 30-minute session of human help.
