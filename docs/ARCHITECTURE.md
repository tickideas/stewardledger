# Architecture

> Companion to [`PRD.md`](PRD.md). Defines stack, system shape, deployment, and cross-cutting concerns.

---

## 1. Goals

- Single multi-tenant SaaS product. **The zone is the tenant**; many zones share the platform; regions are reference data only.
- Same operational stack as echurcher for shared ops experience, but a **separate repo** and a separate Dokploy app.
- Strict TypeScript end-to-end (Zod-validated boundaries, Drizzle for DB, Hono RPC types).
- Financial-grade data integrity: `numeric(19,4)` money paired with explicit `currency_code`, immutable posted records, append-only audit log.
- Multi-currency native: each zone runs in its own default currency; per-account override; reports show native amounts with per-currency subtotals.
- Background-job pipeline for imports and report generation.
- Clean bounded contexts so the future ledger, expenses and budgeting modules slot in without rewrites.

---

## 2. Stack

| Concern | Tech | Notes |
|---|---|---|
| Runtime | Node 22 LTS | Same as echurcher; Bun considered later. |
| Language | TypeScript (strict) | Shared `tsconfig.base.json`. |
| Web framework (API) | **Hono** | Type-safe RPC; lightweight; works with Node and edge later. |
| Web framework (UI) | **SvelteKit 2 (Svelte 5)** | SSR + islands; great for treasurer-style dashboards; same as echurcher. |
| Styling | Tailwind 4 | Same tokens as echurcher where shared (typography, spacing); separate brand palette. |
| DB | **PostgreSQL 17** | One cluster, one DB, row-level multi-tenancy. |
| ORM / migrations | **Drizzle** + `drizzle-kit` | Schema-first, codegen, push and migrate. |
| Validation | **Zod** | Shared schemas between API and UI. |
| Auth | **Better Auth** | Email OTP + magic link + password; same as echurcher. |
| Sessions | Cookie-based, host-only | Same hardening as echurcher. |
| Background jobs | **pg-boss** | Postgres-native queues; no Redis required for v1. |
| Email | **useSend** | Self-hosted; share echurcher's instance. |
| Object storage | S3-compatible | R2 / Backblaze B2 / MinIO. Used for uploaded files and generated reports. |
| Excel | **exceljs** | Modern; replaces EPPlus / NPOI. |
| CSV | **papaparse** | Streaming parser. |
| XLSX read | **xlsx** (SheetJS) | For uploaded statement parsing. |
| PDF | **playwright-core** + `@sparticuz/chromium` (Linux) | Modern, maintained; replaces DinkToPdf. |
| Logging | **pino** | JSON; OpenTelemetry-friendly. |
| Metrics / tracing | OpenTelemetry → Grafana / Tempo | Phase 2; basic logs first. |
| Tests | Vitest, Playwright, Drizzle test DB | Same patterns as echurcher. |
| Monorepo | pnpm workspaces + Turborepo | Same as echurcher. |
| CI | GitHub Actions | Lint + typecheck + tests + Docker build. |
| Deploy | Docker + Dokploy | Same Traefik front, separate Dokploy app. |

### 2.1 Why not .NET / SQL Server?

- Echurcher already runs on the chosen stack — shared ops, dev tooling, hosting playbook.
- Better Auth, Drizzle, SvelteKit deliver the same productivity for far less ceremony than ASP.NET Identity + EF Core.
- Postgres has better licensing economics, runs natively on Linux/Docker/Dokploy, and gives us features the legacy app already needs (jsonb, RLS, generated columns, rich indexing).
- We are launching a brand-new product, so there is no installed-base reason to stay on .NET.
- Long-term hire pool for TS/Postgres is broader than .NET/SQL Server in the church-tech ecosystem.

If a strong .NET preference emerges, the alternative would be **.NET 9 + Minimal APIs + EF Core 9 + Blazor + Postgres + Npgsql**. Not recommended.

---

## 3. Repository layout

A new standalone repo: `tickideas/stewardledger`.

