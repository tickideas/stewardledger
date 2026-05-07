# Changelog

All notable changes to StewardLedger are recorded here. Format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows phased releases per [`docs/ROADMAP.md`](docs/ROADMAP.md).

## [Unreleased]

## [0.2.0] — Phase 2: Onboarding & tenancy

Implements the public sign-up flow, the invitation lifecycle, the first
tenant-scoped CRUD endpoints, and the platform-admin region inbox. All
backend changes are covered by 27 vitest cases (15 → 27), including 12
cross-tenant fuzz tests that drive the real Hono middleware stack.

### Added

- **Public signup** (`POST /api/public/signup`) — creates a zone in
  `pending_setup`, seeds the 9 system roles, and emails the primary contact
  a `zone_owner` invitation. No Better Auth user is created at signup; the
  user is created when the invitation is accepted.
- **Invitations** — new `invitations` table (zone-scoped, SHA-256 token
  hash, 7-day default expiry, partial unique index on open invites).
  Lifecycle endpoints:
  - `GET  /api/public/invitations/:token`
  - `POST /api/public/invitations/accept` — runs Better Auth `signUpEmail`,
    binds the user, promotes the zone to `active` for `zone_owner` accepts.
  - `GET  /api/tenant/invitations`
  - `POST /api/tenant/invitations` — zone owners/admins; cannot mint a
    second `zone_owner`.
  - `POST /api/tenant/invitations/:id/revoke`
- **Tenant API** under `tenantMiddleware → requireSession → requireTenantAuth`:
  - `GET  /api/tenant/me` — `AuthorizedContext` for the current zone.
  - `GET  /api/tenant/chapters`
  - `POST /api/tenant/chapters` — auto-derives reference codes
    (`C000001` default; per-zone branding override-aware).
- **Platform-admin API** under `requireSession → requirePlatformRole`:
  - `GET/POST /api/admin/regions`, `PATCH /api/admin/regions/:id`
  - `GET  /api/admin/regions/inbox` — zones still on
    `region_name_unverified`.
  - `POST /api/admin/regions/promote` — atomic: create-or-pick region,
    retarget zones, fan out denormalized `region_id` to chapters, audit.
- **Auth middleware** — `requireSession`, `requireTenantAuth`,
  `requirePlatformRole`, `hasAnyRole`.
- **Region typeahead** for the signup form (`GET /api/public/regions/typeahead`).
- **Web pages** (SvelteKit 2):
  - `/signup` — region typeahead + free-text fallback.
  - `/signup/check-email` — confirmation.
  - `/invite/[token]` — SSR-loaded accept page (≥12-char password).
  - `/onboarding/chapter`, `/onboarding/invites` — first-run flow.
  - `/admin/regions`, `/admin/regions/inbox` — region curation.
- **Shared schemas/constants** — `regionUpdateSchema`,
  `regionPromoteSchema`, `regionTypeaheadSchema`, `invitationCreateSchema`,
  `invitationAcceptSchema`, `INVITATION_TOKEN_BYTES`,
  `INVITATION_VALIDITY_HOURS`.
- **`Db` / `DbTransaction`** types in `@stewardledger/db` for service
  signatures that accept either a connection or a transaction.

### Changed

- `zones`: now enforces `CHECK(region_id XOR region_name_unverified)`,
  case-insensitive unique on `name`, and a partial index for the
  unverified-region inbox query.
- `regions`: case-insensitive unique on `name`.
- **Region/zone names share a single global namespace** (case-insensitive).
  Enforced in the service layer (`assertNameAvailable` —
  `packages/api/src/services/names.ts`) per AGENTS rule 4 (no business logic
  in triggers); per-table `lower(name)` unique indexes backstop accidental
  intra-table duplicates.

### Documentation

- `docs/DOMAIN-MODEL.md` §2.3 — region/zone name disjointness invariant;
  new §2.6 — invitations table and signup/team-invitation flows.
- `docs/ARCHITECTURE.md` §12.1 — middleware stack table and route-group
  layout; §12.2 — invitation lifecycle.
- `docs/ROADMAP.md` — Phase 2 exit checklist updated. Self-service signup,
  region inbox, chapters/invitations, and cross-tenant isolation ticked.
  Custom-domain DNS verification remains open (deferred per scope).

### Tests

- `@stewardledger/api`: 15 → 27 passing.
  - `services/names.test.ts` — 4 cases (region/zone name collision, happy
    + sad paths, self-reference exemption).
  - `services/signup.test.ts` — 5 cases (zone create + role seed + invite,
    slug collision, name-collides-with-region, name-collides-with-other-zone,
    accept-flow activation).
  - `routes/tenant.test.ts` — 12 cross-tenant fuzz cases, driving the real
    Hono stack via `app.fetch` with `vi.spyOn(auth.api, "getSession")`:
    listing isolation, forbidden access (no binding / unbound user / no
    session), id smuggling (cross-zone `chapterId`, cross-zone revoke),
    payload validation (forbidden `zone_owner` invite, role/chapter
    mismatches), `/me` scope, and roles-table tenant-scoping.

### Open / deferred (carried into later phases)

- Custom-domain DNS verification flow (paid plan only).
- Self-service signup verified end-to-end on staging (verified locally only;
  needs a staging deploy + working useSend wiring).
- Phase 2 PRD §11 open questions (price points; refund policy on annual
  prepay; whether MFA is mandatory or default-on for Premium).

### Commits

- `8dcfe52` `[db]` add invitations table, zones region xor check, name disjointness indexes
- `36bb57e` `[shared]` zod schemas + constants for Phase 2 onboarding
- `d9c643b` `[api]` Phase 2 onboarding: signup, invitations, chapters, regions admin
- `0a865fc` `[web]` Phase 2 onboarding pages: signup, invite-accept, onboarding, admin
- `93c0795` `[docs]` Phase 2: invitations, name-disjointness, middleware stack, exit ticks
- `ecf7d10` `[api]` cross-tenant fuzz tests for tenant routes (12 cases)

## [0.1.0] — Phase 1: Foundations

Initial monorepo skeleton.

### Added

- pnpm + turbo monorepo with `@stewardledger/{api,db,shared,web}` packages.
- Hono API with health endpoints (`/health/{live,ready,db}`) and Better Auth
  (email + password, email OTP, magic link).
- Drizzle schema for identity, regions, zones, chapters, roles, audit
  (13 tables).
- Tenant-resolution middleware (Host → zone via subdomain or custom domain).
- SvelteKit 2 + Tailwind 4 shell with `/` and `/login`.
- pino logger, `docker-compose.yml` (dev + test), `Dockerfile.api`.
- `docs/{PRD,ARCHITECTURE,DOMAIN-MODEL,DOMAIN-REFERENCE,REPORTS,ROADMAP,BRAND}.md`.

### Commits

- `dcb4a84` Phase 1: monorepo skeleton, identity & tenancy schema, auth, health.
