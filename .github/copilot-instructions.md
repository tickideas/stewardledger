# Copilot Custom Instructions — StewardLedger

> Multi-tenant SaaS for church finance & stewardship.
> Read `AGENTS.md` and `docs/` (PRD, ARCHITECTURE, DOMAIN-MODEL, REPORTS, ROADMAP, BRAND) for full context. These instructions are a review-time summary, not a replacement.

## Project context
- **Monorepo**: pnpm workspaces + Turborepo. Packages: `shared` (Zod schemas, types, money utils, role taxonomy), `db` (Drizzle schema + migrations), `api` (Hono on Node 22 LTS, port 3000), `web` (SvelteKit 2 / Svelte 5 + Tailwind 4, port 5173).
- **Stack**: TypeScript strict, PostgreSQL 17, Drizzle ORM, Better Auth (email OTP / magic link / password), pg-boss (Phase 6+), useSend, S3-compatible storage, Docker + Dokploy.
- **Package manager**: pnpm 9. Node 20–24 (CI = Node 22 LTS).
- **Linter/formatter**: Biome 2 (`pnpm lint`, `pnpm check`, `pnpm test`).

## Review priorities (in order)
1. **Tenant isolation** — every domain table and query must be scoped by `zone_id`. Flag any tenant-code query that does not include a `zone_id` predicate, any cross-tenant join, or any API handler that trusts a client-supplied `zoneId` without auth/membership check.
2. **Money correctness** — amounts must be `numeric(19,4)` + `currency_code`, manipulated via `decimal.js` from `@stewardledger/shared`. No native `number` arithmetic on money. Positive = inflow, negative = reversal. A reversal's `abs(amount)` must equal the original. Never mix currencies in a single sum.
3. **Posted-record immutability** — posted contributions cannot be mutated; corrections must go through `reversal_of_contribution_id`. Flag any `UPDATE` against posted rows outside the audit/immutability triggers.
4. **Security** — authz on every Hono route and server load, Zod validation at all API boundaries, no secrets in code or committed env, no SSRF/XSS, no `dangerouslySetInnerHTML` equivalents (`{@html …}` in Svelte) without sanitisation, signed URLs for object storage.
5. **Schema & migration safety** — Drizzle schema changes need a generated migration; destructive migrations (drop column, type change on populated table) need an explicit note. No raw SQL outside audit triggers.
6. **Correctness & data integrity** — multi-step writes wrapped in a transaction, idempotency for import / commit / rollback paths, no N+1 in report queries.
7. **Performance** — avoid loading whole tenants into memory; paginate list endpoints; in Svelte 5 prefer runes and avoid unnecessary `$effect`; keep client bundles lean.
8. **Readability** — small files (<~400 lines), early returns, plain-language comments only where logic is non-obvious.

## Conventions to enforce
- **File header**: every source file starts with 4 comment lines — (1) exact path, (2) what it does, (3) why it exists, (4) `RELEVANT FILES:` listing 2–4 related paths. Never delete these.
- **Naming**: kebab-case filenames, camelCase variables/functions, PascalCase types/components, UPPER_SNAKE env vars.
- **TypeScript**: strict mode. `any` is allowed (Biome config), but prefer `unknown` + narrowing in new code. Avoid non-null assertions without a one-line justification.
- **Validation**: Zod at every API boundary (request body, query, params, response where it crosses a trust boundary). Schemas live in `@stewardledger/shared` when reused.
- **DB**: Drizzle only (no raw SQL except audit triggers). Always include `zone_id` in `where`. Use transactions for any write that touches >1 row across tables.
- **API (Hono)**: typed errors, never echo client IDs back into queries without an auth/membership check, never log PII or full giving amounts at info level.
- **Web (SvelteKit 2 / Svelte 5)**: server components / `+page.server.ts` load by default; only push to client where interactivity is required. Prefer Svelte 5 runes (`$state`, `$derived`, `$effect`) over legacy reactive syntax in new code. Tailwind utility classes; no inline styles except dynamic values.
- **Tests**: co-located `foo.ts` + `foo.test.ts`. New features need at least one happy-path and one rejection-path test. Zone-scoped queries need a cross-tenant fuzz/leak test.
- **Commits / PRs**: Conventional Commits (`type(scope): description`). PR title `[scope] short imperative`. Financial paths require a second reviewer — call this out in the review if missing.

## House style
- Small, focused PRs. Flag diffs > ~400 lines as "consider splitting" unless they are pure migration / generated files.
- Prefer pure functions and early returns over nested conditionals.
- Do not suggest adding comments unless the logic is non-obvious.
- Do not suggest renames for cosmetic preference alone.
- Update the relevant doc in `docs/` in the same PR as any behaviour change; flag if missing.

## What NOT to flag
- Formatting (Biome handles it).
- Stylistic bikeshedding (`const` vs `let`, quote style, optional `useImportType`).
- Missing JSDoc on internal functions.
- Use of `any`, `console`, `!` non-null assertions, `useTemplate`, etc. — explicitly disabled in `biome.json`.
- Anything in `**/.svelte-kit`, `**/dist`, `**/build`, `**/drizzle`, `**/coverage`.

## When uncertain
- Ask a clarifying question instead of guessing intent.
- Cite the file/line and quote the snippet you're concerned about.
- Suggest concrete diffs, not vague advice ("consider improving error handling" → bad; "wrap the `db.transaction` block on line 42 in a try/catch returning `{ ok: false, error }`" → good).
- For financial logic, cross-check against `docs/DOMAIN-MODEL.md` and `docs/REPORTS.md` and cite the section.
