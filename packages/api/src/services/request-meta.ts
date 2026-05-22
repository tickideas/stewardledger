// packages/api/src/services/request-meta.ts
// Helpers for extracting audit metadata from an HTTP request. Lives next
// to audit.ts because every caller that writes an audit row also needs
// to normalise these headers; the audit_events.ip_address column is
// Postgres `inet`, which refuses comma-separated values and rolls back
// the surrounding transaction on a bad insert.
//
// RELEVANT FILES: packages/api/src/services/audit.ts, packages/api/src/routes/admin-administrators.ts, packages/api/src/auth.ts

/**
 * Reduce an `x-forwarded-for` header to a single IPv4/IPv6 literal
 * suitable for the `inet` column. Returns null if no value is usable.
 *
 * X-Forwarded-For is a comma-separated chain: `client, proxy1, proxy2`.
 * Standard convention is that the *left-most* entry is the original
 * client (every intermediate proxy appends its own peer). We trust the
 * left-most because that's what most deployments want to record; if
 * a downstream operator needs the closest-trusted-proxy semantics
 * instead, they can swap this helper without touching the callers.
 *
 * The IPv4/IPv6 patterns here are intentionally loose — Postgres
 * `inet` is the source of truth and will reject malformed input. We
 * just need to refuse the obvious garbage (comma-chains, whitespace,
 * empty strings) so the transaction does not roll back.
 */
export function parseForwardedIp(header: string | null | undefined): string | null {
  if (!header) return null;
  const first = header.split(",")[0]?.trim();
  if (!first) return null;
  // Strip an optional surrounding `[…]` from a bracketed IPv6 + port form.
  const cleaned = first.replace(/^\[(.+)\]$/, "$1");
  // Cheap shape check — anything that doesn't look like an IP at all
  // (e.g. "unknown" — yes, some load balancers really do that) is
  // dropped so the inet insert doesn't blow up.
  if (!/^[0-9a-fA-F:.]+$/.test(cleaned)) return null;
  return cleaned;
}
