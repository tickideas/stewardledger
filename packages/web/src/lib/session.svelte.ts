// packages/web/src/lib/session.svelte.ts
// Client-side session store. `hooks.server.ts` already fetches the user's
// zones during SSR (subject to `AUTH_COOKIE_DOMAIN` scoping the Better
// Auth cookie to both origins — see ARCHITECTURE.md §12 and
// DEPLOYMENT.md “Cookie scope”) and the root layout seeds this store via
// `hydrateSession()`. `loadSession({ force })` is reserved for post-
// mutation refreshes (login, account page, zone switch).
// RELEVANT FILES: ./session-paths.ts, ../hooks.server.ts, ../routes/+layout.svelte

import { setActiveChapter } from "$lib/active-chapter.svelte";
import { PUBLIC_API_URL } from "$lib/env";
import {
  ACTIVE_CHAPTER_KEY,
  ACTIVE_ZONE_KEY,
  type ServerSession,
} from "$lib/session-paths";

/**
 * A zone the user is bound to, with the role bindings that apply within it.
 *  - `zoneRoles`  — zone-scope codes (zone_admin, zone_owner, ...)
 *  - `chapterRoles` — chapter-scope codes paired with the chapter they bind to
 *
 * Both arrays may be empty for super-admins, who reach every zone without a
 * binding.
 */
export type ChapterRole = { chapterId: string; chapterName: string; roleCode: string };
export type Zone = {
  id: string;
  slug: string;
  name: string;
  zoneRoles: string[];
  chapterRoles: ChapterRole[];
};

/** Identity surfaced to the UI (sidebar profile menu, etc.). */
export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  /**
   * Mirrors `user.two_factor_enabled` on the API. Used by the
   * Security page (`/account/security`) to render the correct
   * enrolled / unenrolled state without re-reading the user row.
   * Defaults to `false` against older API builds that pre-date
   * the field — same transitional shim as `name`.
   */
  twoFactorEnabled: boolean;
};

/**
 * Session state machine. Only `authenticated` carries `isSuperAdmin`; all
 * other states are by definition not super-admins, so the field would be
 * meaningless noise on them.
 *
 *   loading         — first render, before /api/public/session-zones resolves
 *   anonymous       — no Better Auth session (401)
 *   no_zone         — signed in but no zone bindings; account exists but is
 *                     not yet usable. Distinct from anonymous so the UI can
 *                     surface a clear message instead of silently bouncing
 *                     to /login.
 *   authenticated   — signed in; may have zero zones if super-admin.
 *   error           — transient network/parse failure; do NOT redirect to
 *                     /login because the user may still be signed in
 */
export type SessionState =
  | { status: "loading"; zones: never[]; activeZoneSlug: null }
  | { status: "anonymous"; zones: never[]; activeZoneSlug: null }
  | { status: "no_zone"; zones: never[]; activeZoneSlug: null; user: SessionUser | null }
  | {
      status: "authenticated";
      zones: Zone[];
      activeZoneSlug: string | null;
      isSuperAdmin: boolean;
      user: SessionUser;
    }
  | { status: "error"; zones: never[]; activeZoneSlug: null; reason: string };

/** True iff the current session is authenticated AND a platform super-admin. */
export function isSuperAdmin(state: SessionState): boolean {
  return state.status === "authenticated" && state.isSuperAdmin;
}

/**
 * Adapt the authenticated session into the shape the pure routing helpers
 * (`canAccessRole`, `primaryRole`, `authenticatedLandingPath`) consume. Pulls
 * the role bindings from the user's *active* zone — there's exactly one of
 * those at a time, and that's the zone any role decision is scoped to.
 *
 * Returns `null` for unauthenticated / loading / no-zone / error states so
 * callers can short-circuit without re-checking the union.
 */
export function landingInputFor(state: SessionState):
  | {
      activeZoneSlug: string | null;
      isSuperAdmin: boolean;
      activeZoneRoles: string[];
      activeZoneChapterRoles: Array<{ chapterId: string; roleCode: string }>;
    }
  | null {
  if (state.status !== "authenticated") return null;
  const zone = state.zones.find((z) => z.slug === state.activeZoneSlug);
  return {
    activeZoneSlug: state.activeZoneSlug,
    isSuperAdmin: state.isSuperAdmin,
    activeZoneRoles: zone?.zoneRoles ?? [],
    activeZoneChapterRoles:
      zone?.chapterRoles.map((r) => ({ chapterId: r.chapterId, roleCode: r.roleCode })) ?? [],
  };
}

