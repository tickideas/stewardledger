// packages/api/src/routes/tenant-dashboard.ts
// Phase 7 — dashboard endpoints. Mounted onto tenantRouter.
//
// GET /api/tenant/dashboard/zone — zone-wide stats payload for the
// /zone/dashboard surface (REPORTS.md §2.15).
//
// Access mirrors the reports gate: any zone reader can hit this
// endpoint. Chapter-only callers are denied — the dashboard is
// zone-wide by intent; chapter-scoped users have the chapter
// dashboard (queued separately).

import { Hono } from "hono";
import type { AuthorizedContext } from "@stewardledger/shared";
import { db } from "../db";
import { hasAnyZoneRole } from "../services/reports/access";
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
