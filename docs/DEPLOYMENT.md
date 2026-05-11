# Deployment

## Target

StewardLedger deploys to Dokploy as a Docker Compose app using `docker-compose.prod.yml`.

The production Compose stack runs the application services and bundled PostgreSQL 17 in one Dokploy project. Use placeholder domains such as `https://app.example.invalid` and `https://api.example.invalid` while setting up the app, then replace them in Dokploy with the real StewardLedger domains for the environment.

## Dokploy project type

Create a Dokploy **Compose** app from the StewardLedger Git repository and the production branch you want to deploy.

Use `docker-compose.prod.yml` as the Compose file. The services are deliberately StewardLedger-prefixed:

- `stewardledger-postgres`
- `stewardledger-api-migrate`
- `stewardledger-api`
- `stewardledger-web`

Do not add `container_name`; let Dokploy/Compose namespace containers, networks, and volumes by project name. The production Compose file defaults to `COMPOSE_PROJECT_NAME=stewardledger-prod`; use another host-unique project name when multiple StewardLedger environments share one Docker host.

## Required environment variables

Set secrets and runtime configuration in Dokploy, not in the repository.

Required secrets:

```dotenv
DATABASE_URL=postgresql://stewardledger:<replace-in-dokploy>@stewardledger-postgres:5432/stewardledger
POSTGRES_PASSWORD=<replace-in-dokploy>
AUTH_SECRET=<32-byte-random-string>
```

The password embedded in `DATABASE_URL` must match `POSTGRES_PASSWORD`; if you change `POSTGRES_USER` or `POSTGRES_DB`, update `DATABASE_URL` to match.

Recommended non-secret runtime values:

```dotenv
COMPOSE_PROJECT_NAME=stewardledger-prod
POSTGRES_USER=stewardledger
POSTGRES_DB=stewardledger
PUBLIC_APP_URL=https://app.example.invalid
PUBLIC_API_URL=https://api.example.invalid
PUBLIC_APP_DOMAIN=app.example.invalid
PUBLIC_TENANT_DOMAIN=example.invalid
LOG_LEVEL=info
NODE_ENV=production
```

Replace `https://app.example.invalid` and `https://api.example.invalid` in Dokploy with the actual app and API domains for the environment. `PUBLIC_APP_URL`, `PUBLIC_APP_DOMAIN`, and `PUBLIC_TENANT_DOMAIN` are used by the API for invitation links, trusted origins, and tenant host resolution. The web service sets `ORIGIN` from `PUBLIC_APP_URL` so SvelteKit adapter-node can validate proxied requests behind Dokploy/Traefik.

## First deployment

1. Create the Dokploy Compose app from the StewardLedger Git repository and production branch.
2. Configure the required environment variables in Dokploy.
3. Confirm `DATABASE_URL` points at the Compose Postgres service host `stewardledger-postgres`.
4. Deploy the Compose app.
5. Wait for `stewardledger-api-migrate` to complete successfully.
6. Confirm `stewardledger-api` and `stewardledger-web` are healthy.
7. Configure routes for the web and API services.

## Dokploy routing

Configure Dokploy routing after the first build succeeds:

- Route the `stewardledger-web` service port `3000` to the app domain, for example `https://app.example.invalid`.
- Route the `stewardledger-api` service port `3000` to the API domain, for example `https://api.example.invalid`.
- Do not expose `stewardledger-postgres` publicly.

The example domains are placeholders. Replace them in Dokploy with real environment domains before production use.

## Database migrations

`stewardledger-api-migrate` runs before `stewardledger-api` starts. It runs:

```bash
pnpm --filter @stewardledger/db db:migrate
pnpm --filter @stewardledger/db db:bootstrap
```

`db:migrate` applies committed Drizzle migrations. `db:bootstrap` reapplies the idempotent database trigger/bootstrap layer required by StewardLedger's contribution invariants.

## Persistent data

The production Compose stack uses these persistent volumes:

- `pgdata` — PostgreSQL data for `stewardledger-postgres`.
- `app_storage` — application file storage mounted at `/data/storage` for `stewardledger-api`.

`docker-compose.prod.yml` sets `STORAGE_ROOT=/data/storage`; leave that value aligned with the `app_storage` mount unless you intentionally move application file storage.

Do not delete these volumes during redeploys unless you intentionally want to remove the environment's data.

## Backups

Back up `pgdata` before deploying schema changes and on a regular production schedule. At minimum, use `pg_dump` against the `stewardledger-postgres` service and store the dump outside the Dokploy host.

Also back up `app_storage` if the environment stores uploaded import files or generated report artifacts locally.

## Health checks

The API service exposes these health endpoints:

- `/health/live` — process liveness.
- `/health/ready` — readiness, including a database check.
- `/health/db` — database latency check.

The Compose healthcheck for `stewardledger-api` uses `/health/ready`. The `stewardledger-web` healthcheck requests `/` on its internal port.

## Troubleshooting

- If `stewardledger-api-migrate` fails, inspect its logs first; `stewardledger-api` waits for that service to complete successfully.
- If the API cannot connect to PostgreSQL, confirm `DATABASE_URL` uses host `stewardledger-postgres` and matches `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`.
- If Dokploy reports route conflicts, confirm routes target `stewardledger-web:3000` and `stewardledger-api:3000`, and that PostgreSQL is not routed publicly.
- If multiple StewardLedger environments run on the same Docker host, set a unique `COMPOSE_PROJECT_NAME` for each one.
- If files disappear after redeploy, confirm `app_storage` is still mounted at `/data/storage` on `stewardledger-api`.
