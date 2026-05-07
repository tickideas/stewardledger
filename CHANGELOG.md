# Changelog

All notable changes to StewardLedger are recorded here. Format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows phased releases per [`docs/ROADMAP.md`](docs/ROADMAP.md).

## [Unreleased]

### Added

- **Phase 5 contribution + batch services** —
  `packages/api/src/services/contributions.ts` and
  `packages/api/src/services/contribution-batches.ts`. Cover the full
  draft → posted → voided / reversed state machine, currency defaulting
  from the zone, cross-tenant guards on `chapter_id` / `member_id` /
  `giving_type_id` / `account_id` / `batch_id`, period auto-derivation,
  `region_id` denormalization from chapter, and a defense-in-depth
  currency cohesion re-check at batch-post time. Reversals emit a
  corrective contribution with negated amounts and
  `reversal_of_contribution_id` / `parent_contribution_id` set to the
  original (insert as draft, then promote to posted because the
  `contribution_lines_posted_guard` blocks line inserts on posted
  parents).
- **Tenant API for contributions and batches**
  (`packages/api/src/routes/tenant-contributions.ts`, mounted under
  `tenantRouter`):
  - `GET/POST /api/tenant/contributions`,
    `GET/PATCH/DELETE /api/tenant/contributions/:id`,
    `POST /api/tenant/contributions/:id/{post,void,reverse}`.
  - `GET/POST /api/tenant/contribution-batches`,
    `GET/PATCH /api/tenant/contribution-batches/:id`,
    `POST /api/tenant/contribution-batches/:id/{submit,approve,post,void}`.
  - Role bundles enforce zone-owner / pastor read of zone-wide totals,
    chapter-scoped read for chapter pastors / coordinators, treasurer +
    finance-admin write, and treasurer + zone-owner / finance-admin post
    (bookkeepers can draft but cannot post).
  - `ContributionError` codes are translated to HTTP status by an
    `ERROR_STATUS` map (validation → 400, cross-tenant / not-found →
    404, currency-mismatch / state → 409).
- **Service tests** (`packages/api/src/services/contributions-service.test.ts`)
  — 15 cases: happy-path create + post + read, zone currency default,
  currency mismatch rejection, no-lines guard, cross-tenant chapter and
  giving-type rejection, batch currency mismatch, draft update replaces
  lines, post / void state machine, reverse with negated amounts, draft
  delete (cascades), batch lifecycle (`draft → submitted → approved →
  posted` promotes embedded contributions), `voidBatch` refusal on
  already-posted batches, and `postBatch` currency-mismatch
  defense-in-depth.
- **Cross-tenant route tests**
  (`packages/api/src/routes/tenant-contributions.test.ts`) — 12 cases
  driving the real Hono stack: owner happy path, cross-tenant chapter
  and giving-type rejection, foreign-zone GET 404, pastor read-only,
  bookkeeper-can-draft-but-not-post, treasurer can post, posting a
  non-draft 409, void state machine, reverse via API, batch lifecycle,
  and batch currency mismatch.
- **Zod schemas** for the contribution + batch write paths in
  `packages/shared/src/schemas.ts`: `SOURCE_TYPES`, `sourceTypeSchema`,
  `contributionCreateSchema`, `contributionUpdateSchema`,
  `contributionListQuerySchema`, `contributionVoidSchema`,
  `contributionReverseSchema`, `contributionBatchCreateSchema`,
  `contributionBatchUpdateSchema`, `contributionBatchListQuerySchema`,
  `contributionBatchVoidSchema`. `moneyAmountSchema` is reused; negative
  amounts are now permitted to encode reversals.

### Changed

- **Sign convention adopted for contribution amounts.** The non-negative
  CHECK constraints on `contributions.total_amount` and
  `contribution_lines.amount` were dropped
  (`packages/db/src/schema/contributions.ts`). Sign now encodes
  direction: positive = inflow / gift, negative = reversal. The absolute
  amount of a reversal line must equal the original line. `AGENTS.md`
  hard rule #1 was extended to state this explicitly.
- **`docs/DOMAIN-MODEL.md` §6** — dropped `check (amount >= 0)` from the
  `contribution_lines` SQL block; added a "Sign convention (Phase 5)"
  callout; expanded the "Currency rule" paragraph to describe the
  service-layer default from the zone and the batch-post
  defense-in-depth re-check.