```txt
steward/
├── apps/
│   ├── api/                     # Hono API server (port 3000)
│   └── web/                     # SvelteKit app (port 5173 dev)
├── packages/
│   ├── db/                      # Drizzle schema, migrations, seed
│   ├── shared/                  # Zod schemas, types, constants, utility (money, dates, periods)
│   ├── jobs/                    # pg-boss workers (imports, reports, statement gen)
│   ├── email/                   # Branded transactional email templates
│   ├── pdf/                     # Report → PDF rendering
│   ├── excel/                   # Report → Excel rendering
│   └── importers/               # Pluggable bank-statement parsers
├── infra/
│   ├── docker/
│   ├── dokploy/
│   └── playwright/
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── DOMAIN-MODEL.md
│   ├── DOMAIN-REFERENCE.md
│   ├── ROADMAP.md
│   ├── REPORTS.md
│   ├── SECURITY.md
│   ├── DEPLOYMENT.md
│   ├── BILLING.md
│   └── runbooks/
├── scripts/
├── docker-compose.yml
├── docker-compose.prod.yml
├── Dockerfile.api
├── Dockerfile.web
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

### 3.1 Why mirror echurcher's layout?

- One mental model for ops: `pnpm dev`, `pnpm test`, `pnpm build`, `pnpm db:push`.
- Same Dockerfiles, same Dokploy compose patterns.
- Same secret management.
- Easier onboarding for anyone who's worked on echurcher.

But: it is a **separate repo**, separate Git history, separate CI pipeline, separate Dokploy app. Echurcher must not be a dependency here.

---

## 4. System diagram

```txt
                  Internet
                     │
           ┌─────────┴──────────┐
           │   Traefik (Dokploy) │
           └─┬────────┬────────┬─┘
             │        │        │
   *.stewardledger.church  custom    api.stewardledger.church
             │      domains    │
             ▼        ▼        ▼
          ┌──────────────┐   ┌──────────────┐
          │   web (SSR)  │──▶│   api (Hono) │
          └──────────────┘   └──────┬───────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
        ┌──────────┐         ┌─────────────┐       ┌──────────────┐
        │ Postgres │         │  pg-boss    │       │   useSend    │
        │   (17)   │         │  workers    │       │  (email)     │
        └──────────┘         └─────┬───────┘       └──────────────┘
                                   │
                                   ▼
                            ┌─────────────┐
                            │   Object    │
                            │  storage    │
                            └─────────────┘
