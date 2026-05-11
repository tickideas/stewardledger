# Dokploy Deployment Implementation Plan

> **REQUIRED SUB-SKILL:** Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task.

**Goal:** Add production-ready Docker/Dokploy deployment support for StewardLedger with generated Drizzle migrations, a web image, a production Compose file, and operator documentation.

**Architecture:** Use one Dokploy Compose project with explicitly StewardLedger-prefixed service names, Postgres 17, a one-shot migration/bootstrap service, the Hono API service, and the SvelteKit SSR web service. Keep routing/domain assignment in Dokploy, while Compose owns build, service dependencies, healthchecks, and persistent volumes.

**Tech Stack:** Node 22 Alpine, pnpm 9.15.0, Turborepo workspace packages, SvelteKit adapter-node, Hono, Drizzle Kit migrations, PostgreSQL 17, Docker Compose, Dokploy.

---

## Preconditions

- Current branch is `feature/dokploy-deployment`.
- Approved design exists at `docs/plans/2026-05-11-dokploy-deployment-design.md`.
- No production secrets are committed.
- The user selected bundled Postgres and generated Drizzle migrations.

## File structure

- Create `Dockerfile.web`: production image for `packages/web`.
- Create `docker-compose.prod.yml`: Dokploy Compose stack for `stewardledger-postgres`, `stewardledger-api-migrate`, `stewardledger-api`, and `stewardledger-web`.
- Create `docs/DEPLOYMENT.md`: Dokploy deployment/runbook.
- Create `packages/db/drizzle/**`: generated Drizzle migration SQL and metadata.
- Modify `Dockerfile.api`: copy generated migrations into the API image and keep runtime migration/bootstrap support.
- Modify `packages/api/build.mjs`: bundle workspace packages into the API server bundle so runtime does not depend on TypeScript source exports.
- Modify `packages/web/src/lib/env.ts`: use runtime `PUBLIC_API_URL` via SvelteKit dynamic public env.
- Modify `packages/web/vite.config.ts`: force workspace packages to bundle into SvelteKit SSR output.
- Modify `.env.example`: document Dokploy/runtime variables without secrets.
- Modify `README.md` and `docs/README.md`: link the deployment guide.
- Modify `docs/ARCHITECTURE.md`: update deployment section to reflect the actual files/services.

---

### Task 1: Generate the initial Drizzle migration

**TDD scenario:** Infrastructure generation — no unit test. Verification is generated migration files plus later migration smoke test.

**Files:**
- Create: `packages/db/drizzle/*.sql`
- Create: `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/drizzle/meta/*.json`

**Why this task exists:** Production deployments should use forward-only migrations rather than `db:push`. The current repo has Drizzle schema source but no committed migration history.

- [ ] **Step 1: Generate migration files**

Run:

```bash
pnpm --filter @stewardledger/db exec drizzle-kit generate --name initial_schema
```

Expected:

```text
No errors from drizzle-kit. New files appear under packages/db/drizzle/.
```

- [ ] **Step 2: Inspect generated SQL for forbidden financial types**

Run:

```bash
rg -n "double precision|real|float|money\b" packages/db/drizzle || true
```

Expected:

```text
No matches.
```

- [ ] **Step 3: Confirm migration metadata exists**

Run:

```bash
test -f packages/db/drizzle/meta/_journal.json && ls packages/db/drizzle/*.sql
```

Expected:

```text
At least one SQL migration path is printed.
```

---

### Task 2: Make the API build and image migration-safe

**TDD scenario:** Modifying build/deployment code — run targeted build verification after changes.

**Files:**
- Modify: `packages/api/build.mjs`
- Modify: `Dockerfile.api`

**Why this task exists:** The API bundle currently externalizes all dependencies listed in `packages/api/package.json`, including workspace packages that export TypeScript source. The production image also needs generated Drizzle migrations for the one-shot migration service.

- [ ] **Step 1: Update `packages/api/build.mjs` external dependency filtering**

Replace the current `external` declaration with this implementation:

