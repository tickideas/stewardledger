# Platform admin management (`/admin/administrators`)

Today every super-admin–sensitive route in
`packages/api/src/routes/admin.ts` hard-codes `superAdminGate(c)`
and the `platform_role_bindings` table (`packages/db/src/schema/roles.ts:73`)
exists but is unused — there is no API or UI to grant
`support_admin`, `billing_admin`, or `region_curator` to anyone,
and there is no way to add a second `super_admin` short of
running `pnpm create-admin` against the box.

This task adds the missing surface: an `/admin/administrators`
page (super-admin-only) plus the API to back it, and opens up
the read-only endpoints to `support_admin` per `docs/PRD.md §6.1`.

## MVP scope

User confirmed (planning conversation, 2026-05-22):

1. **Both invite-new and add-existing** flows for granting a
   platform role.
2. **`support_admin` may read tenant zone detail + region inbox**,
   but never mutate. Matches PRD §6.1 ("read-only across tenants").
3. **`billing_admin` is defined and assignable now**, even though
   the subscriptions UI it gates does not exist yet — so the
   identity is in place by the time Stripe lands in Phase 10.
4. **Plan first**, code after approval (this file).

### Roles after this PR

| Role | Grants | Granted via |
|---|---|---|
| `super_admin` | Full platform; can grant/revoke any platform role; bit on `user.is_super_admin` | Promote/demote action on `/admin/administrators` |
| `support_admin` | Read-only across tenants (`GET /admin/zones`, `GET /admin/zones/:slug`, `GET /admin/regions*`). Cannot invite/edit zones, cannot grant roles. | `platform_role_bindings` row, granted by a super-admin |
| `billing_admin` | Wired but unused this PR — endpoint gate added so Phase 10 can flip a single switch. Cannot read tenant detail. | same as above |
| `region_curator` | Existing behaviour: see `/admin/regions[/inbox]`, write regions reference list. No change. | same as above |

Last-super-admin protection: the system always keeps at least
one un-revoked `super_admin`. Revoking the last one fails 409.

## Files

New:
- `packages/db/drizzle/0013_*.sql` — no schema change expected
  (the table already exists); included only if Drizzle's
  generate produces a diff (e.g. a new index — see below).
- `packages/api/src/services/admin/administrators.ts`
  — service layer: list/grant/revoke/promote/demote + invite,
  with the "last super-admin" guard and audit writes.
- `packages/api/src/services/admin/administrators.test.ts`
  — happy path + every refusal case + cross-role fuzz.
- `packages/api/src/routes/admin-administrators.ts`
  — `GET /administrators`, `POST /administrators/invite`,
  `POST /administrators/:userId/roles`,
  `DELETE /administrators/:userId/roles/:roleCode`,
  `POST /administrators/:userId/super-admin`,
  `DELETE /administrators/:userId/super-admin`.
- `packages/api/src/routes/admin-administrators.test.ts`
  — route-level integration tests (auth, 403, audit shape,
  cross-tenant fuzz where applicable).
- `packages/api/src/services/platform-invitations.ts` (or fold
  into administrators.ts if it stays < ~200 lines).
- `packages/web/src/routes/admin/administrators/+page.svelte`
  — list + invite modal + per-row role chips.
- `packages/web/src/routes/admin/administrators/+page.server.ts`
  — gate: super-admin only, redirect others via
  `authenticatedLandingPath`.
- `packages/web/src/routes/admin/administrators/invite-admin-modal.svelte`.

Modified:
- `packages/api/src/routes/admin.ts` — replace
  `superAdminGate(c)` with `requirePlatformRole(SUPER_ADMIN)` on
  routes that should stay super-admin-only, and add explicit
  `requirePlatformRole(SUPER_ADMIN, SUPPORT_ADMIN)` on the two
  read endpoints opened up to support. Mount the new
  administrators router.
- `packages/api/src/app.ts` — wire the new router.
- `packages/web/src/lib/nav.ts` — add a new `Access` group with
  one item, `/admin/administrators`. Order it last in
  `PLATFORM_NAV` so the existing Tenants group stays the
  landing target.
