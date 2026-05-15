// packages/api/src/routes/tenant-reports.ts
// Phase 7 — tenant-scoped reports endpoints. Mounted onto tenantRouter.
//
// GET    /api/tenant/reports                            list registered reports
// GET    /api/tenant/reports/:id/data                   fetch rows + per-currency subtotals
// GET    /api/tenant/reports/:id/export.xlsx            download Excel artefact
// GET    /api/tenant/reports/:id/export.pdf             download PDF artefact
// GET    /api/tenant/reports/:id/saved-filters          list caller's saved filters
// POST   /api/tenant/reports/:id/saved-filters          create one
// PATCH  /api/tenant/reports/:id/saved-filters/:filterId  rename / replace payload
// DELETE /api/tenant/reports/:id/saved-filters/:filterId  hard delete (audited)
//
// Filters arrive as query params (`q.<key>=value`) so a treasurer can
// bookmark a URL and re-run the same report without re-keying. Per-spec
// `accessCheck` runs after the registry-level read/export gate.

import { zValidator } from "@hono/zod-validator";
import {
  savedReportFilterCreateSchema,
  savedReportFilterUpdateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { Hono } from "hono";
import { db } from "../db";
import {
  canExportReports,
  canReadReports,
} from "../services/reports/access";
import { loadReportBranding } from "../services/reports/branding";
import { renderBrandedTablePdf } from "../services/reports/pdf/branded-table";
import { getReport, listReports } from "../services/reports/registry";
import {
  createSavedFilter,
  deleteSavedFilter,
  listSavedFilters,
  SavedFilterError,
  updateSavedFilter,
} from "../services/reports/saved-filters";
import {
  parseReportFilters,
  ReportError,
  reportErrorStatus,
  type ReportBranding,
  type ReportFetchResult,
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
 * `/data` JSON envelope and the export artefacts carry tenant
 * PII, so a shared proxy or browser bfcache could leak them across
 * users or zone slugs. `Cache-Control: no-store` is the strongest
 * available directive (`private, max-age=0` permits some bfcache).
 */
const NO_STORE = "no-store";

interface ExportContext {
  spec: ReportSpec<unknown, unknown>;
  filters: unknown;
  branding: ReportBranding;
  result: ReportFetchResult<unknown>;
}

/**
 * Shared prelude for the Excel + PDF export handlers. Returns either
 * a successful context or a short-circuit `Response` so the handler
 * can `if (res instanceof Response) return res`. Centralises spec
 * lookup, filter parse, per-spec `accessCheck`, branding load, and
 * data fetch — the two handlers used to duplicate ~50 lines each.
 */
async function prepareExportContext(c: {
  json: (b: unknown, s: number) => Response;
  req: { param: (k: string) => string; query: () => Record<string, string> };
  get: (k: "auth") => AuthorizedContext;
}): Promise<ExportContext | Response> {
  const ctx = c.get("auth");
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
    return { spec, filters, branding, result };
  } catch (err) {
    return handleError(c, err);
  }
}

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
    const columns = result.columns ?? spec.columns(filters);
    c.header("cache-control", NO_STORE);
    return c.json({
      reportId: id,
      filters,
      columns,
      rows: result.rows,
      subtotals: result.subtotals ?? [],
      meta: result.meta ?? null,
    });
  } catch (err) {
    return handleError(c, err);
  }
});

tenantReportsRouter.get("/reports/:id/export.xlsx", async (c) => {
  const prepared = await prepareExportContext(c);
  if (prepared instanceof Response) return prepared;
  const { spec, filters, branding, result } = prepared;
  try {
    const bytes = await spec.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
      result.meta,
    );
    const filename = buildExportFilename(spec.id, branding.zoneSlug, "xlsx");
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

tenantReportsRouter.get("/reports/:id/export.pdf", async (c) => {
  const prepared = await prepareExportContext(c);
  if (prepared instanceof Response) return prepared;
  const { spec, filters, branding, result } = prepared;
  try {
    // Per-spec `pdf()` override is the bespoke-layout escape hatch.
    // Everything else uses the generic branded-table renderer — it
    // matches the Excel renderer's grammar (header, columns, rows,
    // per-currency subtotals).
    const filterSummary = spec.filterSummary
      ? spec.filterSummary(filters)
      : summariseFilters(filters);
    const columns = result.columns ?? spec.columns(filters);
    const bytes = spec.pdf
      ? await spec.pdf(
          result.rows,
          result.subtotals,
          filters,
          branding,
          columns,
          result.meta,
        )
      : await renderBrandedTablePdf({
          reportTitle: spec.title,
          filterSummary,
          columns,
          rows: assertObjectRows(result.rows),
          subtotals: result.subtotals,
          branding,
        });
    const filename = buildExportFilename(spec.id, branding.zoneSlug, "pdf");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": NO_STORE,
      },
    });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── Saved filters ───────────────────────────────────────────

/**
 * Resolve the spec, validate the saved filter's payload against
 * the spec's Zod schema, and surface the canonical error envelope
 * on mismatch. Returns the parsed filters on success; calls the
 * usual `handleError` -> response builder on failure.
 */
function parseSavedFilterPayload(
  spec: ReportSpec<unknown, unknown>,
  filters: unknown,
): { ok: true; filters: unknown } | { ok: false; error: ReportError } {
  try {
    const parsed = parseReportFilters(spec, filters ?? {});
    return { ok: true, filters: parsed };
  } catch (err) {
    if (err instanceof ReportError) return { ok: false, error: err };
    throw err;
  }
}

function savedFilterErrorResponse(
  c: { json: (b: unknown, s: number) => Response },
  err: SavedFilterError,
): Response {
  const status: 404 | 409 = err.code === "not_found" ? 404 : 409;
  return c.json({ error: { code: err.code, message: err.message } }, status);
}

tenantReportsRouter.get("/reports/:id/saved-filters", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!canReadReports(ctx)) return forbidden(c);
  const id = c.req.param("id");
  try {
    // Validate the report id against the registry so a stale
    // report-id (removed from code) returns 404 instead of an
    // empty list that looks confusingly normal.
    getReport(id);
  } catch (err) {
    return handleError(c, err);
  }
  const items = await listSavedFilters(db, {
    zoneId: ctx.zoneId,
    userId: ctx.userId,
    reportId: id,
  });
  c.header("cache-control", NO_STORE);
  return c.json({ items });
});

