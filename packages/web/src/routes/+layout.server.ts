// packages/web/src/routes/+layout.server.ts
// Universal auth gate. Runs on every page render (server-side) and enforces:
//   - protected paths require a session (else redirect to /login?next=…)
//   - super-admin-only paths require isSuperAdmin
//
// Surface-level gates (zonal/church/platform) live in their respective
// `+layout.server.ts` files so the rule reads next to the routes it guards.

import { redirect } from "@sveltejs/kit";
import { isProtectedPath, isSafeInternalPath, isSuperAdminOnlyPath } from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  const session = locals.session;
  const path = url.pathname;

  if (isProtectedPath(path) && !session) {
    const nextParam = isSafeInternalPath(path) ? `?next=${encodeURIComponent(path + url.search)}` : "";
    redirect(303, `/login${nextParam}`);
  }

  if (isSuperAdminOnlyPath(path) && !session?.isSuperAdmin) {
    // Already authenticated (path is also protected → guarded above); just
    // not a super-admin. Bounce to a safe surface they DO have access to.
    redirect(303, "/zone/chapters");
  }

  // Ship the SSR-resolved session to the browser so the client store can
  // hydrate without a second `/api/public/session-zones` round-trip.
  // `null` is the wire signal for “anonymous / session lookup failed”.
  return { session };
};
