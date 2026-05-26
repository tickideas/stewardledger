---
marp: true
theme: default
paginate: true
size: 16:9
title: StewardLedger — A Church Finance Ledger Built For The Next 10 Years
description: Pitch deck — why StewardLedger is the right next-step over Church Plus v2.
author: Tickideas
---

<!-- _class: lead -->

# StewardLedger

**The church finance ledger.**
From a single member's giving to a zone's annual partnership —
recorded once, traceable forever, reportable in seconds.

*A respectful proposal for the next chapter of Church Plus.*

---

## Why this conversation, and why now

- Church Plus has served the ministry faithfully for years.
- A v2 is in progress, built on the same Frappe / ERPNext platform the existing team knows.
- StewardLedger is a **complementary, modern alternative** built from the same domain understanding — but on a stack designed for SaaS, multi-zone growth, and audit-grade finance.
- We're not here to discredit anyone's work. We're here to offer the pastor a **second informed option** to compare side by side.

> *Goal of this meeting: give Pastor a clear, honest decision.*

---

## What the pastor actually needs

Not features. Outcomes.

1. **Confidence** that every gift is recorded and protected.
2. **Reports** treasurers and zonal officers can trust without ringing the developer.
3. **Multi-zone** capability without re-buying or re-installing the platform.
4. **Independence** from any single developer or vendor.
5. **Modernity** that age-proofs the system for the next decade.
6. **Cost predictability** as ministry footprint grows.

The rest of this deck is measured against those six.

---

## What StewardLedger is, in one breath

A brand-new, multi-tenant SaaS platform for church finance and stewardship.

| | StewardLedger |
|---|---|
| Tenant model | One platform, many zones |
| Money | `numeric(19,4)` + explicit currency, multi-currency from day one |
| Ledger | Posted contributions are immutable; corrections happen via reversal |
| Audit | Single append-only audit log per zone — every change traceable |
| GDPR | Built-in subject-data export and erasure workflows |
| Reports | 14 first-class reports already shipping in Excel **and** PDF |
| Imports | Upload → match → schedule → commit / rollback, idempotent |
| MFA | Per-zone enforcement, role-aware |
| Stack | TypeScript end-to-end, PostgreSQL, Docker, Dokploy |

---

## Where StewardLedger comes from

It's not a re-skin of Church Plus.
It is an **inheritor** of Church Plus's domain wisdom, rebuilt cleanly:

- We studied the live Church Plus database, the source code, and the way treasurers actually use it.
- We kept what worked — zones, chapters, members, envelopes, periods, partnership targets, the import flow shape — and dropped what didn't.
- The lessons live in `docs/DOMAIN-REFERENCE.md` and `docs/CHURCHPLUS-PORT-NOTES.md`.

Nothing was guessed. Every entity in the schema has a real legacy precedent.

---

## What Church Plus v2 most likely is

To be fair to the team building it:

- A Frappe / ERPNext application with a custom app on top, similar to v1.
- Designed and deployed **per zone** on Frappe Cloud or a self-hosted Frappe Bench.
- Customisation expressed as DocTypes, custom fields, server scripts, and client scripts.

That's a perfectly valid technology choice. It's also the same shape as v1 — which means it inherits v1's deepest structural limits.

We'll list those next.

---

## Where Church Plus v2 will hit walls

These are not slights. They are structural realities of the stack.

1. **Single tenant per install.** Two zones = two Frappe sites = two ops bills. Three = three. It does not scale on operations.
2. **Mutable financial records.** Frappe lets posted documents be edited or cancelled; financial integrity depends on developer discipline.
3. **Audit via per-table triggers.** Recoverable, but hard to query coherently.
4. **Business logic in server scripts.** Hard to test, hard to review, hard to hand over.
5. **Single-currency mindset.** Multi-currency requires per-account workarounds.
6. **Reports as Frappe Reports.** Tabular only; bespoke layouts need bolt-ons; Excel templates drift from code.
7. **GDPR is a manual procedure**, not a workflow.
8. **Customer lock-in** to whichever developer is closest to the code.

Each of these is a real risk over a 5-year horizon.

---

## Where StewardLedger answers each of those

