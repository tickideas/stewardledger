// packages/web/src/hooks.server.ts
// Forward the incoming Cookie header to the API's session endpoint so SSR
// can know whether the request is authenticated and which roles the user
// holds. This is the foundation of the server-side route gates in each
// shell's `+layout.server.ts`.
//
// Why this works: Better Auth issues session cookies on the API origin. As
// long as the API and web share an origin (or a parent domain with the
// right SameSite=Lax/None settings), the browser sends those cookies on
// SvelteKit page requests too. We forward them verbatim to the API.

import type { Handle } from "@sveltejs/kit";
import { PUBLIC_API_URL } from "$lib/env";
import type { ServerSession } from "$lib/session-paths";

type WireSessionZones = {
  items: Array<{
    id: string;
    slug: string;
    name: string;
    zoneRoles?: string[];
    chapterRoles?: Array<{ chapterId: string; chapterName?: string; roleCode: string }>;
  }>;
  isSuperAdmin: boolean;
  user?: { id: string; email: string; name: string | null } | null;
};

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.session = await loadSession(event.request.headers, event.fetch);
  return resolve(event);
};

/**
 * Bound for the session-zones fetch. The API call sits on the critical
 * path of every authenticated page render, so a slow upstream must not
 * block the SvelteKit worker. 2.5s is the trade-off: longer than any
 * realistic warm-path call, shorter than a typical Node `fetch` default
 * (which has no timeout at all).
 */
const SESSION_FETCH_TIMEOUT_MS = 2500;

/**
 * Hit `/api/public/session-zones` with the user's cookies. Returns `null`
 * when the user is unauthenticated, errored, timed out, or the API is
 * unreachable — the layout guards treat all three as "not signed in" and
 * redirect to `/login`. We deliberately don't distinguish here; the API
 * is the source of truth for "do you have a session".
 *
 * Failures log a single warning per request so an outage shows up in ops
 * dashboards without spamming the log on the happy path.
 */
async function loadSession(
  reqHeaders: Headers,
  fetchImpl: typeof fetch,
): Promise<ServerSession | null> {
  const cookie = reqHeaders.get("cookie");
  if (!cookie) return null;
  try {
    const res = await fetchImpl(`${PUBLIC_API_URL}/api/public/session-zones`, {
      headers: { cookie },
      signal: AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Non-2xx that isn't 401 is worth noticing — 401 is the expected
      // "no session" path and not interesting.
      if (res.status !== 401) {
        console.warn("[hooks.server] session-zones returned", res.status);
      }
      return null;
    }
    const body = (await res.json()) as WireSessionZones;
    // Normalise to the gate-friendly shape: discard names + ids, keep the
    // slug + role arrays that the gates check against.
    return {
      isSuperAdmin: body.isSuperAdmin === true,
      items: (body.items ?? []).map((z) => ({
        slug: z.slug,
        zoneRoles: z.zoneRoles ?? [],
        chapterRoles: (z.chapterRoles ?? []).map((r) => ({
          chapterId: r.chapterId,
          roleCode: r.roleCode,
        })),
      })),
    };
  } catch (err) {
    // Network / parse / timeout failure. Log enough context to diagnose,
    // then surface as "no session" so the gate fail-closes to /login.
    const reason = err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "error";
    console.warn(`[hooks.server] session-zones ${reason}:`, err);
    return null;
  }
}
