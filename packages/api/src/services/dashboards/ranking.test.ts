// packages/api/src/services/dashboards/ranking.test.ts
// Phase 7 — per-currency top-N ranking helper tests.
// RELEVANT FILES: packages/api/src/services/dashboards/ranking.ts

import { describe, expect, it } from "vitest";
import { rankByCurrency } from "./ranking";

interface Row {
  id: string;
  currencyCode: string;
  total: string;
}

describe("rankByCurrency", () => {
  it("returns rows sorted by total descending within each currency", () => {
    const rows: Row[] = [
      { id: "a", currencyCode: "GBP", total: "10.00" },
      { id: "b", currencyCode: "GBP", total: "30.00" },
      { id: "c", currencyCode: "GBP", total: "20.00" },
    ];
    const out = rankByCurrency(rows, 5);
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("truncates per currency to N rows", () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      currencyCode: "GBP",
      total: String(10 + i),
    }));
    const out = rankByCurrency(rows, 3);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.id)).toEqual(["row-9", "row-8", "row-7"]);
  });

  it("emits parallel ranked lists, one per currency, in ASCII-sorted order", () => {
    const rows: Row[] = [
      { id: "u-low", currencyCode: "USD", total: "5.00" },
      { id: "g-hi", currencyCode: "GBP", total: "100.00" },
      { id: "u-hi", currencyCode: "USD", total: "200.00" },
      { id: "g-low", currencyCode: "GBP", total: "10.00" },
    ];
    const out = rankByCurrency(rows, 5);
    // GBP block first (alphabetic), then USD block; each ranked by total desc.
    expect(out.map((r) => r.id)).toEqual(["g-hi", "g-low", "u-hi", "u-low"]);
  });

  it("drops zero-total rows", () => {
    const rows: Row[] = [
      { id: "a", currencyCode: "GBP", total: "0" },
      { id: "b", currencyCode: "GBP", total: "0.0000" },
      { id: "c", currencyCode: "GBP", total: "5.00" },
    ];
    const out = rankByCurrency(rows, 5);
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  it("returns an empty list when n is zero or negative", () => {
    const rows: Row[] = [{ id: "a", currencyCode: "GBP", total: "5.00" }];
    expect(rankByCurrency(rows, 0)).toEqual([]);
    expect(rankByCurrency(rows, -1)).toEqual([]);
  });
});
