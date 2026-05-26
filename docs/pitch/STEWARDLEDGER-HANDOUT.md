---
marp: true
theme: default
paginate: false
size: A4
title: StewardLedger — One-Page Handout
description: Single-page take-away for Pastor.
---

<style>
section { font-size: 15px; padding: 18mm; }
h1 { font-size: 22px; margin: 0 0 4px 0; }
h2 { font-size: 14px; margin: 10px 0 4px 0; text-transform: uppercase; letter-spacing: 0.05em; color: #6b5b1f; }
table { font-size: 12.5px; width: 100%; border-collapse: collapse; }
th, td { padding: 3px 6px; text-align: left; vertical-align: top; }
th { border-bottom: 1px solid #c9a010; }
td { border-bottom: 1px solid #e5e0d4; }
ul { margin: 4px 0 8px 18px; padding: 0; }
li { margin: 0 0 2px 0; }
.tagline { font-style: italic; color: #4a4a6a; margin: 0 0 10px 0; }
.foot { font-size: 11px; color: #777; margin-top: 14px; border-top: 1px solid #e5e0d4; padding-top: 6px; }
</style>

# StewardLedger — The Church Finance Ledger

<p class="tagline">From a single member's giving to a zone's annual partnership — recorded once, traceable forever, reportable in seconds.</p>

## What it is

A modern, multi-tenant SaaS platform for church finance and stewardship. Built on the same domain wisdom as Church Plus, on a stack designed for many zones, audit-grade integrity, and the next decade.

## Why now

Church Plus v1 served faithfully. A v2 is in progress on the same single-tenant Frappe platform. **StewardLedger is a respectful second option** for Pastor to evaluate side by side — one platform for every zone, not one install per zone.

## How they compare

| | **Church Plus v2** | **StewardLedger** |
|---|---|---|
| Tenant model | One install per zone | One platform, every zone is a tenant |
| Multi-currency | Workarounds | Native, per-currency subtotals |
| Posted records | Mutable (developer discipline) | Immutable, enforced at the database |
| Audit trail | Per-table triggers | Single append-only log per zone |
| GDPR export & erase | Manual procedure | Built-in workflow |
| Reports | Tabular Frappe reports | 14 first-class reports in Excel + PDF |
| Business logic | Server scripts | TypeScript services with tests |
| MFA | Add-on | Per-zone, role-aware |
| Onboarding a new zone | Hours-to-days | Minutes |
| Hire pool | Frappe specialists | TypeScript + PostgreSQL |

## What's shipping today

- Multi-tenant zone / region / chapter / group / member hierarchy.
- Posted-immutable contributions with draft → submitted → approved → posted → voided / reversed.
- Bank-statement import pipeline: upload → match → schedule → commit / rollback.
- 14 reports in Excel + PDF (member statement, partnership progress, top partners, weekly finance, audit log, and more).
- Per-zone dashboards, audit search, data-export bundles, GDPR erasure workflow, MFA.

## What's planned

- **v1 GA blockers**: bespoke letter-style member-statement PDF, families & Top Family report, bulk template downloads, envelope bulk import, member email verification.
- **v1.1**: online giving + Stripe, fundraising campaigns, broadcasts & reminders, per-chapter bank accounts.
- **v1.2**: cross-currency reporting. **v2**: full double-entry accounting.

## Adoption strategy — gentle, parallel, reversible

1. **Pilot (2 weeks)** — one chapter, alongside Church Plus, no fee, explicit decision gate at the end.
2. **One zone (4–6 weeks)** — full zone runs on StewardLedger as system of record. Other zones stay on Church Plus.
3. **Multi-zone (Pastor's pace)** — other zones move when ready; nothing is forced.

The existing developer team can stay involved as **domain consultants, plugin authors, and migration partners**. This is co-existence first.

## What we're asking today

1. A 45-minute live walkthrough with you and one finance officer.
2. Permission to run a 2-week pilot on one chapter — no fee, no commitment.
3. A nominated decision-gate date. If you say no, we walk away professionally.

<p class="foot">
StewardLedger is built by Tickideas on TypeScript, PostgreSQL, SvelteKit, Hono, Better Auth, and Docker — the same stack that powers <em>echurcher</em>. Data ownership stays with the zone; export bundles are available on demand. Full deck: <code>docs/pitch/STEWARDLEDGER-PITCH.md</code>.
</p>
