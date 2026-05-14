# Phase 9 §5 (PR 2) — Close MFA bypasses + per-role enforcement

PR 1 shipped opt-in TOTP enrollment gated to super-admins. PR 2:

1. Plugs the OTP / magic-link bypass so an MFA-enrolled user
   cannot sign in via a path that doesn't challenge for the
   second factor.
2. Adds per-zone enforcement: each zone can mark a set of role
   codes that *must* have MFA active. Users holding such a role
   are forced to enrol before they can use the application.
3. Lifts the super-admin gate on `/account/security` and the
   sidebar link.

The roadmap exit-criterion *"MFA can be enforced at the role
level"* flips to done on merge.

## Threat model recap

Today (PR 1) an MFA-enrolled user has these usable sign-in
paths against the API:

| Path | Plugin | Challenges TOTP? | Fix |
|---|---|---|---|
| `/sign-in/email` | password | ✓ already does | — |
| `/sign-in/email-otp` | email-otp | ✗ | Refuse for MFA users |
| `/email-otp/send-verification-otp` (sign-in type) | email-otp | ✗ (issues the code) | Refuse for MFA users |
| `/sign-in/magic-link` | magic-link | ✗ (issues the link) | Refuse for MFA users |
| `/magic-link/verify` | magic-link | ✗ (consumes the link) | Implicitly covered: we never issue a link for an MFA user, so there's nothing to verify. A leaked link issued *before* enrolment expires in 5 min; acceptable. |

We don't *use* email-otp / magic-link sign-in from the web UI
(only `/sign-in/email` is wired), but the endpoints are public
and an attacker / admin tool can hit them directly. The fix has
to be in the API.

## Design

### Bypass closure (one `hooks.before` interceptor)

A single global `before` hook matches the three issuance / sign-in
paths above, parses the body to extract the email, looks up the
user, and if `twoFactorEnabled === true` returns
`{ error: { code: 'mfa_required', message: '…' } }` with status
`409`. We pick 409 over 401 because the credentials are not the
problem — the user is asking for a path their MFA posture forbids.

The hook lives in a new module `services/mfa-policy.ts` so it
stays unit-testable in isolation. It re-reads `user` from the DB
(not the Better Auth session, which doesn't exist yet at sign-in
time) to avoid trusting any client-supplied flag.

**Why a hook, not `disabledPaths`:** disabling the paths globally
would also break sign-in for non-MFA users, who may legitimately
prefer magic-link / OTP. The hook only rejects when MFA is on.

### Per-zone enforcement policy

New column `zones.mfa_required_role_codes text[]` (default `'{}'`).
A zone owner enumerates role codes — e.g. `{ zone_owner,
zone_finance_admin }` — and any user holding one of those roles
within the zone is forced to enrol.

Enforcement happens **on the post-sign-in landing path**, not at
sign-in time. Two reasons:
- A user without MFA who just signed in still has a session; we
  redirect to `/account/security` and let them enrol there.
  Blocking the sign-in itself would lock them out with no
  recovery path.
- Sign-in time has no zone context — the user might administer
  multiple zones, only one of which enforces.

Concretely:
- `/api/public/session-zones` returns a new `mfaRequired: boolean`
  flag per zone, computed from
  `(zone.mfa_required_role_codes ∩ user's roles in zone) !== ∅`.
- The root layout's effect, after hydrating the session, redirects
  to `/account/security?required=1` if **any** active zone reports
  `mfaRequired && !user.twoFactorEnabled`. The query param drives
  a banner on the security page explaining why they're there.

Roadmap default: PR 2 does NOT auto-seed `mfa_required_role_codes`
for existing zones. We ship the *mechanism*; rollout is per-zone.
A platform admin UI for editing the list is **not** in scope here
— it ships as a CRUD on `/admin/zones/[slug]` in a follow-up. For
PR 2, the column can only be edited via SQL / a script.

### Lift the super-admin gate

- Remove the `isSuperAdmin` check in `/account/security`.
- The `/account` link is shown to every authenticated user.
- The "limited preview" copy is replaced with the real enrolment
  prompt; the page renders for everyone.
- Add a banner when `?required=1`: "Your zone requires two-factor
  authentication. Enrol now to continue."

## Files

New:
- `packages/api/src/services/mfa-policy.ts` — body-extraction +
  `isMfaRequired(email)` helper + the `hooks.before` middleware.
- `packages/api/src/services/mfa-policy.test.ts` — unit tests for
  each interception path and the negative cases (user not found,
  no MFA, missing body field).
- `packages/db/drizzle/0007_*.sql` — add
  `zones.mfa_required_role_codes`.

Modified:
- `packages/db/src/schema/zones.ts` — column.
- `packages/api/src/auth.ts` — wire `hooks.before`.
- `packages/api/src/routes/public.ts` —
  `/session-zones` returns per-zone `mfaRequired`.
- `packages/web/src/lib/session.svelte.ts`,
  `packages/web/src/lib/session-paths.ts`,
  `packages/web/src/hooks.server.ts` — surface `mfaRequired` on
  each zone in the session shape.
- `packages/web/src/routes/+layout.svelte` — post-hydrate redirect
  to `/account/security?required=1`.
- `packages/web/src/routes/account/security/+page.svelte` — lift
  the super-admin gate; render an `?required=1` banner.
- `packages/web/src/routes/account/+page.svelte` — show the
  Security link unconditionally.
- `packages/api/src/auth-twofactor.test.ts`, new MFA-policy tests,
  reports.test.ts (if it leans on the zones shape).
- `docs/ROADMAP.md` — Phase 9 §5 done; exit criterion ticked.

## Tests

- **OTP issuance refused for MFA user** — POST
  `/email-otp/send-verification-otp { email, type: "sign-in" }`
  for an enrolled user returns 409, no email sent.
- **OTP sign-in refused for MFA user** — POST `/sign-in/email-otp`
  with a valid recently-issued code (predates enrolment) for a
  now-enrolled user returns 409. Models the "leaked code"
  scenario.
- **Magic-link issuance refused for MFA user** — POST
  `/sign-in/magic-link { email }` for an enrolled user returns
  409, no link sent.
- **Non-MFA user is unaffected** — same three POSTs succeed for
  a user without MFA (no change to the existing happy path).
- **Per-zone enforcement** — a user with `chapter_treasurer` in a
  zone whose `mfa_required_role_codes` contains `chapter_treasurer`
  gets `mfaRequired: true` on that zone in `/session-zones`. A
  user with no MFA in a zone whose set is empty gets
  `mfaRequired: false`.
- **Web redirect** — covered by `landingInputFromServerSession`
  via a thin pure-function test; integration coverage is on the
  user's first sign-in after merge.

## Non-goals (deferred)

- Platform-admin UI to edit `mfa_required_role_codes` (raw SQL /
  script in PR 2; UI in a follow-up).
- Trusted-device cookies / "remember this browser for 30 days".
- Force-disable MFA from the platform admin surface (recovery via
  the existing `make-super-admin` script + DB surgery).
- DB trigger for MFA audit (the `databaseHooks` wiring from PR 1
  is sufficient).

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- Enabling MFA blocks `/sign-in/email-otp` and `/sign-in/magic-link`
  for that account.
- Setting `zones.mfa_required_role_codes = '{zone_owner}'` and
  signing in as a zone-owner without MFA redirects to
  `/account/security?required=1`; enrolment clears the redirect.
- `/account/security` is reachable for every authenticated user.
- Roadmap Phase 9 §5 exit-criterion `[x]`.
