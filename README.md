# StewardLedger

> The church finance ledger. From a single member's giving to a zone's annual partnership — recorded once, traceable forever, reportable in seconds.
>
> Multi-tenant SaaS for church finance & stewardship. Brand-new product, separate from echurcher.

## Documentation

Start here:

- [`docs/PRD.md`](docs/PRD.md) — what we are building, for whom, why.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — stack, layout, tenancy, deployment.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Dokploy deployment and operations guide.
- [`docs/DOMAIN-MODEL.md`](docs/DOMAIN-MODEL.md) — full target schema.
- [`docs/DOMAIN-REFERENCE.md`](docs/DOMAIN-REFERENCE.md) — lessons from the legacy Church Plus app.
- [`docs/REPORTS.md`](docs/REPORTS.md) — every v1 report and its acceptance.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased build plan.
- [`docs/BRAND.md`](docs/BRAND.md) — naming, casing, voice.
- [`AGENTS.md`](AGENTS.md) — conventions for humans and agents.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | SvelteKit 2 (Svelte 5), Tailwind 4 |
| API | Hono on Node 22 LTS |
| Validation | Zod end-to-end |
| Database | PostgreSQL 17 |
| ORM | Drizzle ORM + drizzle-kit |
| Auth | Better Auth (email OTP, magic link, password) |
| Background jobs | pg-boss (Phase 6 onwards) |
| Email | useSend (self-hosted) |
| Object storage | S3-compatible (R2 / Backblaze B2) |
| Monorepo | pnpm workspaces + Turborepo |
| Deploy | Docker + Dokploy |

## Project layout

```
stewardledger/
├── packages/
│   ├── shared/    # Zod schemas, types, money utils, role taxonomy
│   ├── db/        # Drizzle schema, migrations, client
│   ├── api/       # Hono API server (port 3000)
│   └── web/       # SvelteKit app (port 5173)
├── docs/          # Design docs (canonical, versioned)
├── docker-compose.yml
├── Dockerfile.api
├── Dockerfile.web
└── docker-compose.prod.yml
```

## Getting started

### Prerequisites

- Node.js 20+ and < 25 (CI runs Node 22 LTS)
- pnpm 9+
- Docker (for PostgreSQL)

### Setup

```bash
# Install dependencies
pnpm install

# Copy env and edit
cp .env.example .env

# Start PostgreSQL
docker compose up -d --wait db

# Push the Phase 1 schema
pnpm db:push

# Run dev (API on :3000, web on :5173)
pnpm dev
```

### Useful scripts

```bash
pnpm dev          # Start API + web in watch mode
pnpm build        # Build everything via Turborepo
pnpm check        # TypeScript / Svelte check across packages
pnpm lint         # Biome lint across packages
pnpm test         # Push test schema + run tests
pnpm db:studio          # Open Drizzle Studio
pnpm db:generate        # Generate migration files from schema diffs
pnpm db:push            # Push schema directly to dev DB
pnpm seed:demo -- --reset # Recreate the three local demo zones and sample giving data
pnpm create-admin -- --email you@example.com --password-env ADMIN_PASSWORD --name 'You'
pnpm make-super-admin -- you@example.com --confirm # Elevate an existing user after printing bindings
```

### Demo access

`pnpm seed:demo -- --reset` creates demo tenant data, not login accounts. The seeded demo zones are `demo-grace-uk`, `demo-lighthouse-us`, and `demo-river-ng`.

Create a platform admin with `pnpm create-admin`, sign in at `/login`, then open `/onboarding/invites?zone=<demo-slug>` to invite a demo user. Choose a zone-wide role for zone access, or choose a chapter role and chapter for church-level access. The invitee opens the invitation URL, creates their own password, and then signs in with their email and chosen password. In local development, invitation URLs are printed in the API logs when email sending is not configured.

## Status

**Phase 5 — contributions.** Phases 1–4 are closed (foundations,
tenancy/onboarding, members, giving setup & periods). Phase 5 ships the
draft → posted → voided/reversed state machine end-to-end: services,
tenant API, posted-immutability triggers, full role bundles, and the
treasurer SvelteKit UI for the Sunday close (batch list, new-batch form,
batch detail with inline add-row, contribution detail, and a member
statement preview). A local platform-admin zones dashboard and deterministic
demo seeding scripts are also in place for operator demos. Bulk import /
dup-detection (Phase 6) and full reports (Phase 7) come next. See
[`docs/ROADMAP.md`](docs/ROADMAP.md) and [`CHANGELOG.md`](CHANGELOG.md)
for the full plan.

## License

Proprietary. © 2026 Tickideas. All rights reserved.