tenantReportsRouter.post(
  "/reports/:id/saved-filters",
  zValidator("json", savedReportFilterCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!canReadReports(ctx)) return forbidden(c);
    const id = c.req.param("id");
    let spec: ReportSpec<unknown, unknown>;
    try {
      spec = getReport(id);
    } catch (err) {
      return handleError(c, err);
    }
    const input = c.req.valid("json");
    const parsed = parseSavedFilterPayload(spec, input.filters);
    if (!parsed.ok) return handleError(c, parsed.error);
    try {
      const row = await createSavedFilter(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId, reportId: id },
        { name: input.name, filters: parsed.filters },
      );
      return c.json({ savedFilter: row }, 201);
    } catch (err) {
      if (err instanceof SavedFilterError)
        return savedFilterErrorResponse(c, err);
      throw err;
    }
  },
);

tenantReportsRouter.patch(
  "/reports/:id/saved-filters/:filterId",
  zValidator("json", savedReportFilterUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!canReadReports(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const filterId = c.req.param("filterId");
    let spec: ReportSpec<unknown, unknown>;
    try {
      spec = getReport(id);
    } catch (err) {
      return handleError(c, err);
    }
    const input = c.req.valid("json");
    let nextFilters: unknown;
    if (input.filters !== undefined) {
      const parsed = parseSavedFilterPayload(spec, input.filters);
      if (!parsed.ok) return handleError(c, parsed.error);
      nextFilters = parsed.filters;
    }
    try {
      const row = await updateSavedFilter(
        db,
        {
          id: filterId,
          zoneId: ctx.zoneId,
          userId: ctx.userId,
          reportId: id,
        },
        { name: input.name, filters: nextFilters },
      );
      return c.json({ savedFilter: row });
    } catch (err) {
      if (err instanceof SavedFilterError)
        return savedFilterErrorResponse(c, err);
      throw err;
    }
  },
);

tenantReportsRouter.delete(
  "/reports/:id/saved-filters/:filterId",
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!canReadReports(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const filterId = c.req.param("filterId");
    try {
      // Match GET behaviour: validate the report id so a stale
      // call returns 404 here rather than after the DB read.
      getReport(id);
    } catch (err) {
      return handleError(c, err);
    }
    try {
      await deleteSavedFilter(db, {
        id: filterId,
        zoneId: ctx.zoneId,
        userId: ctx.userId,
        reportId: id,
      });
      return c.json({ deleted: true });
    } catch (err) {
      if (err instanceof SavedFilterError)
        return savedFilterErrorResponse(c, err);
      throw err;
    }
  },
);

function buildExportFilename(reportId: string, zoneSlug: string, ext: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${zoneSlug}-${reportId}-${ts}.${ext}`;
}

function summariseFilters(filters: unknown): string {
  if (!filters || typeof filters !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.join("  •  ");
}

/**
 * Narrow `unknown[]` to `Array<Record<string, unknown>>` for the
 * generic PDF renderer. Every shipped report returns plain object
 * rows, but the registry types them as `unknown` for variance
 * reasons; this check fails loudly if a future spec breaks the
 * contract instead of silently producing a malformed PDF.
 */
function assertObjectRows(rows: unknown[]): Array<Record<string, unknown>> {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    throw new Error(
      "Generic PDF renderer requires rows shaped as plain objects; spec returned a non-object row.",
    );
  }
  return rows as Array<Record<string, unknown>>;
}
