# StewardLedger

> The church finance ledger. From a single member's giving to a zone's annual partnership — recorded once, traceable forever, reportable in seconds.
>
> Multi-tenant SaaS for church finance & stewardship. Brand-new product, separate from echurcher.

## Documentation

Start here:

- [`docs/PRD.md`](docs/PRD.md) — what we are building, for whom, why.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — stack, layout, tenancy, deployment.
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
└── Dockerfile.web    # added in a later phase
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
pnpm db:studio    # Open Drizzle Studio
pnpm db:generate  # Generate migration files from schema diffs
pnpm db:push      # Push schema directly to dev DB
```

## Status

**Phase 1 — foundations.** Auth, tenancy resolution, regions/zones/chapters/roles schema, audit log, health endpoints, and the empty SvelteKit shell. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full plan.

## License

Proprietary. © 2026 Tickideas. All rights reserved.
