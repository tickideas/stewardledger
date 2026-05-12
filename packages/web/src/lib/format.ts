// packages/web/src/lib/format.ts
// Display helpers shared across pages. Keep this file small — anything
// non-trivial belongs in a feature module.

/**
 * Format a numeric-string amount using the Intl.NumberFormat currency
 * style. Falls back to "{currency} {n.toFixed(fractionDigits)}" if the
 * platform can't recognise the currency code (rare but possible with
 * obscure ISO codes).
 */
export function fmtMoney(
  total: string | number,
  currency: string,
  fractionDigits = 0,
): string {
  const n = typeof total === "number" ? total : Number(total);
  if (!Number.isFinite(n)) return String(total);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(fractionDigits)}`;
  }
}
