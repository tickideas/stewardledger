// packages/api/src/services/reports/registry.ts
// Phase 7 — central registry of reports. Adding a new report means
// implementing a `ReportSpec` and pushing it here.

import { importReconciliationReport } from "./import-reconciliation";
import { memberListReport } from "./member-list";
import { memberStatementReport } from "./member-statement";
import { ReportError, type ReportSpec } from "./types";

/**
 * The registry is keyed by `id`. Specs use untyped generics here so a
 * heterogeneous map of `ReportSpec<unknown, unknown>` compiles; each
 * spec is read back via `getReport(id)` which preserves its concrete
 * filter / row types at the call site.
 */
const REGISTRY: Array<ReportSpec<unknown, unknown>> = [
  memberStatementReport as unknown as ReportSpec<unknown, unknown>,
  importReconciliationReport as unknown as ReportSpec<unknown, unknown>,
  memberListReport as unknown as ReportSpec<unknown, unknown>,
];

const REGISTRY_BY_ID = new Map<string, ReportSpec<unknown, unknown>>(
  REGISTRY.map((spec) => [spec.id, spec]),
);

export interface ReportSummary {
  id: string;
  title: string;
  description: string;
}

/** List every registered report. Used by the picker. */
export function listReports(): ReportSummary[] {
  return REGISTRY.map((spec) => ({
    id: spec.id,
    title: spec.title,
    description: spec.description,
  }));
}

/** Throws `ReportError("not_found")` if the id is unknown. */
export function getReport<F = unknown, R = unknown>(id: string): ReportSpec<F, R> {
  const spec = REGISTRY_BY_ID.get(id);
  if (!spec) throw new ReportError("not_found", `Report '${id}' is not registered.`);
  return spec as unknown as ReportSpec<F, R>;
}
