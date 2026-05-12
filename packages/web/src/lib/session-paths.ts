// packages/web/src/lib/session-paths.ts
// Pure helpers for route classification + safe-redirect validation. No Svelte
// runes, no I/O — kept side-effect-free so it can be unit-tested directly and
// (eventually) reused server-side once a same-origin proxy or shared cookie
// domain lets us gate routes in `hooks.server.ts`.

/** Route prefixes that require an authenticated session. */
export const PROTECTED_PREFIXES = [
  "/members",
  "/contributions",
  "/imports",
  "/reports",
  "/admin",
  "/onboarding",
] as const;

/**
 * Route prefixes that are reachable without a session. `"/"` is the home
 * page; every other entry is a top-level directory under `src/routes/`.
 * The `route-partitioning` test asserts every directory in `src/routes/` is
 * classified here or in `PROTECTED_PREFIXES`.
 */
export const PUBLIC_PREFIXES = [
  "/",
  "/login",
  "/invite",
  "/healthz",
] as const;

/** localStorage key for the active zone slug. Single source of truth. */
export const ACTIVE_ZONE_KEY = "stewardledger.activeZoneSlug";

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Whether a string is safe to use as a same-origin redirect target.
 *
 * Rejects:
 *   - empty / non-slash starts (`""`, `"members"`)
 *   - protocol-relative URLs (`//evil.com`, which browsers treat as absolute)
 *   - backslash tricks (`/\evil.com`, which some parsers normalize to `//`)
 *   - absolute URLs (`http://…`, `https://…`)
 *
 * Use together with `isProtectedPath` when honouring a user-supplied `?next=`
 * to ensure we only redirect to known internal routes.
 */
export function isSafeInternalPath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;
  if (p.startsWith("/\\")) return false;
  return true;
}

export function isSuperAdminOnlyPath(pathname: string): boolean {
  return pathname === "/admin/zones" || pathname.startsWith("/admin/zones/");
}

export type AuthenticatedLandingInput = {
  activeZoneSlug: string | null;
  isSuperAdmin: boolean;
};

/**
 * Canonical post-auth landing rule. Platform-only super-admins have no tenant
 * context, so tenant routes such as /members cannot work for them.
 */
export function authenticatedLandingPath(
  session: AuthenticatedLandingInput,
  next?: string | null,
): string {
  if (session.isSuperAdmin && !session.activeZoneSlug) {
    if (next && isSafeInternalPath(next) && isSuperAdminOnlyPath(next)) return next;
    return "/admin/zones";
  }

  if (next && isSafeInternalPath(next) && isProtectedPath(next)) return next;

  if (session.activeZoneSlug) {
    return `/members?zone=${encodeURIComponent(session.activeZoneSlug)}`;
  }
  return "/members";
}
