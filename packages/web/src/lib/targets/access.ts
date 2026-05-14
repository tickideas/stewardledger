// packages/web/src/lib/targets/access.ts
// Phase 8 — role-aware write predicate for the financial-targets UI.
// Mirrors the server-side route gate (`packages/api/src/routes/
// tenant-targets.ts`) so the buttons we render match the 403/200
// the server will return.
// RELEVANT FILES: packages/web/src/routes/zone/targets/+page.svelte, packages/api/src/routes/tenant-targets.ts

import type { AuthorizedContext } from "@stewardledger/shared";

const ZONE_WRITE_ROLES = new Set([
  "zone_owner",
  "zone_admin",
  "zone_finance_admin",
]);
const CHAPTER_WRITE_ROLES = new Set(["chapter_admin"]);

export function hasZoneWriteTargets(auth: AuthorizedContext | null): boolean {
  if (!auth) return false;
  if (auth.isPlatformAdmin) return true;
  return auth.roleCodes.some((r) => ZONE_WRITE_ROLES.has(r));
}

/**
 * True when `auth` holds chapter-admin AND has at least one chapter
 * binding. A chapter_admin role assignment without any bindings is a
 * data-integrity edge case (and the server-side route rejects writes
 * for it), so the UI must not surface a "new target" button for it.
 */
export function hasChapterWriteTargets(
  auth: AuthorizedContext | null,
): boolean {
  if (!auth) return false;
  if (!auth.roleCodes.some((r) => CHAPTER_WRITE_ROLES.has(r))) return false;
  return (auth.chapterIds ?? []).length > 0;
}

/**
 * Can `auth` write a financial target for `chapterId`?
 *
 *   • `chapterId === null` represents a zone-wide target. Only zone-write
 *     roles can write those; chapter-admin cannot.
 *   • A chapter-scoped target requires zone-write OR chapter-admin
 *     on the bound chapter.
 *
 * Mirrors the route's `canWriteTarget` logic exactly.
 */
export function canWriteFinancialTarget(
  auth: AuthorizedContext | null,
  chapterId: string | null,
): boolean {
  if (hasZoneWriteTargets(auth)) return true;
  // Zone-wide targets are zone-policy; chapter-admin can't write them.
  if (chapterId === null) return false;
  if (!hasChapterWriteTargets(auth)) return false;
  return (auth?.chapterIds ?? []).includes(chapterId);
}
