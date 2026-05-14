// packages/web/src/lib/audit/access.ts
// Phase 9 — role-aware predicate for the audit-search UI.
// Mirrors the server-side gate (`hasZoneAdminRole` in
// `packages/api/src/services/reports/access.ts`, which the audit-log
// report's spec-level `accessCheck` enforces). The /zone/audit page
// hits the same `/api/tenant/reports/audit-log/data` endpoint, so the
// client gate matches the server's READ contract verbatim.
// RELEVANT FILES: packages/web/src/routes/zone/audit/+page.svelte, packages/api/src/services/reports/access.ts, packages/api/src/services/reports/audit-log.ts

import type { AuthorizedContext } from "@stewardledger/shared";

/**
 * Admin tier — see REPORTS.md §2.13 ("admin-facing"). The audit
 * trail surfaces every actor's edits across the zone, so viewer
 * roles (zone_auditor / zone_pastor_viewer) and any chapter-scoped
 * role are denied. Platform admins pass through.
 */
const AUDIT_SEARCH_ROLES = new Set([
  "zone_owner",
  "zone_admin",
  "zone_finance_admin",
]);

export function canSearchAudit(auth: AuthorizedContext | null): boolean {
  if (!auth) return false;
  if (auth.isPlatformAdmin) return true;
  return auth.roleCodes.some((r) => AUDIT_SEARCH_ROLES.has(r));
}