```

---

## 5. Multi-tenancy

### 5.1 Hierarchy & strategy

- Hierarchy: `Region (reference) → Zone (tenant) → Chapter → Member`.
- **Single database, row-level isolation** (matches echurcher).
- Every domain table has `zone_id uuid not null` — the tenant boundary.
- Chapter-scoped tables also have `chapter_id uuid not null`.
- Most domain tables denormalize `region_id` for fast region-aware reports; updated by a maintenance job when a zone's region changes.
- API middleware:
  1. Resolves the user from the session.
  2. Resolves the zone from `Host` header (subdomain or custom domain) and matches against the user's `user_role_bindings`.
  3. Builds an `AuthorizedContext` containing `{ userId, zoneId, regionId, roles[], chapterIds[] }`.
  4. Every DB query goes through a thin tenant-aware wrapper that injects the `zone_id` filter.
- Drizzle `with` helpers (e.g. `withTenant(db, ctx)`) make the `zone_id` filter mandatory.

### 5.2 Defence in depth

- v1: rely on application-layer enforcement plus query helpers and integration tests that fuzz cross-tenant access.
- v1.1: enable PostgreSQL **RLS** policies for the most sensitive tables (`contributions`, `members`, `audit_events`).

### 5.3 Subdomains and custom domains

- Wildcard DNS `*.stewardledger.church` (or final brand) → Traefik → web app.
- SvelteKit hooks read the `Host` header → resolve the zone slug or attached custom-domain mapping → set tenant context for the session.
- Better Auth `trustedOrigins` is dynamic: trusts `*.stewardledger.church`, any active custom domain, and `api.stewardledger.church`.
- **Custom domains are gated behind paid plans** (verified during signup of a custom domain).

### 5.4 Cross-zone visibility

- **Each zone is strictly siloed.** No cross-zone reports in v1 (or planned for any later version).
- Region is reference data only — useful for filtering the platform-admin tenant list and for branding ("this zone is part of region X"), not for reporting across zones.
- A user who needs cross-zone visibility (e.g. a regional pastor invited by multiple zones) is given a viewer binding in each of those zones explicitly. There is no shortcut.
- This keeps the data and trust model simple: a zone's data is its own.

---

## 6. Bounded contexts

We organize the codebase by domain context, not by technical layer.

| Context | Owns |
|---|---|
| **Identity** | Users, sessions, OTP, password reset, MFA. |
| **Tenancy** | Zones, chapters, custom domains, branding. |
| **Regions** (platform-only) | Curated region reference list, unverified region submissions, merging. |
| **People** | Members, addresses, dedup, merges. |
| **Giving setup** | Categories, types, payment methods, accounts/funds, service types, periods. |
| **Services** | Service events / meetings. |
| **Contributions** | Batches, contributions, lines, voids, reversals. |
| **Imports** | Import files, jobs, rows, failures, schedules, commits. |
| **Reports** | Saved reports, exports, dashboards. |
| **Targets** | Financial targets, ministry calendars, paying-in books, partnership progress. |
| **Audit** | Append-only audit events; per-tenant queries. |
| **Platform admin** | Zones (tenants), regions, plans, billing, support tickets. |
| **Notifications** | Email templates, transactional sends, future webhooks. |
| **Billing** | Plans, subscriptions, Stripe integration, per-zone pricing. |

Each context has:

- Drizzle schema in `packages/db/schema/<context>.ts`.
- Zod schemas in `packages/shared/<context>.ts`.
- Service module in `apps/api/src/<context>/` exposing pure functions, taking the `AuthorizedContext`.
- Routes in `apps/api/src/routes/<context>/`.
- UI feature folder in `apps/web/src/routes/...`.

---

## 7. API design

- Hono RPC. End-to-end type safety via `hc<typeof app>` client in the web app.
- Resource-oriented routes (`/api/contributions`, `/api/imports/:id/rows`).
- All bodies and queries validated through Zod.
- Pagination: cursor-based on `(created_at, id)` for hot tables, offset-based for small reference tables.
- Standard error envelope `{ error: { code, message, details? } }`.
- Idempotency keys on POST endpoints that create financial records.

---

## 8. Money and decimal handling

| Rule |
|---|
| Store money as `numeric(19,4)` in PostgreSQL, paired with `currency_code text not null` (ISO 4217). |
| Never use JavaScript `number` for money math. |
| Use [`decimal.js`](https://mikemcl.github.io/decimal.js/) or `dinero.js` v2 inside the API for any arithmetic. |
| The wire format between API and UI is `{ amount: string, currency: string }` (e.g. `{ amount: "1234.5600", currency: "GBP" }`). |
| Default currency is set on the **zone**; can be overridden per `account` (fund). Each contribution carries its own currency, defaulting from the zone but never inferred. |
| Reports never sum across currencies. Mixed-currency totals are shown as per-currency subtotals. FX conversion is v1.1. |
| Round once, at presentation time, with banker's rounding by default. |

---

## 9. Time and periods

- All timestamps in UTC. Display in the zone's time zone.
- Date-only fields (e.g. `service_date`, `statement_date`) stored as `date`.
- Periods (`giving_period`, `fiscal_period`, `ministry_period`, `partnership_period`) computed at zone setup and stored per-zone (one row per date in `giving_periods`). Materialized views for hot pivots can be added in v1.1.

---

## 10. Background jobs

- **pg-boss** schema in the same DB.
- Workers run in a separate process (`apps/api` can host them, or a dedicated worker service in production).
- Job types:
  - `import.parse` — read uploaded file, populate `import_rows`.
  - `import.match` — resolve members/chapters/giving types per row.
  - `import.commit` — atomic post into contributions.
  - `report.generate` — produce Excel/PDF, store in object storage, notify user.
  - `member.statement.generate` — annual statement PDFs.
  - `email.send` — branded transactional sends via useSend.
  - `region.fanout` — propagates a zone's region change to denormalized `region_id` columns.
  - `audit.replay` — debug helper to re-derive an audit summary.
- Jobs are tenant-scoped (`zone_id` in payload). Workers refuse to run jobs whose payload doesn't match the tenant context.

---

## 11. Storage layout

```txt
s3://steward-prod/
├── tenants/
│   └── {zone_id}/
│       ├── imports/
│       │   └── {import_file_id}/{original_name}
│       ├── reports/
│       │   └── {yyyy}/{mm}/{report_id}.xlsx|.pdf
│       ├── statements/
│       │   └── members/{member_id}/{year}.pdf
│       └── exports/
│           └── {export_id}.zip
└── platform/
    └── ...
