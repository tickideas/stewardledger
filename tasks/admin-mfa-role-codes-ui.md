# Phase 9 §5 (follow-up) — platform-admin UI for `zones.mfa_required_role_codes`

PR 2 of the TOTP MFA series shipped per-zone MFA enforcement via
the new `zones.mfa_required_role_codes text[]` column, but the
column can only be edited via SQL today (ROADMAP.md §9 notes the
`UPDATE zones SET mfa_required_role_codes = '{zone_owner,
zone_finance_admin}' WHERE slug = '<slug>'` recipe). This task
ships the missing CRUD surface on the platform-admin zone-detail
page so a `super_admin` (or, where applicable, `support_admin`)
can flip enforcement per zone without raw DB access.

This is the **smallest remaining piece of Phase 9 §5**. Once it
lands, the roadmap deliverable *"TOTP MFA (mandatory for
zone_owner and zone_finance_admin roles by default;
configurable)"* and its exit checkbox *"MFA can be enforced at
the role level"* are completely closed — no SQL footnote.

## MVP scope

One new endpoint, one new UI block on the existing zone-detail
page.

### Endpoint

`PATCH /api/admin/zones/:slug/mfa-required-role-codes`

- **Auth**: `super_admin` only. `support_admin` is **read-only**
  across the rest of `/api/admin/zones` and shouldn't be able to
  flip a security control; this gate matches that posture.
- **Body**: `{ codes: string[] }` validated by a new Zod schema
  `zoneMfaRequiredRoleCodesSchema` in `packages/shared`. Each
  entry must be a member of `ZONE_ROLES` or `CHAPTER_ROLES` or
  `GROUP_ROLES` (the role taxonomy already exports both arrays).
  Duplicates are deduped server-side; empty array is allowed
  (turns enforcement off).
- **Response**: `{ codes: string[] }` — the post-write canonical
  list, sorted alphabetically for stable rendering.
- **Audit**: writes a single `platform.zone.mfa_required_role_codes.update`
  event with `{ before: { codes: prev }, after: { codes: next } }`
  and `entityType: 'zone'`, `entityId: zone.id`, `zoneId: null`
  (platform-scope per the `audit_events_zone_scope_check`
  constraint). The audit fan-out lets the per-zone audit-log
  report still pick up the change via a follow-up enrichment if
  we ever want it — for now, the `/admin/audit` surface is the
  read path.
- **Idempotency**: writing the same list a second time is a
  no-op (`prev === next` short-circuit) and **does not** emit
  an audit event. Keeps the audit log readable for actual
  changes.

### UI

New section on `packages/web/src/routes/admin/zones/[slug]/+page.svelte`
below the existing zone-detail cards, titled "Two-factor
enforcement":

- Subtitle: "Users holding any of these roles in this zone must
  enrol in TOTP before they can use the application."
