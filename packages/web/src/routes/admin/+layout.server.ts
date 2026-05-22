// packages/web/src/routes/admin/+layout.server.ts
// Server-side gate for the platform-admin surface. Delegates the
// per-path admission rule to `canEnterAdminPath` in $lib/session-paths
// so the client-side guard and the SSR guard stay in sync.
//
// RELEVANT FILES: packages/web/src/lib/session-paths.ts, packages/api/src/routes/admin.ts, packages/api/src/routes/admin-administrators.ts

import { redirect } from "@sveltejs/kit";
import {
  authenticatedLandingPath,
  canEnterAdminPath,
  landingInputFromServerSession,
} from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  const session = locals.session;
  if (!session) return {};
  const hasZoneBinding = session.items.some(
    (z) => z.zoneRoles.length > 0 || z.chapterRoles.length > 0,
  );
  const allowed = canEnterAdminPath({
    pathname: url.pathname,
    isSuperAdmin: session.isSuperAdmin,
    platformRoles: session.platformRoles ?? [],
    hasZoneBinding,
  });
  if (allowed) return {};

  // Not admitted — bounce to the user's real landing surface,
  // preserving any `?zone=` they had in the URL.
  const input = landingInputFromServerSession(session, url.searchParams.get("zone"));
  redirect(303, authenticatedLandingPath(input));
};