| Risk in v2 | StewardLedger answer |
|---|---|
| Per-zone install | **One platform, every zone is a tenant.** Add a zone in minutes, not a new install. |
| Mutable financial records | **Posted records are immutable at the database**, enforced by triggers. Corrections happen via reversal. |
| Audit via triggers per table | **Single append-only audit log per zone.** One place to search, export, and report on. |
| Business logic in scripts | **Application-layer services in TypeScript**, strongly typed, with tests next to the code. |
| Single-currency mindset | **Multi-currency from day one**, every report shows per-currency subtotals, no silent FX. |
| Reports as Frappe reports | **14 first-class reports**, Excel **and** PDF, saved filters, background-generated when large, branded per zone. |
| GDPR manual | **GDPR data export + erasure workflows shipped**, with reversibility windows and full audit. |
| Developer lock-in | **Open, documented stack** (TypeScript, PostgreSQL, Drizzle, SvelteKit) with a public hire pool. |

---

## What's already built (real, today)

Not a slide of promises. These are landed features:

- Multi-tenant zone / region / chapter / group hierarchy.
- Members, families, paying-in books, reference codes.
- Giving categories, giving types, accounts, payment methods.
- Contribution batches with draft → submitted → approved → posted → voided / reversed.
- Bank-statement import pipeline (upload → match → schedule → commit / rollback).
- 14 reports in Excel + PDF, including: member statement, member finance summary, weekly finance, giving-by-chapter pivots, general ledger, envelope ledger, online giving ledger, top partners, top chapters, partnership progress, audit log, import reconciliation, member list.
- Per-zone dashboards, chapter dashboards, partnership-progress dashboard.
- Audit search at `/zone/audit`. Zone data export bundle. GDPR erasure requests. MFA per role per zone.
- Treasurer-friendly SvelteKit UI with collapsible nav, mobile drawer, branded theme.

---

## What's planned next, in order

We have a published roadmap, not a wish list. Excerpt:

**v1 GA blockers (Phase 7 → 10):**

- Bespoke letter-style member statement PDF (the most-printed document).
- Family / household grouping + Top Family report.
- Bulk template download centre.
- Bulk slip / envelope import.
- Member email verification (double opt-in).

**v1.1 — Hardening:**

- Online giving + Stripe Connect (public donation page per zone).
- Fundraising campaigns (time-boxed asks, distinct from partnership).
- Member email broadcasts + reminders.
- Custom bank accounts per chapter.
- Row-level security policies for sensitive tables.

**v1.2 — FX & multi-currency reporting.**

**v2 — Full double-entry accounting layer.**

---

## Architectural posture (one slide, for technical reviewers)

For Pastor's technical advisors.

- **Language**: TypeScript strict, end-to-end. Same shape as `echurcher`.
- **API**: Hono on Node 22 LTS, Zod-validated.
- **Web**: SvelteKit 2 (Svelte 5), Tailwind 4, "Ledger Editorial" design system.
- **DB**: PostgreSQL 17, Drizzle ORM, every table has `zone_id`, composite tenant FK on every cross-table reference.
- **Auth**: Better Auth (email OTP, magic link, password). MFA via TOTP, per-zone enforcement.
- **Jobs**: pg-boss (Postgres-native, no Redis required).
- **Files**: S3-compatible (R2 / B2 / MinIO).
- **Email**: useSend (self-hosted).
- **Hosting**: Docker on Linux + Dokploy. Same stack as `echurcher`, so ops cost is shared.
- **CI**: GitHub Actions, lint + typecheck + tests + Docker build on every commit.

---

## Modular and adaptable, by construction

Pastor specifically asked: *"it needs to be modular and adaptable."*

That's why we designed:

- **Bounded contexts**: identity, tenancy, members, giving setup, contributions, imports, reports, dashboards, audit, billing — each is a separate package or service folder.
- **Pluggable importers**: every bank/statement format is a parser plugin in `packages/api/src/services/imports/parsers.ts`. Add a new bank by writing one parser.
- **Pluggable reports**: every report is a `ReportSpec<F, R>`. Add a report by writing one file and registering it.
- **Per-zone configuration**: ministry year start month, reference code format, currencies, MFA enforcement, retention policy, branding — all per zone.
- **Future double-entry accounting** slots in as a new bounded context without rewrites (Phase 13).

---

## Adoption strategy — gentle, parallel, reversible

We're not asking for a Big Bang migration.

### Phase A — Pilot (2 weeks)

- Stand up one StewardLedger zone for **one chapter or one church group** that's willing to evaluate.
- Mirror live activity in StewardLedger alongside Church Plus v1 / v2.
- Pastor's team uses StewardLedger reports for one weekly close and one monthly partnership summary.
- Decision gate: continue or stop, no commitment beyond the pilot.

### Phase B — One zone (4–6 weeks)

