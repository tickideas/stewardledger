// packages/api/src/env.ts
// Environment loading. Reads `.env` at the repo root unless ENV_FILE overrides.

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = resolve(__dirname, "../../../.env");
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
  USESEND_API_KEY: optional("USESEND_API_KEY", ""),
  USESEND_API_URL: optional("USESEND_API_URL", ""),
};
