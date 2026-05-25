// packages/web/src/routes/zone/settings/exports/[exportId]/download/+server.ts
// Phase 9 §3 — streaming proxy for the per-zone export bundle.
//
// Why a SvelteKit proxy instead of a direct browser fetch:
//
//   - The bundle is a single `.tar.gz` that can comfortably reach
//     multi-GB. A browser `await res.blob()` materialises the whole
//     artefact in JS heap before triggering the save prompt, which
//     OOMs the tab on a real-sized zone.
//   - This handler proxies the upstream API response by piping its
//     `ReadableStream` body straight back to the client with an
//     `attachment` Content-Disposition. The browser's native
//     download path streams to disk; the SvelteKit process never
//     buffers the body in memory.
//   - It also fixes the tenant-resolution drift the Codex bot
//     flagged: the page used to read `localStorage` directly,
//     which misses the `session.activeZoneSlug` fallback. Routing
//     the download through the same host as the page means the
//     tenant is resolved server-side from the incoming Host header
//     (production single-domain) or via the forwarded
//     `x-stewardledger-zone-slug` header (split-host dev). The
//     loader picks the right one from the request cookies + URL.
//
// Auth + tenant: the Better Auth session cookie and the active
// zone slug are forwarded to the API; nothing else. The API
// re-runs the same role gate as the JSON endpoints, so this proxy
// adds no new trust assumptions — a non-owner still 403s upstream.
// Forwarding the *entire* inbound header set would leak
// frame-ancestor / origin headers scoped to the web origin and
// unrelated to the API's authorisation contract.
//
// RELEVANT FILES: ../../+page.svelte, packages/api/src/routes/tenant-exports.ts

import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { PUBLIC_API_URL } from "$lib/env";

// `prerender = false` keeps the route out of any static build pass
// even on adapters that try to crawl GETs. (`csr` is a page/layout
// option — omitted here because it's a no-op on `+server.ts`.)
export const prerender = false;

export const GET: RequestHandler = async ({ params, request, url }) => {
  const exportId = params.exportId;
  if (!exportId || !/^[a-f0-9-]{8,64}$/i.test(exportId)) {
    error(400, "invalid_export_id");
  }

  // The page hands us the active slug via `?zone=<slug>` so the
  // proxy keeps the same resolution semantics as `api.ts`
  // (`currentZoneSlug` writes the slug into the URL on every
  // wrapper call). Falling back to the inbound header keeps the
  // dev split-host path working. Whichever source wins, the value
  // must match the same kebab-case shape `zoneSlugSchema`
  // validates — bare forwarding would let a crafted header
  // probe odd values upstream.
  const rawSlug =
    url.searchParams.get("zone") ??
    request.headers.get("x-stewardledger-zone-slug") ??
    "";
  const zoneSlug = /^[a-z0-9][a-z0-9-]{1,63}$/.test(rawSlug) ? rawSlug : "";

  // Only the two headers the API's tenant + auth middleware
  // actually read: the Better Auth session cookie and the
  // zone-slug header (split-host dev / explicit override).
  // Everything else (accept-language, sec-*, x-forwarded-*) is
  // dropped — the upstream JSON routes don't depend on them
  // and forwarding them blindly would be a surprise channel.
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  if (zoneSlug) headers.set("x-stewardledger-zone-slug", zoneSlug);

  const upstream = await fetch(
    `${PUBLIC_API_URL}/api/tenant/zones/exports/${encodeURIComponent(exportId)}/download`,
    { method: "GET", headers, redirect: "manual" },
  );

  if (!upstream.ok || !upstream.body) {
    // Forward the upstream status + JSON body verbatim so the
    // caller sees the same 403 / 404 / 409 / 410 shape they would
    // from the JSON API.
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store, max-age=0",
      },
    });
  }

  // Pipe the upstream body straight through. SvelteKit's adapter
  // forwards the `ReadableStream` to the underlying HTTP server
  // (node or workers) which streams it to the browser; the
  // SvelteKit process never buffers more than the current chunk.
  const outHeaders = new Headers();
  outHeaders.set(
    "content-type",
    upstream.headers.get("content-type") ?? "application/gzip",
  );
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) outHeaders.set("content-disposition", disposition);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) outHeaders.set("content-length", contentLength);
  outHeaders.set("cache-control", "no-store, max-age=0");

  return new Response(upstream.body, {
    status: 200,
    headers: outHeaders,
  });
};