```js
const workspaceScope = "@stewardledger/";
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
].filter((name) => !name.startsWith(workspaceScope));
```

Expected behavior: `@stewardledger/db` and `@stewardledger/shared` are bundled into `dist/server.js`; third-party packages such as `hono`, `drizzle-orm`, `postgres`, and `better-auth` remain external.

- [ ] **Step 2: Copy Drizzle migration files in `Dockerfile.api`**

In the runner stage, after copying `packages/db/src`, add a copy instruction for generated migrations:

```dockerfile
COPY packages/db/drizzle packages/db/drizzle
```

Keep these existing runtime-support copies:

```dockerfile
COPY packages/db/src packages/db/src
COPY packages/db/drizzle.config.ts packages/db/drizzle.config.ts
COPY tsconfig.base.json ./
```

- [ ] **Step 3: Build the API package locally**

Run:

```bash
pnpm --filter @stewardledger/api build
```

Expected:

```text
API bundled to dist/server.js
```

- [ ] **Step 4: Confirm workspace packages are not runtime imports in the API bundle**

Run:

```bash
rg -n "(from ['\"]@stewardledger/(db|shared)|require\\(['\"]@stewardledger/(db|shared)|import\\(['\"]@stewardledger/(db|shared))" packages/api/dist/server.js || true
```

Expected:

