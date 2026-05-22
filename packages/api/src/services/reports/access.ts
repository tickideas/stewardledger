// packages/api/src/services/reports/access.ts
// Phase 7 — role gating for the reports endpoints.
//
// Two tiers:
//   • READ — view the report on screen. All reader roles, zone-wide
//     and chapter-scoped.
//   • EXPORT — download the Excel/PDF artefact. Viewers (auditor /
//     pastor_viewer) can read on screen but cannot export raw PII per
//     REPORTS.md §1; finance + treasurer roles can export.
//
// Spec-level `accessCheck` adds row-level scope (e.g. member-statement
// only for members in the caller's chapters) — see types.ts.

import {
  CHAPTER_ROLES,
  ZONE_ROLES,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { visibleChapterIds } from "../../middleware/auth";


/** Zone-wide roles that may VIEW any report. */
export const REPORT_ZONE_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

/** Chapter-scoped roles that may VIEW reports filtered to their chapters. */
export const REPORT_CHAPTER_READ_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
  CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER,
] as const;

/** Zone-wide roles permitted to download exports (PII included). */
export const REPORT_ZONE_EXPORT_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
] as const;

/** Chapter-scoped roles permitted to download exports for their chapters. */
export const REPORT_CHAPTER_EXPORT_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
] as const;

function hasAny(ctx: AuthorizedContext, codes: readonly string[]): boolean {
  return ctx.roleCodes.some((c) => codes.includes(c));
}

export function hasZoneReportRead(ctx: AuthorizedContext): boolean {
  return hasAny(ctx, REPORT_ZONE_READ_ROLES);
}

export function hasChapterReportRead(ctx: AuthorizedContext): boolean {
  return hasAny(ctx, REPORT_CHAPTER_READ_ROLES);
}

export function hasZoneReportExport(ctx: AuthorizedContext): boolean {
  return hasAny(ctx, REPORT_ZONE_EXPORT_ROLES);
}

export function hasChapterReportExport(ctx: AuthorizedContext): boolean {
  return hasAny(ctx, REPORT_CHAPTER_EXPORT_ROLES);
}

export function canReadReports(ctx: AuthorizedContext): boolean {
  return hasZoneReportRead(ctx) || hasChapterReportRead(ctx);
}

export function canExportReports(ctx: AuthorizedContext): boolean {
  return hasZoneReportExport(ctx) || hasChapterReportExport(ctx);
}

/**
 * True when the caller holds at least one zone-wide role (any of the
 * `REPORT_ZONE_READ_ROLES`). Used by spec-level `accessCheck`
 * implementations to distinguish zone-wide readers (no chapter
 * clamp) from chapter-scoped readers (clamp to bound chapters).
 */
export function hasAnyZoneRole(ctx: AuthorizedContext): boolean {
  if (ctx.isPlatformAdmin) return true;
  const zoneCodes: readonly string[] = Object.values(ZONE_ROLES);
  return ctx.roleCodes.some((c) => zoneCodes.includes(c));
}

/**
 * Resolve the chapter-id scope for a reports caller using the standard
 * report read-role whitelist. Thin wrapper over `visibleChapterIds` so
 * report services don't need to import middleware directly.
 */
export async function reportVisibleScope(
  ctx: AuthorizedContext,
): Promise<{ kind: "all" } | { kind: "list"; ids: string[] }> {
  return visibleChapterIds(ctx, REPORT_ZONE_READ_ROLES);
}

/**
 * True when the caller is admin-tier (zone owner / admin / finance
 * admin). Used by reports whose READ contract is admin-only (e.g.
 * the audit log) — viewer roles (auditor / pastor_viewer) are denied
 * outright rather than served a redacted view.
 */
export function hasZoneAdminRole(ctx: AuthorizedContext): boolean {
  const codes: readonly string[] = REPORT_ZONE_EXPORT_ROLES;
  return ctx.roleCodes.some((c) => codes.includes(c));
}
