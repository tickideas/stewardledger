// packages/web/src/lib/env.ts
// SvelteKit-side public runtime environment. Server-only secrets must NOT live here.

import { env } from "$env/dynamic/public";

export const PUBLIC_API_URL = env.PUBLIC_API_URL || "http://localhost:3000";
