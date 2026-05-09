import { defineConfig } from "vitest/config";

// Web package vitest config: only the framework-agnostic pure TS files
// in `src/lib/**` are exercised here. Component-level tests will land
// alongside the Phase 6 work when we wire up the Svelte component
// testing toolkit; the Sunday-batch happy-path Playwright spec is
// tracked separately in the Phase 5 follow-ups.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
    testTimeout: 5000,
  },
});
