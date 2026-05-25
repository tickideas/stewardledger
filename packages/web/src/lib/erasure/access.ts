// packages/web/src/lib/erasure/access.ts
// Phase 9 §6 — role-aware predicates for the GDPR erasure UI.
// Mirrors the server-side gates in
// `packages/api/src/routes/tenant-erasure.ts`:
//
//   - MEMBER scope (schedule / cancel / list): owner / admin /
//     finance_admin (PII control).
//   - ZONE scope (schedule / cancel): zone_owner only — highest-
//     blast-radius single action in the product.
//
// READ for member-scope rows is the same gate as create + cancel:
// the audit row + the cancel handle are PII-adjacent.
//
// Like the retention + export predicates, this is a PURE role-code
// check. It does NOT honour `isPlatformAdmin` — a platform admin
// without an explicit tenant binding cannot drive these flows
// through the tenant API; surfacing the UI as authorised and then
// 403-ing the request would be worse than a clean "no access".
//
// RELEVANT FILES: packages/api/src/routes/tenant-erasure.ts,
//                 packages/web/src/routes/zone/members/[id]/+page.svelte,
//                 packages/web/src/routes/zone/settings/+page.svelte

import type { AuthorizedContext } from "@stewardledger/shared";

const MEMBER_SCOPE_ROLES = new Set([
  "zone_owner",
  "zone_admin",
  "zone_finance_admin",
]);

/**
 * True if the caller can schedule, see, or cancel a member-level
 * erasure request. Owner / admin / finance_admin (the PII tier).
 */
export function canManageMemberErasure(
  auth: AuthorizedContext | null,
): boolean {
  if (!auth) return false;
  return auth.roleCodes.some((r) => MEMBER_SCOPE_ROLES.has(r));
}

/**
 * True if the caller can schedule or cancel a zone-level erasure.
 * `zone_owner` only — same gravity as the export bundle gate.
 */
export function canManageZoneErasure(
  auth: AuthorizedContext | null,
): boolean {
  if (!auth) return false;
  return auth.roleCodes.includes("zone_owner");
}
