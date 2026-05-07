// packages/web/src/lib/env.ts
// SvelteKit-side environment. Vite exposes anything starting with `VITE_`.
// Server-only secrets must NOT live here \u2014 add them to $env/static/private.

export const PUBLIC_API_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) ||
  "http://localhost:3000";
