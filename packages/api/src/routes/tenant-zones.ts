// packages/api/src/routes/tenant-zones.ts
// Tenant-scoped zone settings. Currently only the one-way groups_enabled toggle.
// Service layer (../services/groups) owns invariants; this is HTTP wiring.
// RELEVANT FILES: ../services/groups.ts, packages/db/src/schema/zones.ts

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import {
  type AuthorizedContext,
  ZONE_ROLES,
  zoneEnableGroupsSchema,
} from "@stewardledger/shared";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { enableGroupsForZone, GroupsEnableBlockedError } from "../services/groups";

export const tenantZonesRouter = new Hono();

function forbidden(c: Context) {
  return c.json({ error: { code: "forbidden", message: "Zone owner required" } }, 403);
}

tenantZonesRouter.post(
  "/zones/groups-enabled",
  zValidator("json", zoneEnableGroupsSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)) return forbidden(c);
    try {
      await enableGroupsForZone(db, { zoneId: ctx.zoneId, actorUserId: ctx.userId });
    } catch (e) {
      if (e instanceof GroupsEnableBlockedError) {
        return c.json(
          {
            error: {
              code: "groups_enable_blocked",
              message: e.message,
              details: { unassignedChapterIds: e.unassignedChapterIds },
            },
          },
          409,
        );
      }
      throw e;
    }
    return c.json({ status: "enabled" });
  },
);
