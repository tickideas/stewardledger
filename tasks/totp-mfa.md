# Phase 9 §5 (PR 1) — Opt-in TOTP MFA

Per ROADMAP.md Phase 9 deliverable #5. Better Auth ships the
`two-factor` plugin (TOTP + recovery codes) natively; this PR
turns it on and exposes an account-level enrolment surface.

**Enforcement is deliberately deferred to PR 2.** Enabling TOTP
also enables the login challenge automatically for the
password sign-in path (Better Auth returns a `twoFactorRedirect`
when a user with TOTP signs in via `/sign-in/email`), but no
role-level *mandatory* policy lands here — users opt in.

**Critical scoping decision (super-admin gate):** the plugin's
login-challenge after-hook only matches
`/sign-in/email|username|phone-number`. Email-OTP and
magic-link sign-ins bypass the TOTP challenge entirely, which
means an MFA-enrolled user can still sign in unchallenged via
those paths. That's a half-finished posture we cannot ship to
customers — a user enabling MFA would believe their account
is hardened when it isn't.

PR 1 therefore **gates the enrollment UI behind
`user.is_super_admin`**. Super-admins are platform staff who
understand the limitation and can recover from a lockout via
the `make-super-admin` script. PR 2 lifts the gate, wires the
login-challenge handler in the web app, and — most importantly
— either disables OTP/magic-link sign-in for MFA-enrolled
users or wraps those endpoints with a parallel TOTP challenge.
Until PR 2 lands, *no customer-facing path can enable MFA*.

## MVP scope