- `packages/web/src/lib/session-paths.ts` — extend
  `isSuperAdminOnlyPath` to include `/admin/administrators`.
- `packages/web/src/lib/session-paths.test.ts` — add the case.
- `packages/web/src/routes/admin/+layout.svelte` — hide the new
  nav item from non-super-admins (same pattern used for
  `/admin/zones`).
- `docs/PRD.md §6.1` — note delegation lives in
  `/admin/administrators`.
- `docs/ROADMAP.md` — tick the "platform-admin UI" follow-up
  noted under TOTP MFA (line 317) since this PR delivers the
  shared shell that the per-zone MFA policy UI can plug into
  later, and add a stub entry for this PR.

Removed: nothing.

## API contract

All endpoints under `/api/admin/administrators`. Same
`requireSession + requirePlatformRole(SUPER_ADMIN)` chain as
`/api/admin/zones/invite`. Every mutation writes an audit row
with `action ∈ {platform.admin.invite, .grant, .revoke,
.elevate, .demote}`, `actor_user_id` = the calling super-admin,
and `entity_id` = the target user id.

### `GET /administrators`

Returns every user who is either super-admin or holds at least
one non-revoked platform-role binding.

```jsonc
{
  "items": [
    {
      "userId": "1xu...",
      "email": "super@stewardledger.local",
      "name": "Super Admin",
      "isSuperAdmin": true,
      "platformRoles": [],          // explicit bindings on top of the bit
      "createdAt": "...",
      "lastSignInAt": null           // null until we wire it; cheap if Better Auth tracks it
    }
  ]
}
```

### `POST /administrators/invite`

```jsonc
{
  "name": "Pat Treasurer",
  "email": "pat@example.org",
  "roleCode": "support_admin",   // any non-super_admin platform role
  "superAdmin": false              // explicit; super_admin only via dedicated endpoint
}
```

- 409 `email_already_user` if the email is already a registered user
  (operator should use *add-existing* instead — the page surfaces this).
- 201 with `{ "invitationId": "..." }` on success.
- Creates a platform-scoped invitation row (see "Invitations" below).

### `POST /administrators/:userId/roles`

Add `roleCode` to an *existing* user. `roleCode` must be one of
`{support_admin, billing_admin, region_curator}` — `super_admin`
is handled by the dedicated endpoint so the audit action is
unambiguous.

- 409 `already_granted` if a non-revoked binding exists.
- 201 with the binding id.

### `DELETE /administrators/:userId/roles/:roleCode`

Soft-revoke (`revoked_at = now()`). 404 if there is no active
binding.

### `POST /administrators/:userId/super-admin`
### `DELETE /administrators/:userId/super-admin`

Set / clear `user.is_super_admin`. DELETE refuses with 409
`last_super_admin` if the target is the only un-revoked super-admin.

## Invitations

Two paths to a working admin account:

