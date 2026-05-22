---
applyTo: "packages/api/**/*.ts"
---

# Copilot review instructions — API (Hono + Drizzle)

Scope: `packages/api/src/**`. Read alongside `.github/copilot-instructions.md` and `AGENTS.md`.

## Non-negotiables

### 1. Tenant isolation
- Every tenant-scoped handler must run under `tenantMiddleware → requireSession → requireTenantAuth` (see `src/middleware/tenant.ts`, `src/middleware/auth.ts`). Flag any route in `routes/tenant-*.ts` that does not.
- Resolve the zone from `c.get("tenant")`, never from a request body, query param, path param, or cookie. A client-supplied `zoneId` / `zoneSlug` in a handler is a red flag — quote the line.
- Every Drizzle `select` / `update` / `delete` against a domain table must include `eq(table.zoneId, tenant.zoneId)` in its `where`. No exceptions for "internal" calls.
- For chapter-scoped resources, also enforce `requireChapterScope` (or equivalent membership check). Pastor/treasurer/bookkeeper roles must be checked via `hasAnyRole` against the shared `ZONE_ROLES` / `CHAPTER_ROLES` constants — not string literals.
- Cross-tenant work belongs in `routes/admin.ts` (super-admin only). Flag if super-admin gating is missing.

### 2. Validation
- Request body / query / params must go through `zValidator("json" | "query" | "param", schema)` using a Zod schema from `@stewardledger/shared`. Inline `z.object({...})` inside a route is acceptable only for one-off internal endpoints — call it out when it should live in `shared/`.
- Never `as` cast a request payload to a domain type. Parse, don't assert.
- Coerce / validate currency codes, money strings, and date strings via the shared schemas — do not write ad-hoc regexes.

### 3. Money
- Money values are `numeric(19,4)` strings + a `currency_code`. Use `decimal.js` (re-exported from `@stewardledger/shared`) for all arithmetic. Native `+ - * /` on money strings or numbers is a bug.
- A reversal contribution's `abs(amount)` must equal the original's; `currency_code` must match. Flag any code path that can produce a mismatched reversal.
- Never `SUM` across rows with different `currency_code` values. Group by currency.

### 4. Posted-record immutability
- Posted contributions are immutable. `UPDATE contributions` is only acceptable for setting `void_reason` / `voided_at` on a draft, or via the audit triggers. Corrections go through `reversal_of_contribution_id`.
- Flag any direct mutation of a row whose `status = 'posted'`, and any code path that would let a draft be posted without an associated `period` lock check.

### 5. Errors & responses
- Errors must use the `{ error: { code, message, details? } }` envelope (see existing routes for shape). Status codes: `400` validation, `401` no session, `403` authz fail (`forbidden(c, …)` helper), `404` tenant / resource missing, `409` conflict, `422` business-rule reject.
- Never return raw `err.message` from a Postgres / Drizzle error to the client. Map `23505` (unique violation) → `409`, FK violations → `409` or `422`, anything else → generic `500` with a logged correlation id.
- Do not leak `zoneId`s, member PII, full giving amounts, or auth tokens in error bodies or `log.info`. Use `log.debug` (or omit) for PII; `log.warn` / `log.error` for failures with correlation context only.

### 6. Transactions & idempotency
- Multi-step writes that touch >1 table (contributions + audit, members + addresses + audit, import commit → contributions + period close, etc.) must be wrapped in `db.transaction(async (tx) => …)`. Inside the transaction use `tx`, not the outer `db`.
- Import / commit / rollback / period-close endpoints must be idempotent or guarded by a unique constraint + 409. Flag if a retry could double-write.
- `writeAudit` (or the equivalent service) must be called inside the same transaction as the change it describes.

### 7. Tests
- Every new route needs at least one happy-path and one rejection-path test in the sibling `*.test.ts`. Reject paths: no session, wrong role, wrong tenant, invalid payload.
- New zone-scoped queries need a cross-tenant leak test (seed two zones, assert tenant A cannot see tenant B's rows).
- Tests run against the test DB on port 5433 (`docker compose up -d --wait test-db`, then `pnpm test`). Do not introduce test setup that requires the dev DB.

## What NOT to flag
- Use of `any`, `console`, `!` non-null assertions — Biome config disables these rules.
- File length under ~400 lines.
- Style of error helpers (`forbidden(c, msg)` pattern) — match existing routes.

## When suggesting changes
- Quote the file/line and the offending snippet.
- Propose the concrete Drizzle / Hono diff, not "consider adding validation". Example: `add zValidator("json", memberCreateSchema) above the handler, and replace c.req.json() with c.req.valid("json")`.
- Cross-reference `docs/DOMAIN-MODEL.md` and `docs/REPORTS.md` when commenting on financial logic.
