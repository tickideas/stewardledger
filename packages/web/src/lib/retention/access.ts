// packages/web/src/lib/retention/access.ts
// Phase 9 — role-aware predicates for the retention-policy panel.
// Mirrors the server-side gates in `packages/api/src/routes/tenant-zones.ts`:
//   - READ: any of zone_owner / zone_admin / zone_finance_admin / zone_auditor.
//   - WRITE: zone_owner only (retention sits at MFA-enforcement gravity).
// RELEVANT FILES: packages/web/src/routes/zone/settings/+page.svelte, packages/api/src/routes/tenant-zones.ts

import type { AuthorizedContext } from "@stewardledger/shared";

const READ_ROLES = new Set([
  "zone_owner",
  "zone_admin",
  "zone_finance_admin",
  "zone_auditor",
]);

export function canReadRetention(auth: AuthorizedContext | null): boolean {
  if (!auth) return false;
  return auth.roleCodes.some((r) => READ_ROLES.has(r));
}

export function canEditRetention(auth: AuthorizedContext | null): boolean {
  if (!auth) return false;
  return auth.roleCodes.includes("zone_owner");
}
