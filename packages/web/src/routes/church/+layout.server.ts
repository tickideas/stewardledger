// packages/web/src/routes/church/+layout.server.ts
// Server-side gate for the chapter-scoped surface. Same shape as the zonal
// gate; differs only in which role bucket it asks `canAccessRoleAnyZone`
// about. A user with no bindings at all and no super-admin flag never
// reaches the church shell.

import { redirect } from "@sveltejs/kit";
import {
  authenticatedLandingPath,
  canAccessRoleAnyZone,
  landingInputFromServerSession,
} from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  const session = locals.session;
  if (!session) return {};

  if (!canAccessRoleAnyZone(session, "church")) {
    const input = landingInputFromServerSession(session, url.searchParams.get("zone"));
    redirect(303, authenticatedLandingPath(input));
  }

  return {};
};
