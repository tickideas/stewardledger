// packages/web/src/routes/zone/+layout.server.ts
// Server-side gate for the zonal surface. Bounces users who can't access
// the surface to their canonical landing BEFORE any HTML reaches the
// browser, so a chapter-only treasurer following an old /zone/* bookmark
// goes straight to /church/overview without flicker.

import { redirect } from "@sveltejs/kit";
import {
  authenticatedLandingPath,
  canAccessRoleAnyZone,
  landingInputFromServerSession,
} from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  // The root +layout.server.ts already enforced "must be authenticated" on
  // protected paths. If we get here without a session, something is wrong;
  // fall through to the client-side path which handles edge cases.
  const session = locals.session;
  if (!session) return {};

  if (!canAccessRoleAnyZone(session, "zonal")) {
    const next = url.searchParams.get("next");
    const input = landingInputFromServerSession(session, url.searchParams.get("zone"));
    redirect(303, authenticatedLandingPath(input, next));
  }

  return {};
};