**(A) Existing user, grant role.**
No invitation; just write to `platform_role_bindings`. The user
gets the role at their next session refresh (sessions live for
~7 days; we surface a banner on `/admin/administrators` saying
"User will see admin nav after they sign in again" — same UX
constraint as today's zone-role grants).

**(B) New user, invite.**
Today, `invitations` is zone-scoped (`zone_id NOT NULL`).
Rather than relax that column, this PR adds a small sibling
table `platform_invitations`:

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid default |
| `email` | text NOT NULL | citext-style; lower-cased before insert |
| `token` | text NOT NULL UNIQUE | same shape as today's invitation tokens |
| `name` | text NOT NULL | display name set by inviter |
| `role_code` | text NOT NULL | platform role code, CHECK in (`support_admin`,`billing_admin`,`region_curator`) — see CHECK below |
| `super_admin` | boolean NOT NULL default false | request promote-on-accept |
| `created_by_user_id` | text NOT NULL FK -> user.id |
| `created_at` | timestamptz NOT NULL default now() |
| `expires_at` | timestamptz NOT NULL | created_at + 7 days |
| `revoked_at` | timestamptz |
| `accepted_at` | timestamptz |

Indexes:
- `unique (lower(email), role_code) where revoked_at is null and accepted_at is null`
  — one open invitation per (email, role) at a time.
- `index (token)` via the unique constraint above.

CHECK: `role_code in ('support_admin', 'billing_admin', 'region_curator')`.
`super_admin = true` may co-exist with any of these — the role
code is what they're being invited *as* on day one, and the
boolean is an extra promote-on-accept toggle for cases where
the operator wants both.

The accept flow lives at `POST /api/public/platform-invitations/accept`
(mirrors `POST /api/public/invitations/accept` shape exactly) and:
1. Creates the Better Auth user with the supplied password.
2. Inserts the `platform_role_bindings` row.
3. If `super_admin`, sets `user.is_super_admin = true`.
4. Writes a `platform.admin.accept` audit row.
5. Stamps `accepted_at`.

UI lives at `/invite/platform/[token]/+page.svelte`, distinct
from `/invite/[token]` so the page can render "you're being
added as a platform admin", not "you're being added to a zone".

### Audit shape

`audit_events.zone_id` is currently `NOT NULL`. Two options:

- **Option 1 (preferred)** — relax to `NULL` for platform-scope
  events. Migration `0013_audit_events_platform_scope.sql`
  drops the NOT NULL on `audit_events.zone_id` and adds a
  partial CHECK that platform-action rows have `zone_id IS NULL`
  while every other action keeps `zone_id IS NOT NULL`.
- **Option 2** — separate `platform_audit_events` table.

Option 1 keeps audit search uniform; the audit search UI shipped
in Phase 9 §1 can grow a "platform" filter trivially. Going
with option 1 unless review says otherwise.

## Web

`/admin/administrators` page — single Svelte route, no nested
layouts. Layout:

```
┌ Administrators ────────────────────────────────────────────┐
│ [ + Invite admin ]   [ + Grant role to existing user ]      │
│                                                              │
│ Email                  Name           Roles                  │
│ super@…                Super Admin    super_admin            │
│ pat@…                  Pat T.         support_admin   [×]    │
│ jamie@…                Jamie B.       billing_admin   [×]    │
│                                       [+ Add role ▾]         │
│                                                              │
│ Pending invitations                                          │
│ rob@example.org        support_admin    Sent 2 hours ago   [Resend] [Revoke] │
└─────────────────────────────────────────────────────────────┘
```

States:
- *Invite admin* modal: name + email + role select + super-admin toggle.
- *Grant role to existing user*: email lookup (server-side, by exact match) → if found, dropdown of roles, confirm.
- Row's `[+ Add role ▾]` adds another binding to an existing admin.
- `[×]` next to a role revokes it (confirm dialog).
- *Promote to super-admin* / *Demote from super-admin* action on the row's overflow menu, with a confirm that surfaces the "last super-admin" check.

The page uses the existing `$lib/api.ts` client; no new client
plumbing required.

## Tests

API-side, all in `packages/api/src/`:
- `services/admin/administrators.test.ts` — happy path for
  `listAdministrators`, `grantRole`, `revokeRole`, `elevate`,
  `demote`, `invite`; each refusal case; last-super-admin guard
  fires; cross-role fuzz (a `support_admin` calling the service
  layer directly cannot mutate — the service rejects without
  relying on the route layer).
- `routes/admin-administrators.test.ts` — 401 with no session,
  403 with a non-super-admin session, 200 with super-admin,
  audit row written, invitation token usable end-to-end.
- `routes/admin.test.ts` — extend existing tests so that a
  `support_admin` *can* `GET /admin/zones` + `GET /admin/zones/:slug`,
  and *cannot* invite, delete, or resend.

Web-side:
- `packages/web/src/lib/session-paths.test.ts` — adds
  `/admin/administrators` to `isSuperAdminOnlyPath`.

## Acceptance

- [ ] Super-admin lands on `/admin/administrators` from the nav
      and sees a list with at least themselves.
- [ ] Super-admin can invite a new admin by email; they get a
      magic link in the dev log; clicking it opens an accept
      page where they set a password; on accept they can sign in
      and reach `/admin`.
- [ ] Super-admin can add a `support_admin` role to an existing
      zone-owner without granting them super-admin powers; that
      user can then `GET /admin/zones` and `GET /admin/zones/:slug`
      but is 403'd on every mutation.
- [ ] Super-admin can revoke any role; the affected user loses
      access by their next session refresh.
- [ ] Attempting to demote the only remaining super-admin
      returns 409 `last_super_admin`.
- [ ] Every grant / revoke / invite / accept / elevate / demote
      writes an audit row visible in `/zone/audit` (after the
      platform-scope filter follow-up) and via SQL today.
- [ ] `pnpm lint`, `pnpm check`, `pnpm test` all green.

## Open questions during build

- Should the *invite-existing-user* flow auto-send a notification
  email to the user being granted a role? Leaning **yes** —
  treating it as a silent grant is a security antipattern. Will
  add an opt-out checkbox in the modal but default to send.
- The audit search UI today is zone-scoped; do we ship a tiny
  follow-up to add a "platform" mode, or call that out as a
  follow-on task? **Decision: follow-on.** Don't bloat this PR.

## Out of scope / follow-ups

- Subscriptions UI itself (Phase 10).
- Per-zone MFA policy admin UI — still deferred; this PR
  delivers the shell it can plug into later.
- Audit-search "platform" filter — follow-on task.
- Last-sign-in surfacing on the admin list (Better Auth may not
  track it for free; if it costs a separate query per row,
  defer).

## Progress notes

(Append after each task while building.)

---

### 2026-05-22 (build session)

- Schema landed (`0013_platform_admin_management.sql`): adds
  `platform_invitations`, relaxes `audit_events.zone_id` to nullable
  with a CHECK pinning `platform.*` actions to NULL and every other
  action to non-NULL.
- `services/audit.ts`: `AuditWrite.zoneId` now `string | null` to
  carry platform-scope events.
- Service layer: `services/admin/administrators.ts` (list / grant /
  revoke / elevate / demote, last-super-admin guard, audit writes)
  and `services/admin/platform-invitations.ts` (create / list /
  revoke / lookup / accept).
- Routes: `routes/admin-administrators.ts` mounted at
  `/api/admin/administrators` (super-admin only); routes/public.ts
  gains `/platform-invitations/:token` + `/platform-invitations/accept`.
- Gating: `requirePlatformRole(SUPER, REGION_CURATOR, SUPPORT)` on
  the `/api/admin` router; per-route `platformRoleGate(SUPPORT_ADMIN)`
  on `GET /zones` and `GET /zones/:slug`; `platformRoleGate(REGION_CURATOR)`
  on the three region mutations so SUPPORT_ADMIN cannot write.
- Mounting decision: `adminAdministratorsRouter` sits at
  `/api/admin/administrators` (not `/api/admin`) so its
  `requirePlatformRole(SUPER_ADMIN)` middleware does not over-gate
  the rest of `/api/admin/*`.
- Web: `/admin/administrators` page with invite + grant-existing
  modals; new `/invite/platform/[token]` accept page;
  `isSuperAdminOnlyPath` extended; PLATFORM_NAV gained an Access
  group.
- Docs: PRD §6.1 gained a delegation paragraph; ROADMAP Phase 9
  gained a Platform-admin management entry.
- Tests: 30 new (`admin/administrators` 10, `admin/platform-invitations`
  9, `routes/admin-administrators` 11, plus 4 in
  `routes/admin.test.ts` for support_admin gating). Total API
  passes at 479/479 serialized; web 108/108; shared 10/10.
- Decisions resolved during build:
  - Send an "you've been granted X" notification email on existing-user
    grants — **deferred to follow-on**. The plan suggested defaulting
    to send; I scoped this PR to invitation flows + raw grants only so
    the email side stays simple. The helper `sendPlatformAdminGrantNoticeEmail`
    is exported but not yet called by any route — wiring it up + adding
    a checkbox in the UI is the smallest follow-on.
  - Audit-search "platform" filter — deferred to a follow-on task. The
    audit_events CHECK is in place, so the filter is purely UI work.
