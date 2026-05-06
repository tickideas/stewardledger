# Brand

> Naming, casing, and wordmark rules for **StewardLedger**.
> Companion to [`PRD.md`](PRD.md).
> This document is normative. If anything below conflicts with code, marketing, or other docs, fix the code/marketing/docs.

---

## 1. Product name

**StewardLedger.**

One word. Capital `S`, capital `L`, no space.

### Why this name

- **Self-describing.** Treasurers and finance officers understand it in two seconds.
- **"Steward"** is the word the buyer audience already uses in board meetings; biblical resonance without being kitschy.
- **"Ledger"** anchors it in finance and avoids confusion with non-finance "Steward*" products.
- **Domain is clean.** `stewardledger.church` is on-brand and sidesteps the crowded `.com` space.

### Tagline (working)

> **The church finance ledger. From a single member's giving to a zone's annual partnership — recorded once, traceable forever, reportable in seconds.**

Short forms acceptable in marketing:

- "The church finance ledger."
- "Stewardship, recorded right."
- "Where every gift is counted."

---

## 2. Wordmark casing

**Always `StewardLedger`** (camel-case, capital S and L).

### Why camel-case

- Signals "two words joined" so the eye parses it on first glance.
- All-lowercase ("stewardledger") is harder to read — the brain stumbles finding the word boundary.
- Two-word "Steward Ledger" is a marketing phrase, not a brand; never use it as a wordmark.
- Camel-case has a long pedigree in software brands: PayPal, YouTube, FaceTime, MailChimp, MongoDB, JavaScript, GitHub, JotForm, AdSense.
- The lowercase-everything aesthetic (stripe, vercel, linear) is a 2020s indie-tooling convention; it doesn't fit a finance product sold to pastors and treasurers.

---

## 3. Casing rules by context

| Context | Casing | Example |
|---|---|---|
| Wordmark / logo | **`StewardLedger`** | "Welcome to StewardLedger" |
| Page titles, headlines | **`StewardLedger`** | "Why StewardLedger" |
| Running prose | **`StewardLedger`** | "Your zone's StewardLedger account…" |
| First sentence of a doc | **`StewardLedger`** | "StewardLedger is the church finance ledger." |
| Domains | lowercase | `stewardledger.church` |
| Subdomains / tenant slugs | lowercase, kebab-case | `uk-zone-1.stewardledger.church` |
| API host | lowercase | `api.stewardledger.church` |
| Demo host | lowercase | `demo.stewardledger.church` |
| Email senders | lowercase | `support@stewardledger.church` |
| GitHub org | lowercase | `stewardledger` |
| Repo name | lowercase | `tickideas/stewardledger` |
| npm scope | lowercase | `@stewardledger/db` |
| Docker image | lowercase | `stewardledger/api`, `stewardledger/web` |
| Database name | lowercase, snake_case | `stewardledger`, `stewardledger_test` |
| Env var prefix | UPPER_SNAKE | `STEWARDLEDGER_API_URL`, `STEWARDLEDGER_DB_URL` |
| Code identifiers (vars/functions) | camelCase | `stewardLedgerConfig`, `getStewardLedgerSession` |
| Code identifiers (types/classes) | PascalCase | `StewardLedgerClient`, `StewardLedgerSession` |
| File names | kebab-case | `steward-ledger-config.ts`, `steward-ledger-session.test.ts` |
| Social handles | lowercase | `@stewardledger` (X, Instagram, LinkedIn) |
| Slack workspace / Discord | mixed-case ok | `StewardLedger HQ` |

---

## 4. Hard rules — never do

- ❌ `Stewardledger` (broken — looks like a typo).
- ❌ `STEWARDLEDGER` (except as an env-var prefix).
- ❌ `stewardledger` in user-facing prose, headlines, or buttons (lowercase domains/handles only).
- ❌ `Steward Ledger` (with a space) as a brand. Acceptable only as descriptive prose: "a steward of the ledger".
- ❌ `Steward-Ledger` (hyphenated).
- ❌ `Steward_Ledger` (underscored, except programmatically inside env vars).
- ❌ `STEWARD LEDGER` (all caps with space) on any user-facing surface.
- ❌ Abbreviating to `SL`. There is no abbreviation.
- ❌ Calling the product "Steward" alone — it loses the financial meaning and clashes with many existing products.

