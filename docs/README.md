# StewardLedger — design docs

> **StewardLedger** — brand-new, multi-tenant SaaS for church finance & stewardship.
> Primary domain: **`stewardledger.church`**.
> **Standalone product.** Not part of the [echurcher](https://github.com/tickideas/echurcher) monorepo.

## Reading order

1. **[`PRD.md`](PRD.md)** — what we are building, for whom, why, scope/non-scope of v1.
2. **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — stack, repo layout, multi-tenancy, deployment.
3. **[`DEPLOYMENT.md`](DEPLOYMENT.md)** — Dokploy deployment and operations guide.
4. **[`DOMAIN-MODEL.md`](DOMAIN-MODEL.md)** — full target schema (tables, columns, invariants).
5. **[`DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md)** — lessons distilled from the legacy Church Plus app, used as design reference only.
6. **[`REPORTS.md`](REPORTS.md)** — full report inventory and rebuild specs.
7. **[`ROADMAP.md`](ROADMAP.md)** — phased build plan with exit checklists.
8. **[`BRAND.md`](BRAND.md)** — normative naming, casing, and wordmark rules.

## Decisions locked in

| Decision | Value |
|---|---|
| Product name | **StewardLedger** |
| Primary domain | **`stewardledger.church`** |
| Hierarchy | **Region** (reference) → **Zone** (tenant) → **Chapter** → **Member** |
| Tenant boundary | Zone |
| Multi-currency | Yes, from launch (per-zone default; per-account override; per-currency report subtotals; FX deferred to v1.2) |
| Custom domains | Paid feature |
| Pricing | Flat fee per active zone |
| Billing default | **Annual prepay** |
| First cohort billing | **Invoice / bank transfer** (Stripe added at GA in Phase 10) |
| Trial | **None.** Public demo zone (`demo.stewardledger.church`) + guided paid onboarding instead. |
| Ministry year | Same in practice across Christ Embassy zones; **kept configurable per zone** for future denominations. |
| Cross-zone reports | **None.** Each zone is strictly siloed. Multi-zone visibility = explicit viewer bindings, not platform rollups. |
| Source data | None — StewardLedger is a brand-new product. Legacy Church Plus continues independently. |
| Stack | TypeScript + Hono + SvelteKit 2 + PostgreSQL 17 + Drizzle + Better Auth + pg-boss + useSend + Docker + Dokploy |
| Repo | `tickideas/stewardledger`; standalone; not part of the echurcher monorepo |

## Source artifacts (legacy reference)

Legacy Church Plus binaries and SQL schemas live in a separate workspace folder (`/home/bryan/workspace/churchfinsystem/`). They are reference material and are deliberately **not** part of this repo.

For decisions and inferred-domain notes, see [`DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md).
