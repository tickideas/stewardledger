// packages/api/src/routes/tenant-periods.ts
// Phase 4 / Phase 8 — read-only access to period configurations (ministry
// years, partnership years). UIs for targets / partnership progress need
// these to drive year dropdowns; write paths are deferred until a tenant
// asks for them (Phase 4 seeded the rows at zone creation).
// RELEVANT FILES: packages/db/src/schema/periods.ts, packages/api/src/services/period-seed.ts, packages/web/src/routes/zone/targets/+page.svelte

import { ministryYears, partnershipYears } from "@stewardledger/db/schema";
import type { AuthorizedContext } from "@stewardledger/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { GIVING_READ_ROLES, forbidden } from "./tenant-giving-common";

export const tenantPeriodsRouter = new Hono();

tenantPeriodsRouter.get("/periods/ministry-years", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select({
      id: ministryYears.id,
      yearLabel: ministryYears.yearLabel,
      startDate: ministryYears.startDate,
      endDate: ministryYears.endDate,
    })
    .from(ministryYears)
    .where(eq(ministryYears.zoneId, ctx.zoneId))
    .orderBy(asc(ministryYears.startDate));
  return c.json({ items: rows });
});

tenantPeriodsRouter.get("/periods/partnership-years", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select({
      id: partnershipYears.id,
      yearLabel: partnershipYears.yearLabel,
      startDate: partnershipYears.startDate,
      endDate: partnershipYears.endDate,
    })
    .from(partnershipYears)
    .where(eq(partnershipYears.zoneId, ctx.zoneId))
    .orderBy(asc(partnershipYears.startDate));
  return c.json({ items: rows });
});