- Onboard a complete zone into StewardLedger.
- Import historical data (or start fresh — Pastor's call).
- Run StewardLedger as the **system of record** for that zone.
- Keep Church Plus running for other zones.

### Phase C — Multi-zone (per pastor's pace)

- Other zones move when ready.
- We continue to **support Church Plus** reads via a one-way data feed if needed.
- No zone is forced to move; no zone is left behind.

---

## What this looks like for the existing dev team

We want a respectful answer to this question.

- StewardLedger is **not** a job replacement. It's a platform.
- The existing developers can be part of:
  - **Domain consultancy** during the pilot.
  - **Custom report and importer plugins** (each is one file).
  - **Data migration tooling** from Church Plus.
- The skills required are TypeScript, PostgreSQL, and SvelteKit — well-documented, easy to ramp.
- We can offer paired sessions to ramp the team if Pastor wants continuity.

This is a deliberate "co-existence first" strategy.

---

## Risks we acknowledge openly

| Risk | Mitigation |
|---|---|
| StewardLedger is younger than Church Plus | All financial paths reviewed in pairs; Phase 9 GDPR + audit + immutability already shipped before GA. |
| New stack for the existing team | TypeScript and PostgreSQL have a vastly larger hire pool than Frappe specialists. |
| Migration complexity from Church Plus data | ETL is scoped and documented in `docs/CHURCHPLUS-PORT-NOTES.md`. We can do it in stages. |
| Internet dependence | Mitigated by SaaS-grade backups, daily offsite snapshots, export bundles per zone. |
| Lock-in to Tickideas | Mitigated by **export bundle ownership**: every zone can leave with their data in one click. |
| Cost growth | Flat fee per active zone, annual prepay default, transparent pricing. |

---

## Why **not** continue with Church Plus v2

We say this with respect to the team building it.

- It will land. It will probably work for one or two zones.
- But the **third zone** will cost as much to operate as the first two combined.
- The **fifth year** will see the same maintainability decline as Church Plus v1.
- Every customisation will live in DocTypes, server scripts, and tribal knowledge — not in tested, reviewable code.
- The **legal exposure** (GDPR, audit trail integrity) will sit with Pastor's organisation, not the developers.

Choosing StewardLedger is not a vote against the developers. It's a vote for a **platform shape** that fits the ministry's next decade.

---

## What we're asking from Pastor today

Not a contract. Three things:

1. A **45-minute live walkthrough** of StewardLedger with you and one finance officer of your choice.
2. Permission to run a **2-week pilot** alongside Church Plus on one chapter or church group.
3. A nominated **decision gate date**: at the end of the pilot, you tell us go / no-go. No pressure. No fees during the pilot.

If you say no, we walk away professionally and Church Plus v2 continues unaffected.

---

## Commercial shape (transparent)

- Pricing model: **flat fee per active zone, per year**.
- Tiers: Founding (current cohort), Standard, Premium.
- Annual prepay default; quarterly available.
- No setup fees during pilot.
- Custom domain (e.g. `finance.yourministry.org`) is a paid feature, not a forced one.
- Data ownership: **the zone owns its data**. Export bundle is available on demand at any time.
- Cancellation: rolling, no minimum after year one.

Exact numbers are in the separate pricing sheet shared with Pastor's office.

---

## Comparison at a glance

| | **Church Plus v2** | **StewardLedger** |
|---|---|---|
| Tenant model | One install per zone | One platform, every zone is a tenant |
| Multi-currency | Workarounds | Native, with per-currency subtotals |
| Posted-record integrity | Developer discipline | Enforced at the database |
| Audit | Per-table triggers | One append-only log |
| GDPR | Manual | Built-in workflow |
| Reports | Tabular Frappe reports | 14 reports in Excel + PDF |
| Custom layouts | Workarounds | First-class via Playwright |
| Business logic | Server scripts | TypeScript services with tests |
| MFA | Add-on | Per-zone role-aware |
| Onboarding a new zone | Hours-to-days | Minutes |
| Owner of the code | The developer who wrote it | Documented platform |
| Future hire pool | Frappe specialists | TypeScript + Postgres |

---

## The closing thought

Pastor — Church Plus v1 has been a faithful tool.
We are honouring that tool by carrying forward what works and rebuilding what doesn't.

StewardLedger is not a replacement of people. It is a platform that **scales with the ministry**, **stands up to an audit**, and **survives a developer transition**.

Ask us anything.

---

<!-- _class: lead -->

# Thank you.

**Next step:** book the 45-minute live walkthrough.
We'll bring the demo. Pastor brings the questions.
