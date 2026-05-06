// packages/shared/src/money.ts
// Money handling. Always numeric(19,4) on the wire as a string.
// Never use JavaScript number for money math — always Decimal.

import Decimal from "decimal.js";
import { z } from "zod";
import { MONEY_DISPLAY_DECIMALS, MONEY_PRECISION } from "./constants";

/**
 * Money is represented as `{ amount: string, currency: string }` end-to-end.
 * The `amount` is a fixed-precision decimal string (4 dp), e.g. "1234.5600".
 * The `currency` is an ISO 4217 code, e.g. "GBP", "USD", "NGN".
 */
export interface Money {
  amount: string;
  currency: string;
}

/** ISO 4217 currency code regex (3 uppercase letters). */
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Decimal string with up to MONEY_PRECISION fractional digits. */
const AMOUNT_RE = new RegExp(`^-?\\d+(\\.\\d{1,${MONEY_PRECISION}})?$`);

export const moneySchema = z.object({
  amount: z.string().regex(AMOUNT_RE, "amount must be a decimal with up to 4 dp"),
  currency: z.string().regex(CURRENCY_RE, "currency must be ISO 4217 (e.g. GBP)"),
});

export const currencyCodeSchema = z.string().regex(CURRENCY_RE, "currency must be ISO 4217");

/** Parse a Money to Decimal for arithmetic. */
export function toDecimal(money: Money): Decimal {
  return new Decimal(money.amount);
}

/** Build a Money from a Decimal/string/number with explicit currency. */
export function money(amount: Decimal | string | number, currency: string): Money {
  const dec = new Decimal(amount);
  return {
    amount: dec.toFixed(MONEY_PRECISION),
    currency: currency.toUpperCase(),
  };
}

/** Add two Moneys. Throws if currencies differ. */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} and ${b.currency} — no FX in v1`);
  }
  return money(toDecimal(a).plus(toDecimal(b)), a.currency);
}

/** Sum a list of Moneys, grouped by currency. Empty input => empty array. */
export function sumByCurrency(moneys: Money[]): Money[] {
  const totals = new Map<string, Decimal>();
  for (const m of moneys) {
    const current = totals.get(m.currency) ?? new Decimal(0);
    totals.set(m.currency, current.plus(toDecimal(m)));
  }
  return [...totals.entries()].map(([currency, total]) => money(total, currency));
}

/** Format Money for display. Locale defaults to "en-GB" — pass tenant locale in production. */
export function formatMoney(m: Money, locale: string = "en-GB"): string {
  const decimal = toDecimal(m);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: m.currency,
      minimumFractionDigits: MONEY_DISPLAY_DECIMALS,
      maximumFractionDigits: MONEY_DISPLAY_DECIMALS,
    }).format(decimal.toNumber());
  } catch {
    // Fallback if Intl doesn't recognize the currency.
    return `${m.currency} ${decimal.toFixed(MONEY_DISPLAY_DECIMALS)}`;
  }
}

/** Compare two Moneys: -1 / 0 / 1. Throws on currency mismatch. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot compare ${a.currency} and ${b.currency}`);
  }
  return toDecimal(a).cmp(toDecimal(b)) as -1 | 0 | 1;
}

/** True if amount is zero (currency-agnostic). */
export function isZeroMoney(m: Money): boolean {
  return toDecimal(m).isZero();
}
