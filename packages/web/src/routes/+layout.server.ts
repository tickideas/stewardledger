// packages/web/src/routes/+layout.server.ts
// Universal auth gate. Runs on every page render (server-side) and enforces:
//   - protected paths require a session (else redirect to /login?next=…)
//   - super-admin-only paths require isSuperAdmin
//
// Surface-level gates (zonal/church/platform) live in their respective
// `+layout.server.ts` files so the rule reads next to the routes it guards.

import { redirect } from "@sveltejs/kit";
import {
  authenticatedLandingPath,
  isProtectedPath,
  isSafeInternalPath,
  isSuperAdminOnlyPath,
  landingInputFromServerSession,
} from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  const session = locals.session;
  const path = url.pathname;

  if (isProtectedPath(path) && !session) {
    const nextParam = isSafeInternalPath(path) ? `?next=${encodeURIComponent(path + url.search)}` : "";
    redirect(303, `/login${nextParam}`);
  }

  // Super-admin-only paths are also protected paths (verified by
  // `route-partitioning` tests), so by the time we reach here `session`
  // is guaranteed non-null — the unauthenticated branch above already
  // redirected anyone without a session. Narrow with `session && …` so
  // TS agrees, and bounce to *their* landing surface (a chapter-only
  // admin lands on /church/overview instead of /zone/chapters), keeping
  // their `?zone=` if they had one in the URL.
  if (session && isSuperAdminOnlyPath(path) && !session.isSuperAdmin) {
    const zoneFromQuery = url.searchParams.get("zone");
    redirect(
      303,
      authenticatedLandingPath(landingInputFromServerSession(session, zoneFromQuery)),
    );
  }

  // Ship the SSR-resolved session to the browser so the client store can
  // hydrate without a second `/api/public/session-zones` round-trip.
  // `null` is the wire signal for “anonymous / session lookup failed”.
  return { session };
};
