// packages/web/src/routes/admin/+layout.server.ts
// Server-side gate for the platform-admin surface. Distinct from the zonal
// and church gates because /admin has a nuanced rule: super-admins reach
// everything, but plain authenticated users with a tenant binding can also
// see /admin/regions (region-curator inbox) without being super-admins.
//
// We enforce that nuance here so a bookmark to /admin/zones flips to a
// safer landing for non-super-admins before any HTML ships. Per-path
// `isSuperAdminOnlyPath` is already enforced in the root server layout;
// this guard just keeps unbound users out of /admin entirely.

import { redirect } from "@sveltejs/kit";
import { authenticatedLandingPath, landingInputFromServerSession } from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  const session = locals.session;
  if (!session) return {};

  // Super-admins always pass.
  if (session.isSuperAdmin) return {};

  // Non-super-admins admitted to `/admin/*` if they hold either:
  //   - any zone or chapter binding (existing region-curator inbox use case), OR
  //   - a platform role that has an admin surface to use today.
  //
  // `billing_admin` is deliberately excluded — subscriptions ship in
  // Phase 10 and they have no `/admin/*` page to land on. Letting them
  // in would expose nav links that 403 on every API call. They land
  // on /account via the post-accept routing instead.
  const hasZoneBinding = session.items.some(
    (z) => z.zoneRoles.length > 0 || z.chapterRoles.length > 0,
  );
  const ADMIN_SURFACE_PLATFORM_ROLES = new Set([
    "support_admin",
    "region_curator",
  ]);
  const hasAdminSurfaceRole = (session.platformRoles ?? []).some((r) =>
    ADMIN_SURFACE_PLATFORM_ROLES.has(r),
  );
  if (hasZoneBinding || hasAdminSurfaceRole) return {};

  // Unbound, non-super-admin. They have no business under /admin.
  const input = landingInputFromServerSession(session, url.searchParams.get("zone"));
  redirect(303, authenticatedLandingPath(input));
};
