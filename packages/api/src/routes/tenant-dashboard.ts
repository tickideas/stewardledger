// packages/api/src/routes/tenant-dashboard.ts
// Phase 7 — dashboard endpoints. Mounted onto tenantRouter.
//
// GET /api/tenant/dashboard/zone               — REPORTS.md §2.15
// GET /api/tenant/dashboard/chapter/:chapterId — REPORTS.md §2.14
//
// Zone dashboard: any zone reader; chapter-only callers denied.
// Chapter dashboard: zone reader can drill into any chapter; chapter
// reader can read their bound chapters only.

import { Hono } from "hono";
import type { AuthorizedContext } from "@stewardledger/shared";
import { db } from "../db";
import { hasAnyZoneRole } from "../services/reports/access";
import {
  buildChapterDashboard,
  ChapterDashboardError,
} from "../services/dashboards/chapter-dashboard";
import { buildZoneDashboard } from "../services/dashboards/zone-dashboard";

export const tenantDashboardRouter = new Hono();

function forbidden(
  c: { json: (b: unknown, s: number) => Response },
  code = "forbidden",
  msg = "Insufficient role",
): Response {
  return c.json({ error: { code, message: msg } }, 403);
}

tenantDashboardRouter.get("/dashboard/zone", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  // Dashboard payload is zone-wide; chapter-only callers don't have
  // a coherent view here.
  if (!hasAnyZoneRole(ctx)) return forbidden(c);
  const payload = await buildZoneDashboard(db, ctx);
  // Payload carries member-level totals; treat as PII for caching
  // purposes and never store in shared caches / bfcache.
  c.header("cache-control", "no-store");
  return c.json(payload);
});

tenantDashboardRouter.get("/dashboard/chapter/:chapterId", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const chapterId = c.req.param("chapterId");
  // Zone-wide readers can drill into any chapter; chapter-only
  // readers must own the chapter via their bindings. Folding the
  // "unknown chapter" case into the same 403 prevents an
  // existence-oracle for chapter-only callers (mirrors the pattern
  // used by member-statement.ts).
  if (!hasAnyZoneRole(ctx) && !ctx.chapterIds.includes(chapterId)) {
    return forbidden(c);
  }
  try {
    const payload = await buildChapterDashboard(db, ctx.zoneId, chapterId);
    c.header("cache-control", "no-store");
    return c.json(payload);
  } catch (err) {
    if (err instanceof ChapterDashboardError && err.code === "chapter_not_found") {
      return c.json({ error: { code: "not_found", message: err.message } }, 404);
    }
    throw err;
  }
});