- **`docs/ROADMAP.md` Phase 5** — service + tenant API implementation
  notes added; state-machine and mixed-currency batch exit-checklist
  items ticked. Phase 4 currency-default item ticked with reference to
  `contributions-service.test.ts`.
- **`applyContributionTriggers` now serializes via a session advisory
  lock** (`packages/db/src/bootstrap-triggers.ts`). Three vitest test
  files race-bootstrapped the same triggers in parallel worker threads,
  which produced `tuple concurrently updated` (XX000) on
  `drop trigger ... on contributions`. Wrapping the install in
  `pg_advisory_lock(hashtext('stewardledger.applyContributionTriggers'))`
  serializes concurrent callers without changing single-process
  behaviour.

- **Phase 5 contributions schema** — `contribution_batches`, `contributions`,
  `contribution_lines`, and `contribution_members` tables under
  `packages/db/src/schema/contributions.ts`. Each row is `zone_id`-scoped
  with composite `(zone_id, *)` foreign keys so cross-tenant references are
  rejected at the database. CHECK constraints cover non-negative money,
  posted-requires-postedAt, voided-requires-voidedAt, allocation percent
  range, and anti-self-reference on `reversal_of_contribution_id` /
  `parent_contribution_id`.
- **Posted-immutability + currency-cohesion + TRUNCATE-guard triggers**
  (`packages/db/src/bootstrap-triggers.ts`) applied idempotently by a new
  `pnpm --filter @stewardledger/db db:bootstrap` script. Triggers raise
  SQLSTATE `23514` so callers can match on the code rather than message
  text. The bootstrap script restricts `ENV_FILE` resolution to the repo
  root, closes its DB connection on exit, and re-`enable trigger`s after
  recreating each function so a crashed test run that left a trigger
  disabled self-heals on the next bootstrap.
- **DB-level invariant tests** (`packages/api/src/services/contributions.test.ts`)
  — 22 cases covering cross-tenant FK rejection (line→contribution,
  giving_type, account, member, reversal/parent), CHECK constraints
  (negative totals, posted-without-postedAt, voided-without-voidedAt,
  self-reversal, allocation 0/100/101), currency cohesion on INSERT and
  UPDATE, posted→voided / posted→reversed happy paths, posted→draft
  rejection, posted-row delete + line CRUD rejection, TRUNCATE rejection,
  cascade delete of draft contributions, and zone-default vs override
  currency on batches.

### Changed

- **`AGENTS.md` hard rule #4** broadened to permit triggers for cross-row
  invariants that a CHECK cannot express, currently the contribution↔line
  currency-cohesion check and the `contributions` / `contribution_lines`
  TRUNCATE guards.
- **Policy delta** — posted contributions are immutable except for
  `status` transitions to `voided` / `reversed` and the void/reverse
  bookkeeping columns (`voided_at`, `voided_by_user_id`, `void_reason`,
  `updated_at`, `updated_by_user_id`). `region_id` is treated as
  write-once after posting; fan-out region updates run against draft rows
  only.
- **`docs/DOMAIN-MODEL.md` §6** — `contribution_batches` SQL block now
  lists the `submitted_*`, `approved_*`, `voided_*`, `void_reason`
  columns; `contribution_members` block lists `zone_id` and the
  allocation-percent CHECK that the Drizzle schema already declared.
- **`docs/ROADMAP.md` Phase 4** currency tick narrowed: the contribution
  + batch *schema* permits currency overrides today; the service-layer
  default of `contribution.currency_code` from the zone is wired up in
  Phase 5 alongside the contribution write paths.

### Fixed (Phase 5 review pass)

- **Sign-convention guard rails.** Non-reversal create/update paths now
  reject non-positive line amounts with a typed `non_positive_amount`
  service error (HTTP 400). Reversals still flip every line and the new
  `|reversal| == |original|` invariant has a dedicated service test.
- **Cross-tenant FK leakage closed.** `assertReferencesInZone` and
  `createBatch` / `updateDraftBatch` now also enforce `chapter_id`
  cohesion on `batchId` and `serviceEventId` references inside the same
  zone, surfacing the new `batch_chapter_mismatch` /
  `service_event_chapter_mismatch` codes (HTTP 404). Service tests cover
  both, including the zone-wide `service_events.chapter_id IS NULL`
  accept path.
