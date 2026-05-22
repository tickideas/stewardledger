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
  // Strip an optional surrounding `[…]:port` from the bracketed
  // IPv6 form (`[2001:db8::1]:41237`). After this, anything inside the
  // brackets is the bare address; if there is no port we still strip
  // any leading/trailing brackets via the second replace below.
  let cleaned = first;
  const bracketPort = /^\[([^\]]+)\](?::\d+)?$/.exec(cleaned);
  if (bracketPort) {
    cleaned = bracketPort[1];
  }
  // IPv4 + port: 203.0.113.7:41237 — strip the trailing :port. We only
  // do this when the value contains exactly one `:` so an IPv6 literal
  // (which always has at least two `:`) is not mangled.
  if ((cleaned.match(/:/g)?.length ?? 0) === 1 && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(cleaned)) {
    cleaned = cleaned.split(":")[0]!;
  }
  // Cheap shape check — anything that doesn't look like an IP at all
  // (e.g. "unknown" — yes, some load balancers really do that, or any
  // residual port that slipped past the rules above) is dropped so the
  // inet insert doesn't blow up.
  if (!/^[0-9a-fA-F:.]+$/.test(cleaned)) return null;
  // Reject any value that still contains exactly one `:` (a bare
  // IPv4:port that didn't match the strict IPv4 pattern above, or some
  // other host:port string the regex would otherwise let through).
  if ((cleaned.match(/:/g)?.length ?? 0) === 1) return null;
  return cleaned;
}
