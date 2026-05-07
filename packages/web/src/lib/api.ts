// packages/web/src/lib/api.ts
// Tiny fetch wrapper for the StewardLedger HTTP API. Always sends credentials
// so Better Auth cookies travel with requests.

import { PUBLIC_API_URL } from "./env";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${PUBLIC_API_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? "unknown", err?.message ?? res.statusText);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, fetchImpl?: typeof fetch) => request<T>("GET", path, undefined, fetchImpl),
  post: <T>(path: string, body: unknown, fetchImpl?: typeof fetch) =>
    request<T>("POST", path, body, fetchImpl),
  patch: <T>(path: string, body: unknown, fetchImpl?: typeof fetch) =>
    request<T>("PATCH", path, body, fetchImpl),
  delete: <T>(path: string, fetchImpl?: typeof fetch) =>
    request<T>("DELETE", path, undefined, fetchImpl),
};
