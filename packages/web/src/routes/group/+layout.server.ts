// packages/web/src/routes/group/+layout.server.ts
// Server-side gate for the group-tier surface. Bounces users who can't
// access the surface, and derives bound group(s) from the session payload
// so the sidebar can render a group switcher when >1 binding exists.

import { redirect } from "@sveltejs/kit";
import {
  authenticatedLandingPath,
  canAccessRoleAnyZone,
  landingInputFromServerSession,
} from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  const session = locals.session;
  if (!session) return { boundGroups: [], boundGroup: null };

  if (!canAccessRoleAnyZone(session, "group")) {
    const next = url.searchParams.get("next");
    const input = landingInputFromServerSession(session, url.searchParams.get("zone"));
    redirect(303, authenticatedLandingPath(input, next));
  }

  const zoneSlug =
    url.searchParams.get("zone") ??
    session.items.find((z) => (z.groupRoles ?? []).length > 0 || z.zoneRoles.length > 0)?.slug ??
    null;
  const zoneItem = session.items.find((z) => z.slug === zoneSlug) ?? null;

  const seen = new Set<string>();
  const boundGroups: Array<{ id: string; name: string }> = [];
  for (const binding of zoneItem?.groupRoles ?? []) {
    if (seen.has(binding.groupId)) continue;
    seen.add(binding.groupId);
    boundGroups.push({
      id: binding.groupId,
      name: binding.groupName ?? "Group",
    });
  }

  return {
    boundGroups,
    boundGroup: boundGroups[0] ?? null,
  };
};
