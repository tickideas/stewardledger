// packages/web/src/lib/session-paths.ts
// Pure helpers for route classification + safe-redirect validation. No
// Svelte runes, no I/O — kept side-effect-free so it can be unit-tested
// directly and reused both server-side (in `+layout.server.ts`) and on the
// client (`session.svelte.ts`). Used by SSR redirects, the client session
// store, and the SSR → client `data.session` hydration path.
// RELEVANT FILES: ./session.svelte.ts, ../routes/+layout.server.ts, ../hooks.server.ts

/** Route prefixes that require an authenticated session. */
export const PROTECTED_PREFIXES = [
  "/admin",
  "/zone",
  "/church",
  "/account",
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

/**
 * localStorage key for the active chapter id (church-admin surface only).
 * A user with multiple chapter bindings within their active zone picks one
 * from the sidebar switcher; we persist it so the choice survives reloads.
 */
export const ACTIVE_CHAPTER_KEY = "stewardledger.activeChapterId";

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

/**
 * Landing path for a freshly-accepted platform-admin invitation.
 * Each role goes to a surface it can actually use — the previous
 * blanket redirect to `/admin/zones` left region_curator + billing_admin
 * invitees on a 403’d page.
 *
 * Note on `support_admin`: the API admits them to `/admin/zones`, but
 * the web session shape (`ServerSession`) does not yet carry
 * platform-role bindings, so `isSuperAdminOnlyPath("/admin/zones")` in
 * the root layout still bounces them. Until SSR knows about platform
 * roles, we land support_admin on `/account` where they have a session
 * but no admin nav. Follow-up: plumb `platformRoles: string[]` through
 * `/api/public/session-zones` and revisit this routing.
 */
export function platformInviteLandingPath(args: {
  roleCode: string;
  superAdmin: boolean;
}): string {
  if (args.superAdmin) return "/admin/zones";
  switch (args.roleCode) {
    case "region_curator":
      // Web layout already admits non-super-admins with any binding
      // to `/admin/regions`; safe to deep-link.
      return "/admin/regions";
    case "support_admin":
    case "billing_admin":
    default:
      // No admin surface they can reach without SSR plumbing for
      // platform roles. `/account` is the universal authenticated
      // landing page.
      return "/account";
  }
}

export function isSuperAdminOnlyPath(pathname: string): boolean {
  if (pathname === "/admin/zones" || pathname.startsWith("/admin/zones/")) return true;
  if (pathname === "/admin/administrators" || pathname.startsWith("/admin/administrators/"))
    return true;
  return false;
}

/**
 * The primary dashboard surface a session belongs to. Resolved from the
 * highest-scope role binding the user holds in their active zone, falling
 * back to platform for super-admins without a zone, and to `null` for users
 * with no usable bindings at all (rendered as the no_zone state upstream).
 *
 * Precedence: platform > zonal > church.
 */
export type PrimaryRole = "platform" | "zonal" | "church";

export type AuthenticatedLandingInput = {
  activeZoneSlug: string | null;
  isSuperAdmin: boolean;
  /**
   * Bindings within the currently-active zone. Optional so callers that
   * don't yet have role data (legacy tests, intermediate code paths) keep
   * working with the historical "any zone binding → zonal" behaviour.
   */
  activeZoneRoles?: string[];
  /**
   * Chapter role bindings within the currently-active zone. Used to detect
   * chapter-only admins so we can land them on /church instead of /zone.
   * `chapterName` is optional on this input because the routing helpers
   * don't need it; the sidebar switcher reads it from the session store.
   */
  activeZoneChapterRoles?: Array<{ chapterId: string; roleCode: string }>;
};

/**
 * Resolve the primary dashboard surface for a session. Used both for the
 * post-auth landing decision and (potentially) for any UI that wants to
 * know "which sidebar should this user see by default".
 */
export function primaryRole(s: AuthenticatedLandingInput): PrimaryRole | null {
  if (s.isSuperAdmin) return "platform";
  if (s.activeZoneRoles && s.activeZoneRoles.length > 0) return "zonal";
  if (s.activeZoneChapterRoles && s.activeZoneChapterRoles.length > 0) return "church";
  // Tenant-bound user with no resolved role data — fall back to zonal so
  // existing tenant-bound flows keep working until the API ships roles.
  if (s.activeZoneSlug) return "zonal";
  return null;
}

/**
 * View of the user's full multi-zone session as ferried from SSR to the
 * browser. Mirrors the `/api/public/session-zones` wire payload one-to-one
 * so the client session store can hydrate from `data.session` without a
 * second round-trip on cold page loads.
 *
 * Gate functions (`canAccessRoleAnyZone`, `landingInputFromServerSession`)
 * read only `isSuperAdmin` + the role arrays on each zone; the extra
 * `id`/`name`/`chapterName`/`user` fields are optional so tests can keep
 * supplying the minimal fixture shape.
 */
export type ServerSession = {
  isSuperAdmin: boolean;
  items: Array<{
    id?: string;
    slug: string;
    name?: string;
    zoneRoles: string[];
    chapterRoles: Array<{ chapterId: string; chapterName?: string; roleCode: string }>;
    /**
     * True when this zone enforces MFA for at least one of the
     * user's role codes. Treated by the UI as "redirect to
     * /account/security unless already enrolled".
     */
    mfaRequired?: boolean;
  }>;
  user?: {
    id: string;
    email: string;
    name: string | null;
    twoFactorEnabled?: boolean;
  } | null;
};

/**
 * Server-side variant of `canAccessRole` that considers **every** zone the
 * user belongs to (the SSR layer has no `localStorage`, hence no active
 * zone). A user passes the gate if ANY of their zones qualifies; the client
 * shell then refines based on the user's chosen active zone.
 *
 * This is the correct SSR rule: at the moment the server renders, we don't
 * yet know which zone the user will pick, so we err on "could plausibly use
 * this surface" and let the client redirect if the picked zone says no.
 */
export function canAccessRoleAnyZone(s: ServerSession, role: PrimaryRole): boolean {
  if (s.isSuperAdmin) return true;
  if (role === "platform") return false;
  if (role === "zonal") return s.items.some((z) => z.zoneRoles.length > 0);
  if (role === "church") {
    return s.items.some((z) => z.zoneRoles.length > 0 || z.chapterRoles.length > 0);
  }
  return false;
}

/**
 * Build an `AuthenticatedLandingInput` from a server session. Picks the
 * `?zone=` slug if present and known, else the first item. Lets the SSR
 * layer reuse `authenticatedLandingPath` to compute the redirect target
 * without duplicating the routing rule.
 */
export function landingInputFromServerSession(
  s: ServerSession,
  zoneFromQuery: string | null,
): AuthenticatedLandingInput {
  const picked = (zoneFromQuery && s.items.find((z) => z.slug === zoneFromQuery)) || s.items[0] || null;
  return {
    activeZoneSlug: picked?.slug ?? null,
    isSuperAdmin: s.isSuperAdmin,
    activeZoneRoles: picked?.zoneRoles ?? [],
    activeZoneChapterRoles: picked?.chapterRoles ?? [],
  };
}

/**
 * True iff the session is allowed to render the given dashboard surface.
 *
 *  - `platform`   only super-admins
 *  - `zonal`      super-admins OR users with any zone-scope role
 *  - `church`     super-admins OR users with ANY tenant binding
 *                 (zone admins routinely drill into a chapter view)
 *
 * Surfaces the user is NOT allowed to enter trigger a same-tab redirect to
 * their `authenticatedLandingPath` in the shell layout's effect.
 */
export function canAccessRole(s: AuthenticatedLandingInput, role: PrimaryRole): boolean {
  if (s.isSuperAdmin) return true;
  const hasZoneRoles = (s.activeZoneRoles?.length ?? 0) > 0;
  const hasChapterRoles = (s.activeZoneChapterRoles?.length ?? 0) > 0;
  // Without explicit role data we degrade to "any tenant binding" — lets
  // existing zone-bound flows keep working until every code path is wired.
  // Detect this by `activeZoneRoles === undefined`: the caller never supplied
  // role data, so we can't tell zonal apart from chapter-only and we err
  // permissive for both surfaces.
  const hasLegacyTenantBinding =
    s.activeZoneSlug !== null && s.activeZoneRoles === undefined;
  switch (role) {
    case "platform":
      return false; // only super-admins reach /admin/*
    case "zonal":
      return hasZoneRoles || hasLegacyTenantBinding;
    case "church":
      return hasZoneRoles || hasChapterRoles || hasLegacyTenantBinding;
  }
}

/**
 * Canonical post-auth landing rule. Platform super-admins land on the
 * platform surface; zone-scoped admins land on the zonal dashboard;
 * chapter-only admins land on the church dashboard; signed-in users with no
 * usable binding land on the no-zone login banner. A safe `next` overrides
 * the default *within* the surface the user is allowed to reach.
 */
export function authenticatedLandingPath(
  session: AuthenticatedLandingInput,
  next?: string | null,
): string {
  // Platform-only super-admins: tenant routes cannot work for them.
  if (session.isSuperAdmin && !session.activeZoneSlug) {
    if (next && isSafeInternalPath(next) && isSuperAdminOnlyPath(next)) return next;
    return "/admin/zones";
  }

  if (next && isSafeInternalPath(next) && isProtectedPath(next)) return next;

  const role = primaryRole(session);
  if (role === "platform") return "/admin/zones";
  if (role === null) return "/login?error=no_zone";

  const zoneQs = session.activeZoneSlug
    ? `?zone=${encodeURIComponent(session.activeZoneSlug)}`
    : "";
  if (role === "church") return `/church/overview${zoneQs}`;
  // Default: zonal. Covers explicit zone bindings AND the legacy
  // "tenant-bound but no role data yet" path.
  return `/zone/chapters${zoneQs}`;
}
