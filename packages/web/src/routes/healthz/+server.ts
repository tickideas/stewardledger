// Lightweight liveness probe for Docker/Dokploy healthchecks.
// Intentionally side-effect-free: no DB, no auth, no cookies.
export const prerender = false;

export function GET() {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}