- **Currency-only PATCHes are re-checked against the batch.** Patching
  only `currencyCode` on a contribution that is attached to a batch now
  re-runs the `batch_currency_mismatch` probe instead of trusting a
  cached field comparison.
- **Mass-assignment hardening.** `updateDraftContribution` and
  `updateDraftBatch` are now driven by explicit
  `UPDATE_DIRECT_COLUMNS` / `BATCH_UPDATE_COLUMNS` allow-lists rather
  than `Object.entries(patch)` iteration.
- **`pg_advisory_lock` for trigger bootstrap** — see Phase 5 notes; this
  is the de-flaked variant that was uncovered during the review.
- **Performance.** Five reference checks in `createContribution` /
  `updateDraftContribution` now run via `Promise.all` against a shared
  `_zone-scope.ts` helper. `postBatch` writes its per-row audit
  envelopes via a single `writeAuditMany` insert and fuses the
  mismatch-probe + draft-scan SELECT into one round-trip.
  `reverseContribution` and `updateDraftContribution` no longer issue a
  trailing `loadDetail` round-trip — both read their `RETURNING`
  rows directly.
- **Reversal date now respects the zone time zone.** `todayInZone()`
  derives the corrective contribution's `contribution_date` from
  `Intl.DateTimeFormat('en-CA', { timeZone })` against the zone's
  configured `default_time_zone` instead of UTC, so reversals booked
  near midnight no longer drift across the date line.
- **Self-contained reversal audit.** Reversing a posted contribution
  now writes three audit rows on the corrective contribution
  (`contribution.reverse` on the original, `contribution.create` and
  `contribution.post` on the new row) so the audit trail no longer
  depends on the original transaction's audit footprint.
- **Drizzle-everywhere in tests.** The Phase 5 service test no longer
  uses `db.execute<T>(sql\`select ...\`)` for typed reads; lookups go
  through `db.select(...).from(serviceTypes)` so the result type is
  inferred from the schema rather than asserted.
- **Stale docs / changelog claims.** `docs/DOMAIN-MODEL.md` invariant
  #3 was rewritten to describe the signed-sum service-layer enforcement
  (the old "amount >= 0" line was orphaned by the CHECK drop). The
  `isReversal: true` flag claim in the prior changelog block was
  replaced with the actual columns
  (`reversal_of_contribution_id` / `parent_contribution_id`).

## [0.3.0] — Phase 3: Members

Adds the people layer: members, addresses, the three zone-scoped lookup
tables (titles, marital statuses, member types), and the manual
member-merge flow. Per-zone seed data is created at signup. Bulk import,
bulk export, and auto-detected duplicates land in Phase 6 alongside the
flagship import pipeline.

### Added

- **Schema** — 6 new tables under `packages/db/src/schema/`:
  - `members` (zone-scoped, soft-deleteable, generated `full_name` from
    immutable string ops, gender CHECK, denormalized `region_id`).
  - `member_addresses` (one-to-many, `is_primary` + `date_to` lifecycle,
    partial unique index enforcing a single primary-active address per
    member).
  - `titles`, `marital_statuses`, `member_types` (per-zone lookups with
    case-insensitive unique on name).
  - `member_merge_proposals` (status: pending / approved / rejected /
    applied; partial unique on open pairs; primary ≠ duplicate CHECK).
- **Tenant API** under `tenantRouter`, mounted from
  `routes/tenant-members.ts`:
  - `GET/POST /api/tenant/members`, `GET/PATCH/DELETE /api/tenant/members/:id`
    (DELETE soft-deletes only; AGENTS forbids hard-delete of members).
  - `GET/POST /api/tenant/members/:id/addresses`,
    `PATCH/DELETE /api/tenant/members/:memberId/addresses/:addressId`
    (DELETE archives via `date_to`).
  - `GET/POST /api/tenant/lookups/titles`,
    `PATCH /api/tenant/lookups/titles/:id`.
  - `GET/POST /api/tenant/lookups/marital-statuses`,
    `PATCH /api/tenant/lookups/marital-statuses/:id`.
  - `GET/POST /api/tenant/lookups/member-types`,
    `PATCH /api/tenant/lookups/member-types/:id`.
  - `GET/POST /api/tenant/members/merge/proposals`,
    `POST /api/tenant/members/merge/apply`.
