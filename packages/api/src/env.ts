// packages/api/src/env.ts
// Environment loading. Reads `.env` at the repo root unless ENV_FILE overrides.

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../");
const defaultEnvPath = resolve(repoRoot, ".env");
const envPath = process.env.ENV_FILE
  ? resolve(process.cwd(), process.env.ENV_FILE)
  : defaultEnvPath;

config({ path: envPath });

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  AUTH_SECRET: required("AUTH_SECRET"),
  PORT: parseInt(process.env.PORT || "3000", 10),
  NODE_ENV: optional("NODE_ENV", "development"),
  LOG_LEVEL: optional("LOG_LEVEL", "info"),
  PUBLIC_API_URL: optional("PUBLIC_API_URL", "http://localhost:3000"),
  PUBLIC_APP_URL: optional("PUBLIC_APP_URL", "http://localhost:5173"),
  PUBLIC_APP_DOMAIN: optional("PUBLIC_APP_DOMAIN", "localhost").toLowerCase(),
  PUBLIC_TENANT_DOMAIN: optional("PUBLIC_TENANT_DOMAIN", "localhost").toLowerCase(),
  // Optional. When set (e.g. `.example.com`), Better Auth issues session
  // cookies scoped to that parent domain so the SvelteKit web origin and
  // the API origin can share them across subdomains. Leave unset for
  // same-origin deployments (where the cookie is host-only on the shared
  // origin and just works). See docs/DEPLOYMENT.md "Cookie scope".
  AUTH_COOKIE_DOMAIN: optional("AUTH_COOKIE_DOMAIN", "").toLowerCase(),
  USESEND_API_KEY: optional("USESEND_API_KEY", ""),
  USESEND_API_URL: optional("USESEND_API_URL", ""),
  // Local filesystem root for the import-file object store. Replace with
  // S3 in production via the storage adapter in services/storage.ts.
  //
  // Anchored to the repo root so `pnpm --filter @stewardledger/api dev`
  // and `pnpm test` don't scatter `.stewardledger-storage/` folders
  // wherever the per-package cwd happens to be. Absolute STORAGE_ROOT
  // values pass through untouched.
  STORAGE_ROOT: resolve(repoRoot, optional("STORAGE_ROOT", ".stewardledger-storage")),
};
