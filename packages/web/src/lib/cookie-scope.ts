// packages/web/src/lib/cookie-scope.ts
// Pure helpers for diagnosing whether the browser is likely to send the API's
// session cookie back to the SvelteKit web origin. Used by `hooks.server.ts`
// to emit a single cold-start warning when the deployment looks misconfigured.
//
// The classic silent failure: API on `api.example.com`, web on
// `app.example.com`, no shared cookie domain set on Better Auth. The browser
// sets the session cookie host-only on the API origin; it is NEVER attached
// to web-origin page requests; `hooks.server.ts` sees no cookie and treats
// every signed-in user as anonymous, bouncing them through `/login`.
//
// We can't *detect* that with certainty from inside the SvelteKit worker (we
// don't see the API's `Set-Cookie` headers), but we can flag the topology
// where it's the likely cause and tell the operator what to check.

/**
 * The web and API origin share the *exact* same host (e.g. both on
 * `app.example.com` with the API mounted at a path prefix, or both on
 * `localhost:3000` via a vite proxy). Cookies set on the API just work.
 */
export function isSameOriginHost(webHost: string, apiHost: string): boolean {
  return normaliseHost(webHost) === normaliseHost(apiHost);
}

/**
 * Web and API are on different hosts but share a registrable parent — e.g.
 * `app.example.com` + `api.example.com`. In this topology Better Auth MUST
 * be configured with `crossSubDomainCookies.domain` set to a shared parent
 * (`example.com` or `.example.com`); otherwise the API's cookie is
 * host-only and never sent to the web origin.
 *
 * We use a naive longest-common-suffix check (matching on full label
 * boundaries) rather than a full PSL lookup — good enough for the warning,
 * and avoids pulling a public-suffix-list dependency into the web package.
 */
export function sharesParentDomain(webHost: string, apiHost: string): boolean {
  const a = labels(webHost);
  const b = labels(apiHost);
  if (a.length < 2 || b.length < 2) return false;
  // Need at least two shared trailing labels to count as a shared parent
  // (e.g. `example.com`). Single shared TLD (`com`) is not enough.
  return a[a.length - 1] === b[b.length - 1] && a[a.length - 2] === b[b.length - 2];
}

export type CookieScopeDiagnosis =
  | { kind: "same-origin" }
  | { kind: "shared-parent"; parent: string }
  | { kind: "cross-site" };

/**
 * Classify the (web, api) host pair into one of three topologies. The
 * caller decides what to do with each — `hooks.server.ts` warns on
 * `shared-parent` (operator must set `AUTH_COOKIE_DOMAIN`) and
 * `cross-site` (cookies almost certainly will not work).
 */
export function diagnoseCookieScope(webHost: string, apiHost: string): CookieScopeDiagnosis {
  if (isSameOriginHost(webHost, apiHost)) return { kind: "same-origin" };
  if (sharesParentDomain(webHost, apiHost)) {
    const a = labels(webHost);
    const parent = a.slice(-2).join(".");
    return { kind: "shared-parent", parent };
  }
  return { kind: "cross-site" };
}

function normaliseHost(host: string): string {
  // Strip port; lowercase. We deliberately keep `localhost` as-is.
  return host.toLowerCase().split(":")[0] ?? "";
}

function labels(host: string): string[] {
  const h = normaliseHost(host);
  if (!h) return [];
  return h.split(".").filter(Boolean);
}
