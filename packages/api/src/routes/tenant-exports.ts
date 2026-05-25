// packages/api/src/routes/tenant-exports.ts
// Phase 9 §3 — owner-only per-zone export bundle endpoints.
//
//   POST   /api/tenant/zones/exports          enqueue a new bundle
//   GET    /api/tenant/zones/exports          list recent bundles
//   GET    /api/tenant/zones/exports/:id/download   stream the artefact
//
// All three are `zone_owner`-only. Even `zone_admin` can't pull a
// full data export — this is the highest-blast-radius single
// action in the product. The 24h-per-zone rate limit is enforced
// in `services/exports/jobs.ts:queueExport`; this layer only owns
// the HTTP wiring + the response envelope.
//
// RELEVANT FILES: ../services/exports/jobs.ts, ./tenant.ts

import type { Context } from "hono";
import { Hono } from "hono";
import {
  type AuthorizedContext,
  ZONE_ROLES,
} from "@stewardledger/shared";
import { db } from "../db";
import { log } from "../logger";
import { hasAnyRole } from "../middleware/auth";
import { storage } from "../services/storage";
import {
  ExportJobError,
  getExportForZone,
  listExports,
  queueExportJob,
  toSummary,
} from "../services/exports/jobs";

export const tenantExportsRouter = new Hono();

const NO_STORE = "no-store, max-age=0";

function forbidden(c: Context, message = "Zone owner required") {
  return c.json({ error: { code: "forbidden", message } }, 403);
}

function notFound(c: Context, message = "Export not found") {
  return c.json({ error: { code: "not_found", message } }, 404);
}

/**
 * Enqueue a new bundle. Returns the freshly-persisted row. 429 when
 * the per-zone 24h cooldown is in effect (details include the
 * cooldown end + the existing export id so the UI can deep-link).
 */
tenantExportsRouter.post("/zones/exports", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)) return forbidden(c);
  try {
    const summary = await queueExportJob(db, {
      zoneId: ctx.zoneId,
      requestedByUserId: ctx.userId,
    });
    c.header("cache-control", NO_STORE);
    return c.json({ export: summary }, 202);
  } catch (e) {
    if (e instanceof ExportJobError && e.code === "rate_limited") {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: e.message,
            details: e.details ?? {},
          },
        },
        429,
      );
    }
    throw e;
  }
});

/** Recent bundles for the caller's zone, newest first. */
tenantExportsRouter.get("/zones/exports", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)) return forbidden(c);
  // `?limit=banana` would silently become `NaN` and propagate to
  // Drizzle as an undefined .limit() argument. Validate up-front.
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "invalid") {
    return c.json(
      {
        error: {
          code: "invalid_query",
          message: "limit must be a positive integer between 1 and 100",
        },
      },
      400,
    );
  }
  const exports = await listExports(db, ctx.zoneId, {
    limit: limit ?? undefined,
  });
  c.header("cache-control", NO_STORE);
  return c.json({ exports });
});

/**
 * Parse the `?limit` query param.
 *
 *   - missing                  → undefined (service uses its default)
 *   - integer in [1, 100]      → the integer
 *   - anything else            → the literal string "invalid"
 *     (sentinel so the route can 400 without conflating with the
 *     legitimate undefined case)
 */
function parseLimit(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) return "invalid";
  return n;
}

/**
 * Stream the gzipped bundle. 404 when the row doesn't belong to
 * the caller's zone (so cross-zone probes look identical to
 * "not found"), 410 when the bundle has expired, 409 when not yet
 * completed.
 */
tenantExportsRouter.get("/zones/exports/:exportId/download", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)) return forbidden(c);
  const row = await getExportForZone(
    db,
    ctx.zoneId,
    c.req.param("exportId"),
  );
  if (!row) return notFound(c);
  if (row.status === "expired") {
    return c.json(
      { error: { code: "expired", message: "Bundle has expired" } },
      410,
    );
  }
  if (row.status !== "completed" || !row.storageKey) {
    return c.json(
      {
        error: {
          code: "not_ready",
          message: `Bundle is ${row.status}`,
        },
      },
      409,
    );
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return c.json(
      { error: { code: "expired", message: "Bundle has expired" } },
      410,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await storage().get(row.storageKey);
  } catch (err) {
    // Blob is gone even though the row says `completed`. Most
    // likely an out-of-band cleanup ran ahead of the row's expiry.
    // Surface as 410 rather than 500 so the UI can render
    // "expired".
    log.warn(
      {
        err,
        exportId: row.id,
        storageKey: row.storageKey,
        zoneId: ctx.zoneId,
      },
      "zone export download: artefact missing from storage",
    );
    return c.json(
      {
        error: {
          code: "artefact_missing",
          message: "Bundle is no longer available",
        },
      },
      410,
    );
  }
  // Defensive: `zones.id` and `zone_exports.id` are `text` columns,
  // not `uuid`. Today they're defaulted to `crypto.randomUUID()`,
  // but a SQL-edited zone id with a `"` could otherwise inject a
  // header value. Filter to the UUID alphabet at the rendering site
  // so the header stays well-formed regardless of upstream drift.
  const filename = safeBundleFilename(ctx.zoneId, row.id);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": NO_STORE,
    },
  });
});

function safeBundleFilename(zoneId: string, exportId: string): string {
  const safeZone = zoneId.replace(/[^a-f0-9-]/gi, "").slice(0, 8) || "zone";
  const safeExport =
    exportId.replace(/[^a-f0-9-]/gi, "").slice(0, 8) || "export";
  return `zone-export-${safeZone}-${safeExport}.tar.gz`;
}

// Re-export `toSummary` so the test layer can build expectation
// objects from a directly-inserted row without round-tripping
// through the JSON serializer.
export { toSummary };
