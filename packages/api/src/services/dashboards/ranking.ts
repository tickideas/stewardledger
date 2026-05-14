// packages/api/src/services/dashboards/ranking.ts
// Phase 7 — generic per-currency top-N ranking helper.
// Aggregated rows from a SUM-by-(key, currency) query land here; the
// helper buckets by currency, sorts each bucket by total descending,
// and truncates to N. Used by the zone dashboard's top-chapters and
// top-partners cards (and the audit-log report's parallel rankings,
// once it adopts the helper).
// RELEVANT FILES: packages/api/src/services/dashboards/zone-dashboard.ts, packages/api/src/services/reports/top-chapters.ts, packages/api/src/services/reports/top-partners.ts

import Decimal from "decimal.js";

export interface RankableRow {
  currencyCode: string;
  total: string; // numeric(19,4)
}

/**
 * Bucket `rows` by `currencyCode`, drop zero-total rows (a fully-
 * reversed contribution nets to zero and shouldn't show up in a top
 * list), sort each bucket by `total` descending, and concatenate the
 * top-N per currency. Currencies render in ASCII-sorted order so the
 * UI is deterministic across runs.
 *
 * Currency-preference ordering (e.g. zone-default first) is
 * deliberately not threaded through here: the helper sees only the
 * row shape, not zone metadata, and v1 callers all want a stable
 * ordering rather than a tenant-aware one. Add a `primaryCurrency`
 * parameter when the first caller actually needs it.
 *
 * The input is the result of a SQL `sum(amount) ... group by ...,
 * currency_code` query; `total` arrives as a `numeric` string with
 * 4dp precision. Each row is decoded into `Decimal` exactly once to
 * keep the helper allocation-light at the scale of the standalone
 * top-partners / top-chapters reports (potentially several thousand
 * rows per call).
 */
export function rankByCurrency<T extends RankableRow>(rows: T[], n: number): T[] {
  if (n <= 0) return [];
  interface Decoded {
    row: T;
    total: Decimal;
  }
  const byCurrency = new Map<string, Decoded[]>();
  for (const row of rows) {
    const total = new Decimal(row.total);
    if (total.isZero()) continue;
    const list = byCurrency.get(row.currencyCode) ?? [];
    list.push({ row, total });
    byCurrency.set(row.currencyCode, list);
  }
  const out: T[] = [];
  for (const currencyCode of Array.from(byCurrency.keys()).sort()) {
    const list = byCurrency.get(currencyCode)!;
    list.sort((a, b) => b.total.comparedTo(a.total));
    for (let i = 0; i < Math.min(n, list.length); i++) {
      out.push(list[i].row);
    }
  }
  return out;
}
