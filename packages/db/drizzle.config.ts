import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "drizzle-kit";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = resolve(__dirname, "../../.env");
const envPath = process.env.ENV_FILE
  ? resolve(process.cwd(), process.env.ENV_FILE)
  : defaultEnvPath;

// Local dev: `.env` at the repo root supplies DATABASE_URL.
// Tests: `ENV_FILE=.env.test` overrides above.
// Production (Dokploy): the `.env` file is absent inside the container;
// dotenv silently no-ops and DATABASE_URL is supplied by the orchestrator.
config({ path: envPath });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
