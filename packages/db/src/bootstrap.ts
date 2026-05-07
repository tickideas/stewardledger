// packages/db/src/bootstrap.ts
// Runs all idempotent bootstrap steps (currently: triggers). Invoked after
// `db:push` so the test DB and the dev DB get the same trigger set as prod.
//
// Usage:
//   ENV_FILE=../../.env.test pnpm --filter @stewardledger/db db:bootstrap

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyContributionTriggers } from "./bootstrap-triggers";
import { createDb } from "./client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = resolve(__dirname, "../../../.env");
const envPath = process.env.ENV_FILE
  ? resolve(process.cwd(), process.env.ENV_FILE)
  : defaultEnvPath;

config({ path: envPath });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to bootstrap the database");
}

const db = createDb(databaseUrl);
await applyContributionTriggers(db);
console.log("[db:bootstrap] contribution triggers applied");
process.exit(0);