```

- Pre-signed download URLs for in-app viewing.
- Lifecycle rule: temp imports expire after 90 days; permanent reports retained for 7 years (configurable per zone).

---

## 12. Auth and session

- Better Auth on the API.
- Email OTP for finance roles by default; password optional.
- Session cookies are host-only. Custom domains work because we never set `Domain=`.
- 35-day session by default; configurable per zone in v1.1.
- Session expiring banner triggered 5 minutes before expiry.
- Sign-in is global (one user, many zones). After authenticating, if the user has bindings in multiple zones, they pick one to enter.

### 12.1 Middleware stack

Four Hono middlewares compose every request, in this order:

| Middleware | Sets `c.var.` | Used by |
|---|---|---|
| `tenantMiddleware` | `tenant: { zoneId, zoneSlug, regionId }` resolved from Host (subdomain or custom domain) | tenant routes only |
| `requireSession` | `user: { id, email, isSuperAdmin }` from Better Auth | tenant + admin routes |
| `requireTenantAuth` | `auth: AuthorizedContext` (union of role codes + chapter ids in this zone) | tenant routes |
| `requirePlatformRole(...)` | (asserts only) | admin routes |

Route groups:

- `/api/public/*` — no session, no tenant. Signup, regions typeahead, invitation lookup/accept.
- `/api/tenant/*` — `tenantMiddleware → requireSession → requireTenantAuth`.
- `/api/admin/*` — `requireSession → requirePlatformRole(super_admin, region_curator, ...)`. Cross-zone reads are allowed here and only here.

### 12.2 Invitations

All user onboarding goes through the `invitations` table (see DOMAIN-MODEL.md §2.6):

- **Public signup** writes a `zone_owner` invitation pinned to the primary contact email and emails an opaque 32-byte URL-safe token. The raw token only appears in the email; the DB stores its SHA-256 hash.
- **Team invitations** are issued by zone owners/admins via `POST /api/tenant/invitations` and follow the same accept flow.
- **Acceptance** runs Better Auth `signUpEmail` with the email pinned by the invitation, then writes the role binding atomically. A `zone_owner` accept also flips the zone from `pending_setup` to `active` and sets `users.default_zone_id`.

---

## 13. Audit

- Single append-only `audit_events` table per tenant (one shared table, scoped by `zone_id`).

```txt
id uuid pk
zone_id uuid
actor_user_id uuid nullable
actor_role_code text nullable
ip_address inet nullable
user_agent text nullable
request_id text nullable
action text                          -- e.g. "contribution.create"
entity_type text                     -- e.g. "contribution"
entity_id uuid
before jsonb nullable
after jsonb nullable
reason text nullable
occurred_at timestamptz default now()
```

- Triggers in Drizzle migrations write changes to `audit_events` for sensitive tables.
- API service helpers also write semantic audit entries for actions that span multiple rows.
- Postgres `pg_audit` is **not** required (overkill for our use).

---

## 14. Observability

- Structured pino JSON logs with `request_id`, `zone_id`, `actor_id`.
- OTel tracing in v1.1 (Tempo + Grafana).
- Health endpoints: `/health/live`, `/health/ready`, `/health/db`.
- Per-zone usage telemetry (anonymized) for capacity planning.

---

## 15. Deployment

- Production deployment uses Docker Compose on Dokploy; the operator runbook lives in [`DEPLOYMENT.md`](DEPLOYMENT.md).
- Dockerfiles:
  - `Dockerfile.api` builds the Hono API image and includes Drizzle schema/migration assets for migration jobs.
  - `Dockerfile.web` builds the SvelteKit adapter-node web image.
- `docker-compose.prod.yml` defines explicitly named StewardLedger services:
  - `stewardledger-postgres` — bundled PostgreSQL 17 with the persistent `pgdata` volume.
  - `stewardledger-api-migrate` — one-shot service that runs `db:migrate` and `db:bootstrap` before the API starts.
  - `stewardledger-api` — Hono API service with `/health/ready` healthcheck and persistent `app_storage` volume.
  - `stewardledger-web` — SvelteKit SSR service.
- This Dokploy setup bundles Postgres in the Compose app. Future environments can switch to managed Postgres by changing `DATABASE_URL` and removing the bundled database service in a reviewed deployment change.
- The future `worker` service is deferred until a worker entrypoint exists; background-job infrastructure remains planned for the later jobs phase.
- Dokploy routing:
  - Route the web domain to `stewardledger-web:3000`.
  - Route the API domain to `stewardledger-api:3000`.
  - Do not expose `stewardledger-postgres` publicly.
- Deploy strategy: blue/green at the container level (Dokploy zero-downtime).

---

## 16. Environments

| Env | Purpose |
|---|---|
| local | dev with Docker Postgres |
| ci | ephemeral Postgres on GitHub Actions |
| staging | one Dokploy app, single shared Postgres, sample tenants |
| prod | one Dokploy app, primary Postgres, multiple tenants |

Legacy Church Plus is **not** a data source for StewardLedger. The legacy domain is documented as design reference in [`DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md).

---

## 17. Security baseline

- Secrets only in env vars, managed via Dokploy.
- No secrets in repo. Pre-commit secret scanner in CI.
- All inputs Zod-validated.
- CSRF on form submits; SameSite=Lax cookies.
- Strict CSP with nonces.
- `helmet`-equivalent middleware (Hono has built-in helpers).
- Rotate Postgres password quarterly.
- Audit all access to PII via the audit log.

Full plan in [`docs/SECURITY.md`](SECURITY.md) (drafted in v1 build phase).

---

## 18. What we explicitly avoid

- No stored procedures for business logic. Procedures are reserved (rarely) for performance hot paths and must be reviewed by the team.
- No direct triggers as a substitute for application logic; triggers exist only for `audit_events` capture and posted-record immutability enforcement.
- No `money` or `float` for money. Always `numeric(19,4)` paired with `currency_code`.
- No hidden cross-database calls; everything in one DB, one `zone_id` filter.
- No silent merges or deletes. All such operations go through review/approval queues.
- No data import from the legacy Church Plus app. StewardLedger is a new product; legacy is reference, not source.