export const session = $state<{ current: SessionState }>({
  current: { status: "loading", zones: [], activeZoneSlug: null },
});

/**
 * Synchronously seed the session store from an SSR-resolved snapshot. This
 * is the cold-path companion to `loadSession()`: `hooks.server.ts` already
 * hit `/api/public/session-zones` to populate `event.locals.session`, and
 * `+layout.server.ts` forwards that to the browser as `data.session`. Calling
 * `hydrateSession(data.session)` from the root layout lets the store skip
 * the duplicate client-side fetch so the first paint is already
 * `authenticated` (or `anonymous`) instead of `loading`.
 *
 * Subsequent refresh paths (post-sign-in, post-zone-switch, profile update)
 * still go through `loadSession({ force: true })` because they need a fresh
 * server read.
 */
export function hydrateSession(snapshot: ServerSession | null): void {
  // Invalidate any concurrent loadSession() so its eventual response can't
  // overwrite the hydrated state with stale data from a slower request.
  sessionEpoch++;
  inflight = null;

  if (!snapshot) {
    session.current = { status: "anonymous", zones: [], activeZoneSlug: null };
    return;
  }

  const isSuperAdminFlag = snapshot.isSuperAdmin === true;
  // Mirror the `loadSession()` shim: render a placeholder identity when the
  // API build pre-dates the `user` field rather than blanking the profile.
  const user: SessionUser = snapshot.user
    ? {
        id: snapshot.user.id,
        email: snapshot.user.email,
        name: snapshot.user.name,
        twoFactorEnabled: snapshot.user.twoFactorEnabled === true,
      }
    : { id: "", email: "", name: null, twoFactorEnabled: false };

  const items: Zone[] = snapshot.items.map((z) => ({
    id: z.id ?? "",
    slug: z.slug,
    name: z.name ?? z.slug,
    zoneRoles: z.zoneRoles ?? [],
    chapterRoles: (z.chapterRoles ?? []).map((r) => ({
      chapterId: r.chapterId,
      chapterName: r.chapterName ?? "",
      roleCode: r.roleCode,
    })),
  }));

  if (items.length === 0) {
    if (isSuperAdminFlag) {
      session.current = {
        status: "authenticated",
        zones: [],
        activeZoneSlug: null,
        isSuperAdmin: true,
        user,
      };
      return;
    }
    session.current = { status: "no_zone", zones: [], activeZoneSlug: null, user };
    return;
  }

  const stored =
    typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_ZONE_KEY) : null;
  const fallback = items[0]?.slug ?? null;
  const activeZoneSlug = stored && items.some((z) => z.slug === stored) ? stored : fallback;
  session.current = {
    status: "authenticated",
    zones: items,
    activeZoneSlug,
    isSuperAdmin: isSuperAdminFlag,
    user,
  };
}

let inflight: Promise<void> | null = null;
// Bumped by `signOut()` (and anything else that invalidates a session) so a
// stale in-flight `loadSession()` response cannot overwrite the new state.
let sessionEpoch = 0;

/**
 * Resolve the current session by calling `/api/public/session-zones`. The
 * endpoint returns 401 when no Better Auth session cookie is present, and
 * 200 with the caller's zones otherwise. Coalesces concurrent calls.
 */
