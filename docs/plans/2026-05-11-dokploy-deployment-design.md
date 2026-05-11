# Dokploy deployment design

Date: 2026-05-11
Branch: `feature/dokploy-deployment`

## Goal

Prepare StewardLedger for deployment on Dokploy using Docker, with placeholder domains that can be replaced in the Dokploy UI or environment variables later.

## Context

- StewardLedger's docs already select Docker + Dokploy as the deployment target.
- The repository currently has `Dockerfile.api` and local-only `docker-compose.yml` for Postgres/test Postgres.
- The repository does not yet have `Dockerfile.web`, `docker-compose.prod.yml`, or generated Drizzle migration files.
- The user chose bundled Postgres 17 in the Dokploy Compose project and requested generated migrations rather than `db:push` for deployment.

## Chosen approach

Use a single Dokploy Compose project containing explicitly StewardLedger-prefixed service names:

1. `stewardledger-postgres` — PostgreSQL 17 with a persistent volume and healthcheck.
2. `stewardledger-api-migrate` — a one-shot service that waits for healthy Postgres, runs Drizzle migrations, then applies idempotent database bootstrap triggers.
3. `stewardledger-api` — the Hono API server, exposed internally on port `3000`, with a `/health/ready` healthcheck and a persistent storage volume for uploaded/imported/report files.
4. `stewardledger-web` — the SvelteKit adapter-node SSR app, exposed internally on port `3000`.

Dokploy will provide external routing/domain bindings. The compose file should use placeholder domain-oriented environment values so operators can replace them during setup. Do not set `container_name`; Compose/Dokploy project names should namespace containers, networks, and volumes without blocking scaling or creating global name conflicts. The project name should be configurable with `COMPOSE_PROJECT_NAME`, defaulting to `stewardledger-prod` to avoid colliding with the local dev Compose project.

## Alternatives considered

### Separate Dokploy apps plus external Postgres

This is cleaner for later scaling and managed database operations, but it adds more setup work now. It also conflicts with the chosen bundled Postgres path.

### Nixpacks/buildpack deployment

This can be faster for simple apps, but StewardLedger is a pnpm/turbo monorepo with SvelteKit adapter-node, Hono, Drizzle migrations, and persistent file storage. Docker Compose gives more predictable production behavior.

### `db:push` on startup

This is practical for early staging, but production should prefer generated forward-only migrations. The user selected generated migrations.

## Implementation details

### Dockerfiles

- Add `Dockerfile.web` for `packages/web` using Node 22 Alpine, pnpm 9.15.0, and SvelteKit adapter-node output.
- Keep `Dockerfile.api`, but ensure the runtime image includes enough workspace metadata/source to run `pnpm --filter @stewardledger/db db:migrate` and `pnpm --filter @stewardledger/db db:bootstrap` in the one-shot migration service.

### Compose file

Add `docker-compose.prod.yml` with:

- `stewardledger-postgres` using `postgres:17-alpine`.
- `stewardledger-api-migrate` built from `Dockerfile.api`, dependent on `stewardledger-postgres` health, command:
  - `pnpm --filter @stewardledger/db db:migrate`
  - `pnpm --filter @stewardledger/db db:bootstrap`
- `stewardledger-api` built from `Dockerfile.api`, dependent on successful `stewardledger-api-migrate`, with `STORAGE_ROOT=/data/storage` and a persistent storage volume.
- `stewardledger-web` built from `Dockerfile.web`, with `HOST=0.0.0.0`, `PORT=3000`, `ORIGIN` derived from `PUBLIC_APP_URL`, and runtime `PUBLIC_API_URL`.

### Runtime public environment

Change `packages/web/src/lib/env.ts` to read SvelteKit runtime public env (`PUBLIC_API_URL`) rather than Vite build-time `VITE_API_URL`. This lets operators update API domains in Dokploy without rebuilding the image.

### Migrations

Generate the initial Drizzle migration files under `packages/db/drizzle`. Production deployment uses `db:migrate`, followed by `db:bootstrap` for the idempotent contribution triggers and invariants.

### Documentation

Add a deployment guide covering:

- Dokploy Compose app creation.
- Required environment variables.
- Placeholder domain replacement.
- Routing guidance for `stewardledger-web` and `stewardledger-api` services.
- First-deploy and redeploy steps.
- Operational notes for migrations, backups, and persistent volumes.

## Verification plan

- Generate migrations and confirm they are committed.
- Run `pnpm --filter @stewardledger/web build`.
- Run `pnpm --filter @stewardledger/api build`.
- Run `pnpm check` if feasible.
- Run a local production compose smoke test if feasible with placeholder/local env values.

## Non-goals

- No real production secrets or domain names committed.
- No custom Traefik label setup unless Dokploy requires it later; domains are expected to be configured in Dokploy.
- No worker container yet, because a separate background worker entrypoint is not present in the current codebase.
- No switch to external managed Postgres in this change.
