# AGENTS — StewardLedger

Read before changing code. Full normative docs live in `docs/` (`PRD.md`, `ARCHITECTURE.md`, `DOMAIN-MODEL.md`, `REPORTS.md`, `ROADMAP.md`, `BRAND.md`, `DESIGN.md`). Update the relevant doc in the same PR as any behaviour change.

## Hard rules
1. Money is `numeric(19,4)` + `currency_code`; use `decimal.js` from `@stewardledger/shared`. Positive = inflow, negative = reversal; reversal abs amount must equal original.
2. Every domain table has `zone_id NOT NULL` (tenant boundary). No cross-tenant queries from tenant code.
3. Posted contributions are immutable — correct via `reversal_of_contribution_id`.
4. No stored-proc business logic; triggers only for audit, posted-record immutability, and invariants a CHECK can't express.
5. No secrets in repo (`.env.example`); no legacy Church Plus data import (reference only).
6. All web UI follows `docs/DESIGN.md` ("Ledger Editorial"): use `sl-*` primitives and `var(--*)` tokens from `packages/web/src/app.css`. No raw Tailwind slate/rose/emerald/amber colors, no `rounded-xl border bg-white` cards, no ad-hoc button/input styling. Copy a sibling page's skeleton before writing a new one.

## Code & workflow
- TS strict, Zod at API boundaries, Drizzle for DB (no raw SQL outside audit triggers). kebab-case files, camelCase vars, PascalCase types, UPPER_SNAKE env. Tests next to code (`foo.ts` + `foo.test.ts`). Split files >~400 lines.
- Every file starts with 4 comment lines: (1) exact path, (2) what it does, (3) why it exists, (4) `RELEVANT FILES:` with 2–4 related paths. Never delete these headers.
- Branch first: `git checkout -b feature/[name]`. Never commit to main. Commit per function/meaningful change. Conventional Commits: `type(scope): description`. PR title `[scope] short imperative`; financial paths need a second reviewer.
- Before marking a task complete: run `pnpm lint`, `pnpm check`, `pnpm test` (test DB on port 5433 via `docker-compose.yml`). Add happy + rejection-path tests for new features; cross-tenant fuzz tests for new zone-scoped queries. Remove throwaway scripts.
- Prefer simple modular code; read files fully before editing; plain language comments; fenced code blocks with language tags.

## Plan mode
When asked to plan, write to `tasks/TASK_NAME.md`: MVP-focused steps, reasoning, task list, open questions. Wait for approval. Append progress notes after each task.
