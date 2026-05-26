# Kickoff prompt — begin the ChurchPlus port plan

Paste the prompt below into a fresh Claude Code (or other agent) session whose **CWD is the StewardLedger repo root** (`/home/bryan/workspace/stewardledger`).

It is designed to:

- Orient the agent on the project's non-negotiables before any code is written.
- Force a written plan + confirmation gate before any file is changed.
- Start on the highest-leverage v1 GA blocker (families / households).
- Stay on a feature branch, one PR per item.

> Tip — use the `verification-before-completion` and `test-driven-development` skills if your agent supports skill injection. They are already in this repo's superpowers folder.

---

## Master kickoff prompt (paste this)

```text
You are working inside the StewardLedger monorepo. Before any code is
written, read these files in full and confirm understanding back to me:

  1. AGENTS.md                                      — the non-negotiables.
  2. docs/PRD.md                                    — product framing.
  3. docs/ARCHITECTURE.md                           — package boundaries.
  4. docs/DOMAIN-MODEL.md                           — tenant + money rules.
  5. docs/DOMAIN-REFERENCE.md                       — Church Plus legacy.
  6. docs/ROADMAP.md                                — current phase + exits.
  7. docs/CHURCHPLUS-PORT-NOTES.md                  — the port plan.
  8. docs/REPORTS.md                                — report-spec pattern.
  9. packages/db/src/schema/*.ts                    — existing tenant FK shape.
 10. packages/api/src/services/imports/*.ts         — import pipeline shape.
 11. packages/api/src/services/reports/registry.ts  — how features land.

Non-negotiables you must respect for every change you make:

  - Money is numeric(19,4) + explicit currency_code. Never widen, never
    silent-FX. Use decimal.js via the existing addMoney helper.
  - Every new table is zone-scoped. Cross-table FKs use the composite
    (zone_id, child_id) → UNIQUE(zone_id, id) pattern that already exists
    in members.ts / chapters.ts. Verify by reading those two files first.
  - Posted contributions are immutable; corrections happen via reversal.
    Triggers in packages/db/drizzle enforce this; don't bypass them.
  - All business logic in TypeScript services, not in SQL stored procs.
  - Tests live next to code. New features need unit + integration tests,
    including a cross-tenant fuzz case where the table is sensitive.
  - File headers: every new file starts with the 4-line header described
    in AGENTS.md (path, purpose, RELEVANT FILES list).
  - Single design system. No ad-hoc tailwind tokens like text-slate-*;
    use the Ledger Editorial tokens defined in tailwind.config + DESIGN.md.

Workflow rules:

  - Branch-first. Never commit on main. Use feat/<short-name>.
  - One PR per port item. Do not bundle.
  - Write a plan as a Markdown doc under docs/plans/ before writing code.
    Use the existing plans there as the template.
  - Stop after the plan and wait for my approval. Do not start coding
    until I say "proceed".

Now do this first task and stop:

  TASK A — Read the files above, then write a plan file at
  docs/plans/<today>-families-households-v1.md that covers:

    1. Scope summary (1 paragraph) tied to
       docs/CHURCHPLUS-PORT-NOTES.md §2.2.1 and to the Phase 10 exit
       checklist item "Family / household grouping".
    2. Data model: proposed Drizzle schema for `families` and
       `family_members`, including the composite tenant FK pattern,
       partial unique indexes (e.g. one primary contact per family),
       and the audit_events shape for changes.
    3. Migration plan: which Drizzle migration number, any backfill,
       and how legacy Church Plus rows (if any are imported later) map
       in. Reference docs/CHURCHPLUS-PORT-NOTES.md §5 open questions
       about family granularity and answer them.
    4. API surface: list the routes under /api/tenant/families, the
       Zod request/response shapes, role gating
       (see packages/api/src/services/access.ts for the existing
       predicates), and where the access-check helper lives.
    5. Report impact: which existing reports gain a `family_id`
       grouping option, plus the new "Top Family Report" as a fresh
       ReportSpec entry in registry.ts.
    6. UI surface: which routes change under /zone/members and
       /zone/families, listed by file path, and what the Svelte 5
       components look like (composition, no new design tokens).
    7. Test plan: unit, integration, cross-tenant fuzz, and the
       report golden-file additions.
    8. Out-of-scope (explicit non-goals; keep it small).
    9. Risks and rollback (drop column / drop table is acceptable
       because no real data exists yet).
   10. Exit checklist tied to the Phase 10 line in docs/ROADMAP.md.

  Then stop and print:

    "Plan written to docs/plans/<filename>. Awaiting approval to
     proceed. Reply 'proceed' to begin implementation, or paste
     edits inline."

  Do NOT touch any code under packages/ in this first task.

After I approve TASK A, you will:

  - Create branch feat/families-households.
  - Implement in this order: schema → migration → service →
    routes → tests → UI → report → docs/ROADMAP.md tick.
  - Run `pnpm -w lint && pnpm -w typecheck && pnpm -w test` before
    opening the PR.
  - Open the PR with a body that mirrors the plan's exit checklist.

If at any point you are unsure, ASK before assuming. Better to pause
than to drift from the conventions.
```

---

## Follow-on prompts (use one per port item, in order)

