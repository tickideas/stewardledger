// packages/api/src/routes/tenant-reports.ts
// Phase 7 — tenant-scoped reports endpoints. Mounted onto tenantRouter.
//
// GET  /api/tenant/reports                   list registered reports
// GET  /api/tenant/reports/:id/data          fetch rows + per-currency subtotals
// GET  /api/tenant/reports/:id/export.xlsx   download Excel artefact
//
// Filters arrive as query params (`q.<key>=value`) so a treasurer can
// bookmark a URL and re-run the same report without re-keying. Per-spec
// `accessCheck` runs after the registry-level read/export gate.

import { Hono } from "hono";
import type { AuthorizedContext } from "@stewardledger/shared";
import { db } from "../db";
import {
  canExportReports,
  canReadReports,
} from "../services/reports/access";
import { loadReportBranding } from "../services/reports/branding";
import { getReport, listReports } from "../services/reports/registry";
import {
  parseReportFilters,
  ReportError,
  reportErrorStatus,
  type ReportSpec,
} from "../services/reports/types";

export const tenantReportsRouter = new Hono();

function forbidden(c: { json: (b: unknown, s: number) => Response }, code = "forbidden", msg = "Insufficient role"): Response {
  return c.json({ error: { code, message: msg } }, 403);
}

function handleError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ReportError) {
    return c.json({ error: { code: err.code, message: err.message } }, reportErrorStatus(err.code));
  }
  throw err;
}

/**
 * Convert the request's query string to a plain object. Hono's
 * `c.req.query()` (zero-arg) returns last-value-wins for repeated
 * keys; multi-valued filters will need `c.req.queries()` once a
 * report (e.g. a giving-type pivot) actually needs them. Until then
 * we keep the simpler shape and the per-spec schema is the contract.
 */
function flatQuery(c: { req: { query: () => Record<string, string> } }): Record<string, string> {
  return c.req.query();
}

/**
 * Common response headers: never cache report payloads. Both the
 * `/data` JSON envelope and the `/export.xlsx` artefact carry tenant
 * PII, so a shared proxy or browser bfcache could leak them across
 * users or zone slugs. `Cache-Control: no-store` is the strongest
 * available directive (`private, max-age=0` permits some bfcache).
 */
const NO_STORE = "no-store";

tenantReportsRouter.get("/reports", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!canReadReports(ctx)) return forbidden(c);
  return c.json({ items: listReports() });
});

tenantReportsRouter.get("/reports/:id/data", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!canReadReports(ctx)) return forbidden(c);
  const id = c.req.param("id");
  let spec: ReportSpec<unknown, unknown>;
  try {
    spec = getReport(id);
  } catch (err) {
    return handleError(c, err);
  }

  let filters: unknown;
  try {
    filters = parseReportFilters(spec, flatQuery(c));
  } catch (err) {
    return handleError(c, err);
  }

  if (spec.accessCheck) {
    const denial = spec.accessCheck(ctx, filters);
    if (denial) return forbidden(c, denial);
  }

  try {
    const result = await spec.fetch(db, ctx, filters);
    c.header("cache-control", NO_STORE);
    return c.json({
      reportId: id,
      filters,
      columns: spec.columns(filters),
      rows: result.rows,
      subtotals: result.subtotals ?? [],
      meta: result.meta ?? null,
    });
  } catch (err) {
    return handleError(c, err);
  }
});

tenantReportsRouter.get("/reports/:id/export.xlsx", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  // Read AND export gates: viewers can read on screen but not export PII.
  if (!canReadReports(ctx)) return forbidden(c);
  if (!canExportReports(ctx))
    return forbidden(c, "forbidden_export", "Export requires a finance role");

  const id = c.req.param("id");
  let spec: ReportSpec<unknown, unknown>;
  try {
    spec = getReport(id);
  } catch (err) {
    return handleError(c, err);
  }

  let filters: unknown;
  try {
    filters = parseReportFilters(spec, flatQuery(c));
  } catch (err) {
    return handleError(c, err);
  }

  if (spec.accessCheck) {
    const denial = spec.accessCheck(ctx, filters);
    if (denial) return forbidden(c, denial);
  }

  try {
    const [branding, result] = await Promise.all([
      loadReportBranding(db, ctx.zoneId),
      spec.fetch(db, ctx, filters),
    ]);
    const bytes = await spec.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
      result.meta,
    );
    const filename = buildExportFilename(id, branding.zoneSlug);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": NO_STORE,
      },
    });
  } catch (err) {
    return handleError(c, err);
  }
});

function buildExportFilename(reportId: string, zoneSlug: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${zoneSlug}-${reportId}-${ts}.xlsx`;
}