```text
No matches. Plain source comments mentioning `@stewardledger/*` are acceptable; runtime imports are not.
```

---

### Task 3: Add the SvelteKit production web image and runtime public env

**TDD scenario:** Modifying SvelteKit build/runtime configuration — run web build and Svelte check after changes.

**Files:**
- Create: `Dockerfile.web`
- Modify: `packages/web/src/lib/env.ts`
- Modify: `packages/web/vite.config.ts`

**Why this task exists:** Dokploy needs a web container image. The web app must read `PUBLIC_API_URL` at runtime so operators can change API domains in Dokploy without rebuilding the image.

- [ ] **Step 1: Replace `packages/web/src/lib/env.ts` with runtime public env**

Use this content:

```ts
// packages/web/src/lib/env.ts
// SvelteKit-side public runtime environment. Server-only secrets must NOT live here.

import { env } from "$env/dynamic/public";

export const PUBLIC_API_URL = env.PUBLIC_API_URL || "http://localhost:3000";
```

- [ ] **Step 2: Update `packages/web/vite.config.ts` to bundle workspace packages**

Use this content:

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  ssr: {
    noExternal: ["@stewardledger/api", "@stewardledger/shared"],
  },
});
```

- [ ] **Step 3: Create `Dockerfile.web`**

Use this content:

```dockerfile
# ─── Web Dockerfile ─────────────────────────────────
# Builds the SvelteKit adapter-node app and runs it with Node.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ─── Install dependencies ──────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

# ─── Build the SvelteKit app ────────────────────────
FROM deps AS builder
COPY packages/shared packages/shared
COPY packages/api packages/api
COPY packages/web packages/web
COPY tsconfig.base.json ./
RUN pnpm --filter @stewardledger/web exec svelte-kit sync \
  && pnpm --filter @stewardledger/web build

# ─── Production image ──────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=deps /app/packages/shared/package.json packages/shared/package.json
COPY --from=deps /app/packages/api/package.json packages/api/package.json
COPY --from=deps /app/packages/web/package.json packages/web/package.json
COPY --from=builder /app/packages/web/build packages/web/build

EXPOSE 3000

CMD ["node", "packages/web/build"]
```

- [ ] **Step 4: Build the web package locally**

Run:

```bash
pnpm --filter @stewardledger/web build
```

Expected:

```text
vite build completes successfully and writes packages/web/build/.
```

---

### Task 4: Add the Dokploy production Compose file

**TDD scenario:** New infrastructure file — verify with Compose config rendering and, if Docker is available, a local build.

**Files:**
- Create: `docker-compose.prod.yml`

**Why this task exists:** Dokploy needs a reproducible service definition for database, migration, API, web, healthchecks, and persistent volumes.

- [ ] **Step 1: Create `docker-compose.prod.yml`**

Use this content:

```yaml
name: ${COMPOSE_PROJECT_NAME:-stewardledger-prod}

x-api-build: &api-build
  context: .
  dockerfile: Dockerfile.api

x-web-build: &web-build
  context: .
  dockerfile: Dockerfile.web

x-api-env: &api-env
  DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
  AUTH_SECRET: ${AUTH_SECRET:?AUTH_SECRET is required}
  PUBLIC_API_URL: ${PUBLIC_API_URL:-https://api.example.invalid}
  PUBLIC_APP_URL: ${PUBLIC_APP_URL:-https://app.example.invalid}
  PUBLIC_APP_DOMAIN: ${PUBLIC_APP_DOMAIN:-app.example.invalid}
  PUBLIC_TENANT_DOMAIN: ${PUBLIC_TENANT_DOMAIN:-example.invalid}
  USESEND_API_KEY: ${USESEND_API_KEY:-}
  USESEND_API_URL: ${USESEND_API_URL:-}
  STORAGE_ROOT: /data/storage
  LOG_LEVEL: ${LOG_LEVEL:-info}
  NODE_ENV: production

services:
  stewardledger-postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-stewardledger}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: ${POSTGRES_DB:-stewardledger}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 10s

  stewardledger-api-migrate:
    build: *api-build
    restart: "no"
    depends_on:
      stewardledger-postgres:
        condition: service_healthy
    environment:
      <<: *api-env
    command: >
      sh -c "pnpm --filter @stewardledger/db db:migrate &&
             pnpm --filter @stewardledger/db db:bootstrap"

  stewardledger-api:
    build: *api-build
    restart: unless-stopped
    depends_on:
      stewardledger-api-migrate:
        condition: service_completed_successfully
    environment:
      <<: *api-env
      PORT: 3000
    volumes:
      - app_storage:/data/storage
    expose:
      - "3000"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:3000/health/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

  stewardledger-web:
    build: *web-build
    restart: unless-stopped
    depends_on:
      stewardledger-api:
        condition: service_healthy
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3000
      ORIGIN: ${PUBLIC_APP_URL:-https://app.example.invalid}
      PUBLIC_API_URL: ${PUBLIC_API_URL:-https://api.example.invalid}
    expose:
      - "3000"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:3000/').then((r)=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))\"",
        ]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

volumes:
  pgdata:
  app_storage:
```

- [ ] **Step 2: Render the Compose config with local dummy env values**

Run:

```bash
DATABASE_URL=postgresql://stewardledger:local-password@stewardledger-postgres:5432/stewardledger \
POSTGRES_PASSWORD=local-password \
AUTH_SECRET=local-auth-secret-at-least-32-bytes \
docker compose -f docker-compose.prod.yml config >/tmp/stewardledger-compose.rendered.yml
```

Expected:

```text
The command exits 0 and writes /tmp/stewardledger-compose.rendered.yml.
```

---

### Task 5: Add deployment documentation and env examples

**TDD scenario:** Documentation/config change — verify links and commands manually.

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/ARCHITECTURE.md`

**Why this task exists:** Operators need exact Dokploy steps and required environment variables. Project rules require docs updates for behavior/deployment changes.

- [ ] **Step 1: Create `docs/DEPLOYMENT.md` with these sections**

Use a concise guide containing these exact headings:

```markdown
# Deployment

## Target

## Dokploy project type

## Required environment variables

## First deployment

## Dokploy routing

## Database migrations

## Persistent data

## Backups

## Health checks

## Troubleshooting
```

Include these required facts under the headings:

- Target is Docker Compose on Dokploy using `docker-compose.prod.yml`.
- Create a Dokploy Compose app from the Git repository and production branch.
- Set `DATABASE_URL`, `POSTGRES_PASSWORD`, and `AUTH_SECRET` as secrets in Dokploy.
- `COMPOSE_PROJECT_NAME` defaults to `stewardledger-prod`; set another host-unique project name when multiple StewardLedger environments share the same Docker host.
- Use example domains `https://app.example.invalid` and `https://api.example.invalid` in the documentation, and instruct the operator to replace them in Dokploy.
- Route the Dokploy `stewardledger-web` service port `3000` to the app domain.
- Route the Dokploy `stewardledger-api` service port `3000` to the API domain.
- Do not expose `stewardledger-postgres` publicly.
- `stewardledger-api-migrate` runs `db:migrate` then `db:bootstrap` before `stewardledger-api` starts.
- Do not add `container_name`; let Dokploy/Compose namespace containers, networks, and volumes by project name.
- Persistent volumes are `pgdata` and `app_storage`.
- Health endpoints are `/health/live`, `/health/ready`, and `/health/db` on the API service.

- [ ] **Step 2: Update `.env.example`**

Add a production/Dokploy block after the local URL variables:

```dotenv
# Dokploy / production examples (replace in Dokploy; do not commit real secrets)
# Optional but useful when one Docker host runs multiple Compose projects.
COMPOSE_PROJECT_NAME=stewardledger-prod
POSTGRES_USER=stewardledger
POSTGRES_PASSWORD=replace-in-dokploy
POSTGRES_DB=stewardledger
# In Dokploy, DATABASE_URL should point at the Compose Postgres service, for example:
# postgresql://stewardledger:replace-in-dokploy@stewardledger-postgres:5432/stewardledger
PORT=3000
HOST=0.0.0.0
```

- [ ] **Step 3: Link deployment docs from root README**

Add `docs/DEPLOYMENT.md` to the Documentation list in `README.md` with this text:

```markdown
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Dokploy deployment and operations guide.
```

- [ ] **Step 4: Link deployment docs from docs index**

Add `DEPLOYMENT.md` to `docs/README.md` in the existing documentation list.

- [ ] **Step 5: Update `docs/ARCHITECTURE.md` deployment section**

Change Section 15 so it matches the implemented files:

- `Dockerfile.api`
- `Dockerfile.web`
- `docker-compose.prod.yml`
- `stewardledger-postgres`, `stewardledger-api-migrate`, `stewardledger-api`, and `stewardledger-web` services
- Bundled Postgres for this Dokploy setup
- Future `worker` service remains deferred until a worker entrypoint exists

---

### Task 6: Run verification

**TDD scenario:** Final verification — run commands and capture outcomes before claiming success.

**Files:**
- No new files.

**Why this task exists:** Deployment changes are only useful if the builds and config render cleanly.

- [ ] **Step 1: Run package builds**

Run:

```bash
pnpm --filter @stewardledger/api build
pnpm --filter @stewardledger/web build
```

Expected:

```text
Both builds exit 0.
```

- [ ] **Step 2: Run checks**

Run:

```bash
pnpm check
```

Expected:

```text
Turborepo check exits 0.
```

- [ ] **Step 3: Render production Compose config**

Run:

```bash
DATABASE_URL=postgresql://stewardledger:local-password@stewardledger-postgres:5432/stewardledger \
POSTGRES_PASSWORD=local-password \
AUTH_SECRET=local-auth-secret-at-least-32-bytes \
docker compose -f docker-compose.prod.yml config >/tmp/stewardledger-compose.rendered.yml
```

Expected:

```text
Compose renders without interpolation or YAML errors.
```

- [ ] **Step 4: Build production images if Docker is available**

Run:

```bash
DATABASE_URL=postgresql://stewardledger:local-password@stewardledger-postgres:5432/stewardledger \
POSTGRES_PASSWORD=local-password \
AUTH_SECRET=local-auth-secret-at-least-32-bytes \
docker compose -f docker-compose.prod.yml build stewardledger-api stewardledger-web
```

Expected:

```text
Both images build successfully, or the command is skipped only if Docker is unavailable in the execution environment.
```

- [ ] **Step 5: Review git diff**

Run:

```bash
git diff --stat && git diff --check
```

Expected:

```text
git diff --check exits 0 with no whitespace errors.
```
