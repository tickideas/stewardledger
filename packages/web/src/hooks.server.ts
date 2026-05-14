// packages/web/src/hooks.server.ts
// Forward the incoming Cookie header to the API's session endpoint so SSR
// can know whether the request is authenticated and which roles the user
// holds. This is the foundation of the server-side route gates in each
// shell's `+layout.server.ts` and of the SSR → client hydration in
// `+layout.svelte` (`hydrateSession(data.session)`).
//
// Why this works: Better Auth issues session cookies on the API origin. For
// split-host deployments (`app.example.com` + `api.example.com`) the API
// must set `AUTH_COOKIE_DOMAIN=.example.com` so the cookie is scoped to
// the shared parent. The cold-start `warnIfCookieScopeMisconfigured`
// below flags the obvious misconfigurations. See `docs/DEPLOYMENT.md`
// “Cookie scope” for the full topology matrix.
// RELEVANT FILES: ./lib/session-paths.ts, ./lib/cookie-scope.ts, ./routes/+layout.server.ts

import type { Handle } from "@sveltejs/kit";
import { PUBLIC_API_URL } from "$lib/env";
import { diagnoseCookieScope } from "$lib/cookie-scope";
import type { ServerSession } from "$lib/session-paths";

type WireSessionZones = {
  items: Array<{
    id: string;
    slug: string;
    name: string;
    zoneRoles?: string[];
    chapterRoles?: Array<{ chapterId: string; chapterName?: string; roleCode: string }>;
    mfaRequired?: boolean;
  }>;
  isSuperAdmin: boolean;
  user?: {
    id: string;
    email: string;
    name: string | null;
    twoFactorEnabled?: boolean;
  } | null;
};

// JSON the SSR layout returns to the browser. Identical shape to
// `ServerSession` but with the date-free, JSON-safe primitives that
// SvelteKit serialises on the wire.
export type SerializableSession = WireSessionZones;

/**
 * One-shot guard: if the web and API origins look like they can't share a
 * session cookie, emit a single warning on the first authenticated-looking
 * page request. Stays silent for same-origin deployments and during the
 * pre-warmup phase where no request has arrived yet.
 */
let cookieScopeChecked = false;

export const handle: Handle = async ({ event, resolve }) => {
  if (!cookieScopeChecked) {
    cookieScopeChecked = true;
    warnIfCookieScopeMisconfigured(event.url.host, PUBLIC_API_URL);
  }
  event.locals.session = await loadSession(event.request.headers, event.fetch);
  return resolve(event);
};

/**
 * Cold-start diagnostic. Fires once per worker process the first time a
 * request lands. We don't have direct visibility into the API's cookie
 * configuration, so we infer from topology: if web and API are on
 * different hosts and the API origin's cookie isn't scoped to a shared
 * parent, the browser will not send it to the web origin and every signed-
 * in user will be silently treated as anonymous.
 */
function warnIfCookieScopeMisconfigured(webHost: string, apiUrl: string): void {
  let apiHost: string;
  try {
    apiHost = new URL(apiUrl).host;
  } catch {
    console.warn(`[hooks.server] PUBLIC_API_URL is not a valid URL: ${apiUrl}`);
    return;
  }
  const diag = diagnoseCookieScope(webHost, apiHost);
  if (diag.kind === "same-origin") return;
  if (diag.kind === "shared-parent") {
    console.warn(
      `[hooks.server] web (${webHost}) and API (${apiHost}) share parent ${diag.parent}. ` +
        `If signed-in users get redirected to /login, set AUTH_COOKIE_DOMAIN=.${diag.parent} ` +
        `on the API so Better Auth scopes the session cookie to the shared parent. ` +
        `See docs/DEPLOYMENT.md “Cookie scope”.`,
    );
    return;
  }
  console.warn(
    `[hooks.server] web (${webHost}) and API (${apiHost}) are on unrelated hosts. ` +
      `Browsers will not send the API's session cookie to the web origin, so SSR ` +
      `will see every request as anonymous. Either host web + API on a shared ` +
      `parent domain or proxy the API under the web origin. See docs/DEPLOYMENT.md.`,
  );
}

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
    // Keep the full wire payload — the client store hydrates from this
    // in `+layout.svelte` to avoid a second `/api/public/session-zones`
    // round-trip on cold page loads. The gate helpers only read
    // `isSuperAdmin` + the role arrays; extra fields are inert for them.
    return {
      isSuperAdmin: body.isSuperAdmin === true,
      items: (body.items ?? []).map((z) => ({
        id: z.id,
        slug: z.slug,
        name: z.name,
        zoneRoles: z.zoneRoles ?? [],
        chapterRoles: (z.chapterRoles ?? []).map((r) => ({
          chapterId: r.chapterId,
          chapterName: r.chapterName,
          roleCode: r.roleCode,
        })),
        mfaRequired: z.mfaRequired === true,
      })),
      user: body.user ?? null,
    };
  } catch (err) {
    // Network / parse / timeout failure. Log enough context to diagnose,
    // then surface as "no session" so the gate fail-closes to /login.
    const reason = err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "error";
    console.warn(`[hooks.server] session-zones ${reason}:`, err);
    return null;
  }
}
