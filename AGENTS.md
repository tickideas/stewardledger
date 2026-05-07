# AGENTS — conventions for humans and agents

> If you are an AI agent, read this file before making changes.
> If you are a human, read this once; the rules are short.

---

## Brand & naming

- The product is **StewardLedger**. Always camel-case, no space, no abbreviation.
- Domain: `stewardledger.church`. Subdomains, repos, npm scopes, social handles are lowercase.
- Full naming/casing rules: [`docs/BRAND.md`](docs/BRAND.md). It is normative.

## Source of truth for design decisions

Every cross-cutting decision lives in `docs/`. If you change behaviour, update the relevant doc in the same PR.

| Decision class | Doc |
|---|---|
| Vision, scope, roles, requirements | `docs/PRD.md` |
| Stack, tenancy, deployment | `docs/ARCHITECTURE.md` |
| Drizzle schema, invariants | `docs/DOMAIN-MODEL.md` |
| Legacy Church Plus reference | `docs/DOMAIN-REFERENCE.md` |
| Report inventory & acceptance | `docs/REPORTS.md` |
| Phased build plan & exit criteria | `docs/ROADMAP.md` |

## Hard rules

1. **Money is always `numeric(19,4)` paired with `currency_code`.** Never `float`, never JS `number` for arithmetic. Use `decimal.js` (already in `@stewardledger/shared`). Sign encodes direction: positive = inflow / gift, negative = reversal. The absolute amount of a reversal line must equal the original line.
2. **Every domain table has `zone_id NOT NULL`.** The zone is the tenant boundary. No exceptions for v1.
3. **Posted contributions are immutable.** Corrections are reversals (`reversal_of_contribution_id`), never silent updates.
4. **No stored-proc business logic.** Triggers exist only for (a) audit capture, (b) posted-record immutability, and (c) cross-row invariants that a CHECK constraint cannot express — currently the contribution↔line currency-cohesion check and the TRUNCATE guards on `contributions` / `contribution_lines`.
5. **No cross-tenant queries from tenant code.** Only the explicit platform-admin context can read across zones, and never silently writes.
6. **No secrets in the repo.** Use env vars; document new ones in `.env.example`.
7. **No data import from the legacy Church Plus.** It is reference only.

## Code conventions

- TypeScript strict mode everywhere.
- Zod schemas at every API boundary.
- Drizzle for all DB access; no raw SQL except in audit triggers and the few performance hot paths reviewed by the team.
- File names are kebab-case (`tenant-resolver.ts`).
- Variables/functions camelCase; types/classes PascalCase; env vars UPPER_SNAKE.
- Tests live next to the code (`foo.ts` + `foo.test.ts`).
- Bias to small files. If a file passes ~400 lines, split it.

## Commit & PR conventions

- One PR per logical change. No bundled PRs.
- Title format: `[scope] short imperative`, e.g. `[db] add member_merge_proposals`.
- Every PR that changes behaviour updates the relevant `docs/`.
- Financial code paths require a second reviewer.

## Testing

- Vitest for unit + integration.
- Drizzle test DB on port 5433 (see `docker-compose.yml`'s `test-db` service).
- Cross-tenant fuzz tests required for any new query against a zone-scoped table.
- Don't add a feature without at least one test on the happy path and one on the rejection path.

## When you're stuck

- Read the corresponding section of `docs/` first.
- If the docs disagree with the code, fix the code or fix the docs — don't leave the conflict.
- Ask the user before making a decision that would change the documented architecture.
