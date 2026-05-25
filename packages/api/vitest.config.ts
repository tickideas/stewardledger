// packages/api/vitest.config.ts
// Configures the API test runner for DB-backed integration tests.
// Keeps shared test database cleanup deterministic under Vitest upgrades.
// RELEVANT FILES: package.json, packages/api/package.json, docker-compose.yml, packages/db/drizzle.config.ts

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
    testTimeout: 10000,
  },
});
