// packages/db/src/bootstrap.ts
// Runs all idempotent bootstrap steps (currently: triggers). Invoked after
// `db:push` so the test DB and the dev DB get the same trigger set as prod.
//
// Usage:
//   ENV_FILE=../../.env.test pnpm --filter @stewardledger/db db:bootstrap

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { applyContributionTriggers } from "./bootstrap-triggers";
import * as schema from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../");
const defaultEnvPath = resolve(repoRoot, ".env");

function resolveEnvPath(): string {
  if (!process.env.ENV_FILE) return defaultEnvPath;
  // Restrict ENV_FILE resolution to the repo so a tampered env var cannot
  // redirect bootstrap at an attacker-controlled file.
  const candidate = resolve(process.cwd(), process.env.ENV_FILE);
  const repoRootWithSep = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  if (!candidate.startsWith(repoRootWithSep) && candidate !== repoRoot) {
    throw new Error(
      `ENV_FILE must resolve inside the repo root (${repoRoot}); got ${candidate}`,
    );
  }
  return candidate;
}

config({ path: resolveEnvPath() });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to bootstrap the database");
}

const client = postgres(databaseUrl);
const db = drizzle(client, { schema });
try {
  await applyContributionTriggers(db);
  console.log("[db:bootstrap] contribution triggers applied");
} catch (err) {
  console.error("[db:bootstrap] failed:", err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