---

## 5. Voice and tone

- **Voice**: clear, calm, and competent. Like a senior accountant who explains things plainly.
- **Tone**: warm with finance audiences, factual with admins. Avoid hype.
- **Avoid**:
  - emoji in product copy (allowed in marketing, never in receipts/statements/audit emails)
  - "amazing", "revolutionary", "magical", "next-gen"
  - corporate hedge language ("solutions", "leveraging", "synergies")
  - "deliver value", "drive outcomes" — finance buyers see through this
- **Prefer**:
  - "record", "post", "reconcile", "report", "audit"
  - "your zone", "your chapter", "your members", "your giving"
  - active voice; short sentences

---

## 6. Logo and visual identity

> Working brief. Final logo TBD.

Direction:

- **Mark**: a stylised ledger line / underline that doubles as a "stroke under steward". Avoid coin/dollar/cross iconography (already overused in church-tech and locks the brand in).
- **Type**: a humanist sans-serif with strong numerals (Inter, Söhne, or similar). Numbers must be legible — this is a finance product.
- **Palette**: one trust colour (deep blue or forest green), one warm accent for positive amounts, one warning amber for unmatched/duplicate states. Strict: no more than five tokens in production UI.
- **Layout**: generous whitespace, dense data tables, no bouncing animations on financial numbers.

Echurcher's brand should not bleed into StewardLedger; they share an operator but they're different products with different audiences.

Detailed brand kit (logo files, palette tokens, type scale) lives in `assets/brand/` once the logo is finalised.

---

## 7. Tenant-side branding

A zone can override the following per its own subdomain or custom domain:

- Zone logo (replaces StewardLedger logo on the zone's screens, member statements, and emails).
- Zone display name.
- Optional accent colour (constrained to a curated set in v1).

The StewardLedger wordmark stays in:

- The footer of every page ("Powered by StewardLedger").
- The footer of every email ("Sent via StewardLedger").
- The bottom of every PDF report ("Generated by StewardLedger on {date}").

Per-chapter branding overrides are out of scope for v1 (chapters inherit the zone's branding).

---

## 8. Domain registration & defensive holdings

Register and hold (already prioritised in [`ROADMAP.md`](ROADMAP.md) Phase 0):

- `stewardledger.church` — primary
- `stewardledger.com` — defensive
- `stewardledger.app` — defensive
- `stewardledger.io` — defensive

Reserve handles and namespaces:

- GitHub org: `stewardledger`
- npm scope: `@stewardledger`
- X / Twitter: `@stewardledger`
- LinkedIn company page: `stewardledger`
- Instagram: `stewardledger`
- Product Hunt: `stewardledger`

Trademark filing (US USPTO, UK IPO, EU EUIPO): classes **9** (software) and **36** (financial services). Search first; file before public marketing launch.

---

## 9. Naming sub-features

When naming features inside the product, follow these patterns:

| Concept | Convention | Example |
|---|---|---|
| Module / page | Plain English noun phrase | "Contributions", "Imports", "Member Statements" |
| Action | Verb-first, plain | "Post Batch", "Reverse Contribution", "Import Statement" |
| File name (export) | `{zone-slug}-{report}-{date}.{ext}` | `uk-zone-1-weekly-finance-2026-05-04.xlsx` |
| API path | RESTful, plural, lowercase | `/api/contributions`, `/api/imports/:id/rows` |
| Job name | `{context}.{verb}` | `import.parse`, `report.generate` |
| Email subject prefix | `[{Zone Name}]` | `[UK Zone 1] Weekly finance report — 4 May 2026` |

Avoid:

- Cute/coded internal names ("Project Tabernacle"). The product has one name.
- "Steward" as a feature prefix ("StewardImports", "StewardReports") — the product is StewardLedger; the features are Imports, Reports, etc.

---

## 10. Quick reference card

```txt
Brand        StewardLedger
Domain       stewardledger.church
Repo         tickideas/stewardledger
GitHub org   stewardledger
npm scope    @stewardledger
Tagline      The church finance ledger.
Audience     Zone owners, zonal finance officers, chapter treasurers.
Tone         Clear, calm, competent.
```

Print this. Tape it to the wall. If it ever feels off in a draft email, screen, or doc, the doc/screen/email is wrong, not the brand.