- **Member reference codes** — `services/member-codes.ts`. Default
  `M0000001`; per-zone branding override-aware (`branding.memberCode`).
- **Per-zone lookup seeds** — `services/lookup-seed.ts` runs inside the
  signup transaction. Seeds 11 titles, 5 marital statuses, 5 member types.
- **Merge apply** — `services/members.ts` rewrites `member_addresses`
  references, collapses any duplicate primary addresses on the survivor,
  soft-deletes the absorbed member, marks the proposal applied, and
  audits the operation. Future phases (contributions, imports, targets)
  must extend this function as those tables land.
- **Shared zod schemas** — `memberCreateSchema`, `memberUpdateSchema`,
  `memberListQuerySchema`, `memberAddressCreateSchema`,
  `memberAddressUpdateSchema`, `lookupCreateSchema`, `lookupUpdateSchema`,
  `titleCreateSchema`, `titleUpdateSchema`, `memberMergeProposeSchema`,
  `memberMergeApplySchema`.
- **Web pages** (SvelteKit 2):
  - `/members` — list + search + chapter filter + inline create.
  - `/members/[id]` — full edit form + addresses panel + soft-delete.
  - `/members/lookups` — add/disable titles, marital statuses, member types.
  - `/members/merge` — manual propose-and-apply queue.
  - `api.delete()` helper added to `packages/web/src/lib/api.ts`.

### Changed

- `signupZone` now also calls `seedZoneLookups` so every new zone arrives
  with the lookup defaults already populated.

### Decisions

- **Dedup**: schema + manual apply land in Phase 3; auto-detection job
  and proposal queue UI deferred to Phase 6 alongside the import pipeline.
- **Reference-code default**: `M` prefix, 7-digit pad. Branding-override
  takes the same shape as chapters (`branding.memberCode.prefix/pad`).
  Generation takes a transaction-scoped per-zone advisory lock before
  counting, so concurrent member creates do not collide on reference code.
- **`full_name`**: stored generated column built from `coalesce(...) || ' '
  || ...` + `regexp_replace(..., '\s+', ' ', 'g')` rather than
  `concat_ws`. Postgres flags `concat_ws` as STABLE, which is rejected by
  `GENERATED ALWAYS AS ... STORED`.
- **Addresses**: always soft-archived via `date_to`; never hard-deleted.
  At most one primary-active address per member, enforced both by service
  helper (`clearOtherPrimaryAddresses`) and a partial unique index.

### Documentation

- `docs/ROADMAP.md` Phase 3 exit checklist — model + manual merge ticked;
  bulk import row-throughput and dup heuristics carry into Phase 6.

### Tests

- `@stewardledger/api`: 27 → 52 passing.
  - `routes/tenant-members.test.ts` — 25 cross-tenant fuzz cases driving
    the real Hono stack via `app.fetch`. Coverage:
    - listing isolation (members)
    - cross-zone fetch by id (404)
    - chapter-scoped role isolation for list, fetch, update, and create
    - id-smuggling on create (foreign chapter / title → 404)
    - cross-zone update + delete attempts (404)
    - reference-code generator format + concurrent-create uniqueness
    - address tenancy (foreign member → 404, soft-deleted parent → 404)
    - primary-address invariant under repeated isPrimary inserts
    - lookup tenancy (titles list isolation, foreign-zone PATCH → 404 for
      marital statuses + member types, duplicate lookup names → 409)
    - per-zone lookup seed parity (same names, distinct ids)
    - cross-zone duplicate-id in merge propose (404)
    - duplicate open merge proposals → 409
    - concurrent merge apply serializes to one success + one conflict
    - paginated merge proposal listing
    - end-to-end propose → apply: address rewrite, primary-address collision
      resolution, reassignment audit, soft-delete, status flip
    - cross-zone proposal apply (404)
    - DELETE /members/:id soft-deletes (no row removal)

### Open / deferred (carried into later phases)

- Bulk member import + export (Phase 6 with the import pipeline).
- Auto duplicate-detection heuristics (Phase 6).
- Member dashboard widgets (counts by chapter / by status / new joiners) —
  the list page covers v1; richer dashboards land with the contributions
  views in Phase 5.

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