- A checkbox list of every code in
  `ZONE_ROLES ∪ GROUP_ROLES ∪ CHAPTER_ROLES`, grouped by scope
  with the existing zone / group / chapter section headers. Each
  checkbox label uses the human-readable role title from the
  existing role taxonomy (`roleLabel(code)` helper — extract one
  if it doesn't exist yet at `packages/web/src/lib/roles.ts`).
- A "Save" button that's disabled when the checkbox state
  matches the server snapshot (dirty-tracking via a derived
  `$state` rune).
- After a successful save, the page reloads its `ZoneDetail`
  so the new list is canonical. Optimistic UI is not worth the
  complexity for what is a once-per-zone setting.
- Below the form, a small read-only "Currently enrolled in this
  zone" indicator showing `enrolledUserCount / totalUsersWithRequiredRole`,
  read from a new server-side derive in the existing
  `GET /api/admin/zones/:slug` payload. Helps the operator see
  the "blast radius" before flipping a role on. (See
  `/packages/api/src/services/admin/zones.ts` for where the
  detail payload is assembled.)

### Schema additions

No new tables. The `mfa_required_role_codes` column already
exists; this task only adds the route + UI + payload enrichment.

## Files

New:

- `packages/api/src/services/admin/zone-mfa.ts` — service-layer
  helper exporting `updateMfaRequiredRoleCodes({db, zoneId,
  actorUserId, codes}) → string[]` and
  `mfaEnforcementSummary({db, zoneId}) → { enrolled, required }`.
- `packages/api/src/services/admin/zone-mfa.test.ts` — vitest
  unit + integration:
  1. Happy path: valid codes update column + emit audit.
  2. No-op update: same codes → 0 audit rows written.
  3. Invalid code rejected with `invalid_role`.
  4. `enrolled / required` counter ties to a seeded fixture
     (2 users with `zone_owner`, 1 enrolled in MFA → `1 / 2`).
  5. Idempotent across whitespace / case (we normalise both).
- `packages/shared/src/schemas/zones.ts` — add
  `zoneMfaRequiredRoleCodesSchema = z.object({ codes:
  z.array(z.string()).max(64) })`. The per-entry membership
  check happens in the service layer (it knows the taxonomy).

Modified:

- `packages/api/src/routes/admin.ts` — wire the new
  PATCH route, gated by the existing `superAdminGate(c)` helper.
- `packages/api/src/services/admin/zones.ts` (if it exists, else
  the inline assembly in `admin.ts`) — add `enrolledUserCount`
  + `requiredRoleUserCount` + `mfaRequiredRoleCodes` to the
  `GET /api/admin/zones/:slug` payload. The first two are
  resolved by joining `user_role_bindings` × `user` on
  `mfaRequiredRoleCodes && role_code` (Postgres `&&` array
  overlap) and counting `user.two_factor_enabled`.
- `packages/web/src/routes/admin/zones/[slug]/+page.svelte` —
  render the new section + form + counter.
- `packages/web/src/lib/roles.ts` (new or modified) —
  `roleLabel(code)` helper. The same labels appear on
  `/zone/administrators` and `/admin/administrators` already;
  extract them here if they're currently inlined.
- `docs/ROADMAP.md` — drop the SQL-only caveat from Phase 9 §5;
  add a one-line note that the platform-admin UI shipped.
- `docs/PRD.md` §11 — flip the "MFA mandatory vs default-on for
  Premium" open question to a decision once the user signs off
  on default rollout (recommend: default-off, opt-in per zone).

## Tests

API:

- `routes/admin.test.ts` — three new cases:
  1. `super_admin` PATCH with valid codes returns 200 +
     normalised list.
  2. `support_admin` PATCH returns 403.
  3. `super_admin` PATCH with an unknown role code returns 422
     with `error.code === 'invalid_role'`.

Web:

- A `+page.svelte` smoke test isn't worth the Playwright setup
  for this surface; the service-level tests already cover the
  behaviour. The UI change is reviewed manually + via
  `pnpm check` (Svelte type-check).

## Non-goals (deferred)

- A platform-wide default policy (today's per-zone column is
  flexible enough; a global default can be a column on a future
  `platform_settings` row).
- Forcing immediate re-enrolment for users who had MFA enabled
  but the zone owner just removed it from the required list
  (no-op — the user keeps MFA; removing the role from the list
  only means *new* users with that role aren't forced).
- A "force-disable MFA for user X" admin action (recovery is the
  existing `make-super-admin` + DB surgery path).
- Bulk-apply across all zones (operator runs the same UI N
  times; if we ever support a zone template, this column can be
  part of it).

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A `super_admin` can flip
  `mfa_required_role_codes` on any zone from
  `/admin/zones/[slug]` without raw SQL.
- A `support_admin` who lands on the page sees the same surface
  read-only (the existing role-aware read gate already drives
  this).
- The audit log on `/admin/audit` shows a
  `platform.zone.mfa_required_role_codes.update` row per
  meaningful change (no rows for no-op writes).
- ROADMAP Phase 9 §5 reads as fully closed with no SQL
  footnote.
