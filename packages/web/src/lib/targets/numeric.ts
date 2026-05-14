// packages/web/src/lib/targets/numeric.ts
// Phase 8 — client-side validators for the financial-targets form.
// The integer fields ('target copies', 'number of partners') are
// rendered as text inputs (so .trim() works uniformly with the money
// fields), which means we lose native pattern validation and have
// to reject bad input ourselves before building the request body.
// `Number("abc")` is NaN, which JSON-serialises to null — sending
// that would silently clear the field server-side instead of
// returning a 400, so we must catch it here.
// RELEVANT FILES: packages/web/src/routes/zone/targets/+page.svelte

/**
 * Parse a free-text non-negative integer field.
 *   - blank → `null` (the optional field is left unset).
 *   - `"0"` or `"42"` → the parsed integer.
 *   - anything else → throws an `Error` whose message can be
 *     surfaced to the user.
 *
 * `label` is interpolated into the error message so the same parser
 * can serve multiple fields.
 */
export function parseOptionalCount(raw: string, label: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Reject decimals, leading zeros except "0", signs, anything
  // non-digit. This is intentionally stricter than Number() so a
  // typo like "5o" doesn't slip through as NaN.
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) {
    throw new Error(`${label} must be a non-negative whole number.`);
  }
  const n = Number(trimmed);
  // Belt-and-braces: the regex above already excludes Infinity / NaN,
  // but very long digit strings can exceed Number.MAX_SAFE_INTEGER.
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${label} is too large.`);
  }
  return n;
}
