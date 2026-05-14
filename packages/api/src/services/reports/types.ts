// packages/api/src/services/reports/types.ts
// Phase 7 — shared report-spec shape and supporting types.
//
// Reports are composed via the `ReportSpec<F, R>` contract: a Zod
// filter schema, a `fetch` that produces normalised rows, a `columns`
// projection used by both the screen and exports, and per-format
// renderers (`excel`; optionally `pdf` — reports that don't supply
// their own `pdf()` are rendered by the generic branded-table
// fallback in `pdf/branded-table.ts`). The registry exposes a typed
// `id` so route/UI plumbing stays string-key driven.

import type { z, ZodTypeAny } from "zod";
import type { AuthorizedContext } from "@stewardledger/shared";
import type { Database } from "@stewardledger/db";

/** Column projection shared by screen + exports. */
export interface ReportColumn {
  key: string;
  label: string;
  /** "text" | "number" | "money" | "date" | "datetime" — drives Excel formatting. */
  kind: "text" | "number" | "money" | "date" | "datetime";
  /** Hide on screen / Excel when the viewer cannot see PII (e.g. emails). */
  pii?: boolean;
}

/** Branding metadata pulled once per request, stamped on every export. */
export interface ReportBranding {
  zoneName: string;
  zoneSlug: string;
  legalName: string | null;
  countryCode: string;
  defaultCurrencyCode: string;
  /** Logo URL/data URI if/when zone branding ships logos. Optional. */
  logoUrl?: string | null;
}

/**
 * Per-currency subtotal — used wherever a report sums money. Reports
 * never silently FX-convert; they always group by currency and surface
 * a per-currency subtotal.
 */
export interface CurrencySubtotal {
  currencyCode: string;
  total: string; // numeric(19,4) on the wire
}

/**
 * Aggregated payload a `fetch` call returns. Splits row data from
 * cross-row summaries (per-currency subtotals, counts) so exports
 * can render both without re-aggregating.
 */
export interface ReportFetchResult<R> {
  rows: R[];
  /**
   * Optional resolved columns for reports whose projection depends on
   * database state (for example a giving-type pivot). Static reports
   * continue to use `ReportSpec.columns(filters)`.
   */
  columns?: ReportColumn[];
  /** Per-currency money totals. Always grouped by currency. */
  subtotals?: CurrencySubtotal[];
  /** Optional supplementary structured payload (e.g. statement header). */
  meta?: Record<string, unknown>;
}

/**
 * Spec for one report. `F` is the validated filter shape; `R` is one
 * normalised result row. Implementations live in
 * `packages/api/src/services/reports/<report-id>.ts` and are
 * registered in `registry.ts`.
 */
export interface ReportSpec<F, R, S extends ZodTypeAny = ZodTypeAny> {
  id: string;
  /** Human label used in the report picker. */
  title: string;
  /** One-line summary for the picker / docs. */
  description: string;
  /** Zod schema that validates + coerces query params. */
  filtersSchema: S;
  /** Pull rows + subtotals for the given filters. */
  fetch(
    database: Database,
    ctx: AuthorizedContext,
    filters: F,
  ): Promise<ReportFetchResult<R>>;
  /** Columns. May depend on filters (e.g. PIVOT reports). */
  columns(filters: F): ReportColumn[];
  /**
   * Human-readable one-line summary of the active filters, stamped
   * onto Excel + PDF headers. Optional — the route layer falls back
   * to a generic key-value join when omitted. Spec authors override
   * for friendlier output (e.g. "Period 2025-01-01 → 2025-12-31
   * • Chapter Trinity" instead of "dateFrom: 2025-01-01 • …").
   */
  filterSummary?(filters: F): string;
  /** Render to Excel. */
  excel(
    rows: R[],
    subtotals: CurrencySubtotal[] | undefined,
    filters: F,
    branding: ReportBranding,
    extras?: ReportFetchResult<R>["meta"],
  ): Promise<Uint8Array>;
  /**
   * Render to PDF. Optional — reports that omit this fall through to
   * the generic branded-table renderer in `pdf/branded-table.ts`,
   * which produces a respectable letter-format PDF for any tabular
   * report. Override only when the report needs a bespoke layout
   * (e.g. a letter-style member statement once that ships).
   *
   * Receives the resolved column projection so a bespoke renderer
   * doesn't have to re-derive it from `filters`.
   */
  pdf?(
    rows: R[],
    subtotals: CurrencySubtotal[] | undefined,
    filters: F,
    branding: ReportBranding,
    columns: ReportColumn[],
    extras?: ReportFetchResult<R>["meta"],
  ): Promise<Uint8Array>;
  /**
   * Optional supplementary access-check on top of the registry's
   * read-roles gate. Returns null on allow, an error code on deny.
   * Used e.g. by `member-statement` to allow chapter-treasurers to
   * pull statements only for members in their chapters.
   */
  accessCheck?: (ctx: AuthorizedContext, filters: F) => string | null;
}

/**
 * Validate filter input against a spec's schema. Centralised so the
 * route layer and the in-process renderer (export endpoint) share one
 * validation path.
 */
export function parseReportFilters<F, R>(
  spec: ReportSpec<F, R>,
  raw: unknown,
): F {
  const parsed = (spec.filtersSchema as ZodTypeAny).safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid filters";
    throw new ReportError("invalid_filters", message);
  }
  return parsed.data as F;
}

/** Service-layer error envelope. Route layer maps codes → HTTP status. */
export class ReportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Map a report error code to an HTTP status. */
export function reportErrorStatus(code: string): 400 | 403 | 404 | 422 | 500 {
  switch (code) {
    case "invalid_filters":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "unprocessable":
      return 422;
    default:
      return 500;
  }
}

/** Re-export Zod inferred helper for spec authors. */
export type FiltersFrom<Schema extends z.ZodTypeAny> = z.infer<Schema>;
