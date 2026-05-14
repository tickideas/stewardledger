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
 * The input is the result of a SQL `sum(amount) ... group by ...,
 * currency_code` query; `total` arrives as a `numeric` string with
 * 4dp precision.
 */
export function rankByCurrency<T extends RankableRow>(rows: T[], n: number): T[] {
  if (n <= 0) return [];
  const byCurrency = new Map<string, T[]>();
  for (const row of rows) {
    if (new Decimal(row.total).isZero()) continue;
    const list = byCurrency.get(row.currencyCode) ?? [];
    list.push(row);
    byCurrency.set(row.currencyCode, list);
  }
  const out: T[] = [];
  for (const currencyCode of Array.from(byCurrency.keys()).sort()) {
    const list = byCurrency.get(currencyCode)!;
    list.sort((a, b) => new Decimal(b.total).comparedTo(new Decimal(a.total)));
    out.push(...list.slice(0, n));
  }
  return out;
}
