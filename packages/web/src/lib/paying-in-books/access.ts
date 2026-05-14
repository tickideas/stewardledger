// packages/web/src/lib/paying-in-books/access.ts
// Phase 8 — role-aware write predicate for the paying-in-books UI.
// Mirrors the server-side route gate (`packages/api/src/routes/
// tenant-paying-in-books.ts`) so the buttons we render match the
// 403/200 the server will return.
// RELEVANT FILES: packages/web/src/routes/zone/paying-in-books/+page.svelte, packages/api/src/routes/tenant-paying-in-books.ts

import type { AuthorizedContext } from "@stewardledger/shared";

const ZONE_WRITE_ROLES = new Set([
  "zone_owner",
  "zone_admin",
  "zone_finance_admin",
]);
const CHAPTER_WRITE_ROLES = new Set(["chapter_admin"]);

export function hasZoneWritePayingInBooks(
  auth: AuthorizedContext | null,
): boolean {
  if (!auth) return false;
  if (auth.isPlatformAdmin) return true;
  return auth.roleCodes.some((r) => ZONE_WRITE_ROLES.has(r));
}

export function hasChapterWritePayingInBooks(
  auth: AuthorizedContext | null,
): boolean {
  if (!auth) return false;
  return auth.roleCodes.some((r) => CHAPTER_WRITE_ROLES.has(r));
}

/**
 * Can `auth` write a paying-in book on `chapterId`?
 *
 * Mirrors the route's `canWriteBook` logic:
 *   • zone-write roles (or platform admin) can write any chapter's book.
 *   • chapter-admin can write a book only when their bindings include
 *     the chapter.
 *   • Everyone else (chapter treasurer, viewer roles, no auth) → false.
 */
export function canWritePayingInBook(
  auth: AuthorizedContext | null,
  chapterId: string,
): boolean {
  if (hasZoneWritePayingInBooks(auth)) return true;
  if (!hasChapterWritePayingInBooks(auth)) return false;
  return (auth?.chapterIds ?? []).includes(chapterId);
}