After TASK A ships, use one of these short prompts to start the next item. Each one reuses the same conventions; the agent should already have them in context if you stay in the same session.

### Bulk template download centre (Phase 10 GA blocker)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.2.2 and the Phase 10 exit checklist
"Bulk template download centre", produce a plan file at
docs/plans/<today>-template-download-centre-v1.md, then stop.

Scope: one-click empty-template downloads for every registered importer
(bank statement parsers + the new envelope-batch parser from §2.2.3).
Surface on /zone/imports and /church/imports. No new design tokens.
Templates ship as XLSX with frozen-header branded sheets using the
existing addBrandedSheet helper.

Follow the same plan structure as families. Stop after the plan.
```

### Bulk slip / envelope import (Phase 10 GA blocker)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.2.3 and the Phase 10 exit checklist
"Bulk slip / envelope import", produce a plan file at
docs/plans/<today>-envelope-import-v1.md, then stop.

Scope: plug an envelope-batch parser into the existing upload → match
→ schedule → commit pipeline. Surface as a new tab on /church/imports.
Reuse processed_transactions idempotency. Out of scope: any change to
the bank-statement parser.

Follow the same plan structure as families. Stop after the plan.
```

### Member email verification, double opt-in (Phase 10 GA blocker)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.2.4 and the Phase 10 exit checklist
"Member email verification", produce a plan file at
docs/plans/<today>-member-email-verification-v1.md, then stop.

Scope: add `members.email_verification_status`, token issue/verify
endpoints, rate-limited resend, GDPR-aligned audit trail. Reuse useSend
adapter. This is a hard dependency for Phase 11 broadcasts + campaign
reminders, so the audit shape must be future-proof for those.

Follow the same plan structure as families. Stop after the plan.
```

### Bespoke letter-style member statement PDF (Phase 7 GA blocker, promoted)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.2.5 and the Phase 7 line
"Bespoke letter-style member statement PDF (GA blocker)", produce a plan
file at docs/plans/<today>-member-statement-pdf-bespoke-v1.md, then stop.

Scope: Playwright + HTML/CSS template at
packages/pdf/templates/member-statement.html, rendered via
packages/api/src/services/reports/pdf/member-statement.ts. Reuse
branding inputs from services/reports/branding.ts. Side-by-side
visual comparison to the legacy ChurchPlus statement must be part of
the acceptance test set; commit a redacted PDF golden file under
packages/api/src/services/reports/__fixtures__/.

Follow the same plan structure as families. Stop after the plan.
```

### Online giving + Stripe Connect (Phase 11, v1.1)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.3.1 and the Phase 11 deliverable
"Online giving (public donation flow) + Stripe Connect per-zone account",
produce a plan file at docs/plans/<today>-online-giving-v1_1.md, then
stop.

Scope: public /:zone/donate page, payment-intent flow, webhook
reconciliation, refund→reversal mapping, per-currency handling. Stripe
Connect Express per zone so funds settle to the zone, not to us. Out
of scope: campaigns (separate plan; will reference this one).

Follow the same plan structure as families. Stop after the plan.
```

### Fundraising campaigns (Phase 11, v1.1)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.3.2 and the Phase 11 deliverable
"Fundraising campaigns", produce a plan file at
docs/plans/<today>-fundraising-campaigns-v1_1.md, then stop.

Scope: time-boxed asks distinct from partnership: `campaigns`,
`campaign_targets` (zone / group / chapter scope), campaign-tagged
contributions, campaign progress reports, reminder cron. Hard
dependency on the online-giving plan and the email-verification plan.

Follow the same plan structure as families. Stop after the plan.
```

### Member email broadcast + reminders (Phase 11, v1.1)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.3.3 and the Phase 11 deliverable
"Member email broadcast + reminders", produce a plan file at
docs/plans/<today>-broadcasts-reminders-v1_1.md, then stop.

Scope: chapter- or zone-scoped sends to verified members only;
queued workers with per-zone send-rate caps; preview + dry-run
mandatory; MFA-required to raise the cap. Hard dependency on the
member-email-verification plan.

Follow the same plan structure as families. Stop after the plan.
```

### Custom bank accounts per chapter (Phase 11, v1.1)

```text
Per docs/CHURCHPLUS-PORT-NOTES.md §2.3.4 and the Phase 11 deliverable
"Custom bank accounts per chapter", produce a plan file at
docs/plans/<today>-custom-bank-accounts-v1_1.md, then stop.

Scope: `bank_accounts` metadata table (zone, chapter?, currency,
IBAN / sort code / account number) linked from imports and contribution
batches. Migrate the existing import flow so a stored bank account is
selectable on upload, not free-typed.

Follow the same plan structure as families. Stop after the plan.
```

---

## Why "plan first, then stop"

This convention exists for three reasons:

1. The non-negotiables in `AGENTS.md` (money shape, tenant FK shape, posted-immutable, single design system) cost more to undo than to plan. Better to argue about the schema diagram than the migration.
2. Every plan landed under `docs/plans/` becomes auditable trail for the audit log report itself once we ship. The repo eats its own dogfood.
3. The agent is far more accurate when forced to write the plan before the code. Empirically observed across the existing plan files.
