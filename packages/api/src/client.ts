// Type-only API client export for the SvelteKit web app.
// Re-exports the Hono RPC client type so the web app gets end-to-end type safety
// without importing the API server runtime.

export type { App } from "./app";
