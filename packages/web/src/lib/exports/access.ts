// packages/web/src/lib/exports/access.ts
// Phase 9 §3 — owner-only predicate for the zone export bundle.
// Mirrors the server-side gate (`hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)`
// in `packages/api/src/routes/tenant-exports.ts`). The export bundle is
// the highest-blast-radius single action in the product, so even
// `zone_admin` is denied — only the owner can request, list, or
// download a full-zone dump.
// RELEVANT FILES: packages/api/src/routes/tenant-exports.ts, packages/web/src/routes/zone/settings/+page.svelte

import type { AuthorizedContext } from "@stewardledger/shared";

/**
 * Pure role-code check matching the server gate. Does NOT honour
 * `isPlatformAdmin` — a platform admin without an explicit
 * `zone_owner` binding cannot pull a tenant's export. Granting it
 * client-side would surface the UI as authorised and then 403 the
 * request.
 */
export function canRequestExport(auth: AuthorizedContext | null): boolean {
  if (!auth) return false;
  return auth.roleCodes.includes("zone_owner");
}
