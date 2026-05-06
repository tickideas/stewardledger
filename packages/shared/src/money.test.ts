// packages/shared/src/money.test.ts

import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  formatMoney,
  isZeroMoney,
  money,
  moneySchema,
  sumByCurrency,
  toDecimal,
} from "./money";

describe("money", () => {
  it("constructs with 4 dp", () => {
    expect(money("100", "GBP")).toEqual({ amount: "100.0000", currency: "GBP" });
    expect(money(100.5, "USD")).toEqual({ amount: "100.5000", currency: "USD" });
  });

  it("uppercases currency", () => {
    expect(money("1", "gbp").currency).toBe("GBP");
  });

  it("addMoney sums same-currency", () => {
    const a = money("100", "GBP");
    const b = money("23.50", "GBP");
    expect(addMoney(a, b)).toEqual({ amount: "123.5000", currency: "GBP" });
  });

  it("addMoney throws on currency mismatch", () => {
    expect(() => addMoney(money("1", "GBP"), money("1", "USD"))).toThrow(/Cannot add/);
  });

  it("sumByCurrency groups by currency", () => {
    const totals = sumByCurrency([
      money("100", "GBP"),
      money("50", "USD"),
      money("25", "GBP"),
      money("10", "USD"),
    ]);
    const sorted = [...totals].sort((a, b) => a.currency.localeCompare(b.currency));
    expect(sorted).toEqual([
      { amount: "125.0000", currency: "GBP" },
      { amount: "60.0000", currency: "USD" },
    ]);
  });

  it("compareMoney returns -1/0/1", () => {
    expect(compareMoney(money("1", "GBP"), money("2", "GBP"))).toBe(-1);
    expect(compareMoney(money("2", "GBP"), money("2", "GBP"))).toBe(0);
    expect(compareMoney(money("3", "GBP"), money("2", "GBP"))).toBe(1);
  });

  it("isZeroMoney", () => {
    expect(isZeroMoney(money("0", "GBP"))).toBe(true);
    expect(isZeroMoney(money("0.0001", "GBP"))).toBe(false);
  });

  it("toDecimal preserves precision", () => {
    expect(toDecimal(money("0.1", "GBP")).plus(toDecimal(money("0.2", "GBP"))).toFixed(4)).toBe(
      "0.3000",
    );
  });

  it("formatMoney renders ISO-aware string", () => {
    const out = formatMoney(money("1234.5", "GBP"), "en-GB");
    // Allow either NBSP or normal space depending on Intl impl
    expect(out).toMatch(/^£\s?1,234\.50$/);
  });

  it("moneySchema validates wire format", () => {
    expect(moneySchema.safeParse({ amount: "100.5000", currency: "GBP" }).success).toBe(true);
    expect(moneySchema.safeParse({ amount: "100.50000", currency: "GBP" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: "abc", currency: "GBP" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: "100", currency: "gbp" }).success).toBe(false);
  });
});
