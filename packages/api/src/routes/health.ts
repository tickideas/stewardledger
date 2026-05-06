// packages/api/src/routes/health.ts
// Liveness/readiness/db health endpoints.

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { APP_VERSION, BRAND_WORDMARK } from "@stewardledger/shared";
import { db } from "../db";

export const healthRouter = new Hono();

healthRouter.get("/live", (c) =>
  c.json({ status: "ok", service: "stewardledger-api", version: APP_VERSION, brand: BRAND_WORDMARK }),
);

healthRouter.get("/ready", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ status: "ready" });
  } catch (err) {
    return c.json({ status: "not_ready", error: String(err) }, 503);
  }
});

healthRouter.get("/db", async (c) => {
  const start = Date.now();
  await db.execute(sql`select 1`);
  return c.json({ status: "ok", ms: Date.now() - start });
});
