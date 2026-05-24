// packages/web/src/lib/api.ts
// Tiny fetch wrapper for the StewardLedger HTTP API. Always sends credentials
// Adds tenant context for split-host API deployments.
// RELEVANT FILES: ./session.svelte.ts, ./session-paths.ts, ../../../api/src/middleware/tenant.ts

import { PUBLIC_API_URL } from "./env";
import { session } from "./session.svelte";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Per-call options. Pages running long-lived effects (typeahead, list
 * filters, member-statement reloads) should pass `signal` so an in-flight
 * request can be aborted on unmount or when a newer request supersedes it.
 */
export interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const headers = new Headers(body ? { "content-type": "application/json" } : undefined);
  const zoneSlug = currentZoneSlug();
  if (zoneSlug && path.startsWith("/api/tenant/")) {
    headers.set("x-stewardledger-zone-slug", zoneSlug);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${PUBLIC_API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
    signal: opts.signal,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? "unknown", err?.message ?? res.statusText, err?.details);
  }
  return json as T;
}

function currentZoneSlug(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("zone");
  if (fromUrl) {
    localStorage.setItem("stewardledger.activeZoneSlug", fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem("stewardledger.activeZoneSlug");
  if (stored) return stored;
  return session.current.status === "authenticated" ? session.current.activeZoneSlug : null;
}

/**
 * `true` when the rejection came from `signal.abort()` — callers usually
 * want to ignore that and not surface an error to the user.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// Backwards-compatible signatures: previously `api.get(path, fetchImpl?)`.
// New shape accepts either an `AbortSignal` or a `RequestOptions` bag, so
// existing callers keep working while new callers can opt into aborts.
function asOpts(arg: AbortSignal | RequestOptions | typeof fetch | undefined): RequestOptions {
  if (!arg) return {};
  if (typeof arg === "function") return { fetchImpl: arg as typeof fetch };
  if (arg instanceof AbortSignal) return { signal: arg };
  return arg;
}

type Arg = AbortSignal | RequestOptions | typeof fetch | undefined;

export const api = {
  get: <T>(path: string, arg?: Arg) => request<T>("GET", path, undefined, asOpts(arg)),
  post: <T>(path: string, body: unknown, arg?: Arg) => request<T>("POST", path, body, asOpts(arg)),
  put: <T>(path: string, body: unknown, arg?: Arg) => request<T>("PUT", path, body, asOpts(arg)),
  patch: <T>(path: string, body: unknown, arg?: Arg) => request<T>("PATCH", path, body, asOpts(arg)),
  delete: <T>(path: string, arg?: Arg) => request<T>("DELETE", path, undefined, asOpts(arg)),
};