1. Drizzle schema additions:
   - `user.two_factor_enabled boolean not null default false`
     (matches the plugin's `twoFactorEnabled` field).
   - New `two_factor` table mirroring the plugin's schema
     (`id`, `user_id`, `secret`, `backup_codes`, `verified`).
   - Migration generated via drizzle-kit.

2. Register `twoFactor()` plugin on the API's Better Auth
   instance. Config: `issuer = "StewardLedger"`, default
   recovery-code count, no `skipVerificationOnEnable` (user
   must verify a TOTP code before MFA actually arms).

3. Audit events: a thin server route at
   `/api/tenant/security/audit-mfa` is NOT added — the plugin
   wraps `enableTwoFactor` / `disableTwoFactor` endpoints and
   we don't get a hook on them. Instead a separate audit
   service helper (`recordMfaEvent`) is exposed and called
   from the web app right after a successful enable / verify
   / disable. Server-side audit on the **enabled flag flip**
   is added by a DB trigger in a follow-up; for PR 1 we
   accept the client-issued audit row and gate it via the
   tenant middleware (the row is scoped to the user's
   currently-resolved zone).

   *(Note: an MFA event is global — a user enables 2FA once,
   not once per zone. We write to the audit log of every
   zone the user belongs to so an auditor of any of those
   zones sees the event. That's the conservative read of
   REPORTS.md §2.13.)*

4. Web UI: a new dedicated page at
   `/account/security/+page.svelte`. The page is reachable
   from `/account` only when the session user is a super-admin
   (link hidden otherwise). The page itself **also** checks
   `isSuperAdmin` server-side via `/api/tenant/me` (or the
   existing session shape — whichever is simpler) and renders
   a 403-shaped explanation otherwise. The link from
   `/account` does not appear at all for non-super-admins so
   no customer-facing surface exposes the half-finished
   feature.

   The Security section drives:
   - Initial state: "Two-factor authentication is off."
     Button "Enable two-factor auth" → password prompt → call
     `POST /api/auth/two-factor/enable` with `{ password }` →
     receive `{ totpURI, backupCodes }` → render QR + the
     recovery codes panel → enter 6-digit code → call
     `POST /api/auth/two-factor/verify-totp` → on success, the
     UI flips to "Two-factor is on."
   - Active state: "Two-factor authentication is on. Recovery
     codes are single-use; regenerate if you've used them all."
     Buttons: *Regenerate recovery codes* (re-enter password),
     *Disable two-factor* (re-enter password).
   - QR code is rendered client-side from the `otpauth://`
     URI. Use a small inline QR generator (the `qrcode` npm
     package is ~6KB compiled).

5. Tests:
   - `packages/api/src/auth.test.ts` (new) — boots the auth
     handler, asserts `/api/auth/two-factor/enable` is
     registered (route shape only — full crypto flow is
     plugin-tested upstream).
   - `packages/db/src/schema/auth.test.ts` (existing or new)
     — migration adds the `two_factor` table + `user
     .two_factor_enabled` column.

## Non-goals (deferred to PR 2)

- **Lift the super-admin gate** on the enrollment page.
- **Plug the OTP / magic-link bypass** — either disable
  those sign-in paths for MFA-enrolled users or wrap each
  with its own challenge.
- Login-flow handler that recognises `twoFactorRedirect` and
  routes to a `/login/two-factor` page.
- Per-zone **enforcement** policy on `zones`
  (e.g. `mfa_required_role_codes text[]`).
- Login-flow integration that *forces* enrolment for users
  holding a required role.
- Trusted-device cookies / "remember this browser for 30 days".
- SMS / hardware-token providers (only TOTP + recovery codes).
- A bespoke per-zone audit row written server-side via a DB
  trigger.

## Files

New:
- `packages/web/src/routes/account/security/+page.svelte` —
  dedicated MFA page (linked from `/account`).
- `packages/web/src/lib/qr.ts` — thin wrapper around the
  `qrcode` package returning a data URL (so the page stays
  testable without rendering a canvas).
- `packages/db/drizzle/0006_*.sql` — generated migration.

Modified:
- `packages/db/src/schema/auth.ts` — add `twoFactorEnabled`
  to `user`, add `twoFactor` table.
- `packages/api/src/auth.ts` — register the plugin.
- `packages/api/package.json` / `packages/web/package.json`
  — add `qrcode` (web).
- `packages/web/src/routes/account/+page.svelte` — add a
  link to the new security page.
- `docs/ROADMAP.md` — note PR 1 progress under Phase 9 §5.

## Tests

- `packages/api/src/auth-twofactor.test.ts` — POSTs to
  `/api/auth/two-factor/enable` with a valid session +
  password; expects 200 and a body with `totpURI`,
  `backupCodes`. Smoke; the plugin's own suite covers the
  cryptographic details.
- (Web tests for QR rendering land alongside the page if
  there's component logic worth covering; QR is otherwise a
  one-liner around the `qrcode` library.)

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A logged-in user can navigate to `/account/security`,
  enable TOTP with their authenticator app, save the
  recovery codes, and on the **next sign-in** Better Auth
  challenges for the 6-digit code.
- Disabling MFA from the same surface removes the challenge.
- The next sign-in flow integration is **deferred to PR 2** —
  Better Auth wraps the login response in `twoFactorRedirect`
  automatically once the user enrols, but the web app's
  current login page doesn't handle that branch yet; we add
  it in PR 2 alongside the per-role policy.

## Login-flow risk and the super-admin gate

Validated by reading the plugin source: enabling TOTP causes
`/sign-in/email` (password) sign-ins to return
`{ twoFactorRedirect: true, twoFactorMethods: ["totp"] }`
instead of setting the session cookie. Our `/login` page
currently treats any 200 from sign-in as success and
immediately calls `/api/public/session-zones`, which would
401 because the session was never created.

Worse: `/sign-in/email-otp` and `/sign-in/magic-link` are NOT
covered by the plugin's after-hook, so an MFA-enrolled user
can still sign in unchallenged via either path — the
"second factor" is not actually mandatory.

Both issues are addressed in PR 2. PR 1 is safe to ship
*because* the enrollment surface is gated to super-admins,
who:
  - Are platform staff who understand the limitations.
  - Can recover from a lockout by running
    `pnpm --filter @stewardledger/api make-super-admin`
    against another super-admin account, or by direct DB
    surgery on `user.two_factor_enabled` + the `two_factor`
    row.
  - Will validate the end-to-end flow (enroll → sign out →
    sign in via password → challenged → verify) so we know
    the plumbing works before PR 2 widens access.
