// packages/web/src/lib/session.svelte.ts
// Client-side session store. The API lives on a different origin
// (host-only cookies per ARCHITECTURE.md §12) so SvelteKit SSR cannot
// read the session cookie — gating happens in the browser.

import { PUBLIC_API_URL } from "$lib/env";
import { ACTIVE_ZONE_KEY } from "$lib/session-paths";

export type Zone = { id: string; slug: string; name: string };

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
  | { status: "no_zone"; zones: never[]; activeZoneSlug: null }
  | {
      status: "authenticated";
      zones: Zone[];
      activeZoneSlug: string | null;
      isSuperAdmin: boolean;
    }
  | { status: "error"; zones: never[]; activeZoneSlug: null; reason: string };

/** True iff the current session is authenticated AND a platform super-admin. */
export function isSuperAdmin(state: SessionState): boolean {
  return state.status === "authenticated" && state.isSuperAdmin;
}

export const session = $state<{ current: SessionState }>({
  current: { status: "loading", zones: [], activeZoneSlug: null },
});

let inflight: Promise<void> | null = null;
// Bumped by `signOut()` (and anything else that invalidates a session) so a
// stale in-flight `loadSession()` response cannot overwrite the new state.
let sessionEpoch = 0;

/**
 * Resolve the current session by calling `/api/public/session-zones`. The
 * endpoint returns 401 when no Better Auth session cookie is present, and
 * 200 with the caller's zones otherwise. Coalesces concurrent calls.
 */
export function loadSession(): Promise<void> {
  if (inflight) return inflight;
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

      const body = (await res.json()) as { items: Zone[]; isSuperAdmin?: boolean };
      if (epoch !== sessionEpoch) return; // superseded between fetch + parse
      const isSuperAdminFlag = body.isSuperAdmin === true;

      if (body.items.length === 0) {
        // Super-admins may legitimately have zero zone bindings (platform-only
        // users). Treat them as authenticated so /admin is reachable.
        if (isSuperAdminFlag) {
          session.current = {
            status: "authenticated",
            zones: [],
            activeZoneSlug: null,
            isSuperAdmin: true,
          };
          return;
        }
        // Authenticated but bound to no zone — surface explicitly instead of
        // showing protected nav links that will fail every API call.
        session.current = { status: "no_zone", zones: [], activeZoneSlug: null };
        return;
      }

      const stored =
        typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_ZONE_KEY) : null;
      const fallback = body.items[0]?.slug ?? null;
      const activeZoneSlug =
        stored && body.items.some((z) => z.slug === stored) ? stored : fallback;
      session.current = {
        status: "authenticated",
        zones: body.items,
        activeZoneSlug,
        isSuperAdmin: isSuperAdminFlag,
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
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(ACTIVE_ZONE_KEY);
  }
  session.current = { status: "anonymous", zones: [], activeZoneSlug: null };

  try {
    await fetch(`${PUBLIC_API_URL}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
    });
  } catch (err) {
    console.warn(
      "[session] sign-out POST failed (local state already cleared):",
      err instanceof Error ? err.message : err,
    );
  }
}

export { isProtectedPath, isSafeInternalPath, ACTIVE_ZONE_KEY } from "$lib/session-paths";