export function loadSession(opts: { force?: boolean } = {}): Promise<void> {
  if (opts.force) {
    sessionEpoch++;
    inflight = null;
  } else if (inflight) {
    return inflight;
  }
  const epoch = sessionEpoch;
  inflight = (async () => {
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/public/session-zones`, {
        credentials: "include",
      });
      if (epoch !== sessionEpoch) return; // superseded by sign-out

      if (res.status === 401) {
        session.current = { status: "anonymous", zones: [], activeZoneSlug: null };
        return;
      }
      if (!res.ok) {
        const reason = `session-zones returned ${res.status}`;
        console.warn(`[session] ${reason}`);
        session.current = { status: "error", zones: [], activeZoneSlug: null, reason };
        return;
      }

      type WireZone = {
        id: string;
        slug: string;
        name: string;
        zoneRoles?: string[];
        chapterRoles?: Array<{
          chapterId: string;
          chapterName?: string;
          roleCode: string;
        }>;
      };
      const body = (await res.json()) as {
        items: WireZone[];
        isSuperAdmin?: boolean;
        user?: {
          id: string;
          email: string;
          name: string | null;
          twoFactorEnabled?: boolean;
        };
      };
      if (epoch !== sessionEpoch) return; // superseded between fetch + parse
      const isSuperAdminFlag = body.isSuperAdmin === true;
      // The endpoint always returns a `user` when the request is authenticated.
      // The empty-string fallback is a transitional shim for the brief window
      // where the web build can be ahead of the deployed API: rather than
      // blank the whole UI, we render "Account" placeholders in the profile
      // menu and let the next session refresh fix it. Remove once every
      // environment runs an API build that ships `user` in the response.
      const user: SessionUser = body.user
        ? {
            id: body.user.id,
            email: body.user.email,
            name: body.user.name,
            twoFactorEnabled: body.user.twoFactorEnabled === true,
          }
        : { id: "", email: "", name: null, twoFactorEnabled: false };
      // Normalise the wire shape into the Zone type — missing role arrays on
      // an older API build degrade to "no bindings known" rather than crashing.
      const items: Zone[] = body.items.map((z) => ({
        id: z.id,
        slug: z.slug,
        name: z.name,
        zoneRoles: z.zoneRoles ?? [],
        chapterRoles: (z.chapterRoles ?? []).map((r) => ({
          chapterId: r.chapterId,
          chapterName: r.chapterName ?? "",
          roleCode: r.roleCode,
        })),
      }));

      if (items.length === 0) {
        // Super-admins may legitimately have zero zone bindings (platform-only
        // users). Treat them as authenticated so /admin is reachable.
        if (isSuperAdminFlag) {
          session.current = {
            status: "authenticated",
            zones: [],
            activeZoneSlug: null,
            isSuperAdmin: true,
            user,
          };
          return;
        }
        // Authenticated but bound to no zone — surface explicitly instead of
        // showing protected nav links that will fail every API call.
        session.current = { status: "no_zone", zones: [], activeZoneSlug: null, user };
        return;
      }

      const stored =
        typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_ZONE_KEY) : null;
      const fallback = items[0]?.slug ?? null;
      const activeZoneSlug =
        stored && items.some((z) => z.slug === stored) ? stored : fallback;
      session.current = {
        status: "authenticated",
        zones: items,
        activeZoneSlug,
        isSuperAdmin: isSuperAdminFlag,
        user,
      };
    } catch (err) {
      if (epoch !== sessionEpoch) return;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("[session] loadSession failed:", reason);
      session.current = { status: "error", zones: [], activeZoneSlug: null, reason };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Sign the user out via Better Auth and clear local state. */
export async function signOut(): Promise<void> {
  // Invalidate any in-flight loadSession() so its response cannot resurrect
  // the signed-out state. Bump *before* the network call so even an already
  // queued response is ignored on arrival.
  sessionEpoch++;
  inflight = null;
  // Flip local state immediately so the navbar updates without waiting on
  // the round-trip. The server-side cookie clear below is best-effort.
  // The chapter rune is cleared through `setActiveChapter`, which handles
  // its own localStorage write — forgetting the rune leaves the next
  // sign-in briefly pointing at the previous user's chapter id, which
  // then resolves to null against the new user's bindings (one-tick flicker).
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(ACTIVE_ZONE_KEY);
  }
  setActiveChapter(null);
  session.current = { status: "anonymous", zones: [], activeZoneSlug: null };

  try {
    // Better Auth requires `Content-Type: application/json` (else 415) AND
    // a JSON body (else 500), even though sign-out takes no parameters.
    // Without this the server never clears the session cookie and the next
    // `loadSession()` happily re-authenticates the user on refresh.
    await fetch(`${PUBLIC_API_URL}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    console.warn(
      "[session] sign-out POST failed (local state already cleared):",
      err instanceof Error ? err.message : err,
    );
  }
}

export {
  authenticatedLandingPath,
  canAccessRole,
  isProtectedPath,
  isSafeInternalPath,
  isSuperAdminOnlyPath,
  primaryRole,
  ACTIVE_CHAPTER_KEY,
  ACTIVE_ZONE_KEY,
} from "$lib/session-paths";
