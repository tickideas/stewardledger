// packages/api/src/routes/tenant-zones.ts
// Tenant-scoped zone settings: groups_enabled toggle + retention policy.
// Service layer owns invariants; this is HTTP wiring.
// RELEVANT FILES: ../services/groups.ts, ../services/retention/policy.ts, packages/db/src/schema/zones.ts

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import {
  type AuthorizedContext,
  ZONE_ROLES,
  zoneEnableGroupsSchema,
  zoneRetentionPolicySchema,
} from "@stewardledger/shared";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { enableGroupsForZone, GroupsEnableBlockedError } from "../services/groups";
import {
  loadRetentionPolicy,
  RetentionPolicyError,
  updateRetentionPolicy,
} from "../services/retention/policy";

export const tenantZonesRouter = new Hono();

function forbidden(c: Context, message = "Zone owner required") {
  return c.json({ error: { code: "forbidden", message } }, 403);
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

// ---------------------------------------------------------------------------
// Retention policy (Phase 9)
// ---------------------------------------------------------------------------
//
// Reads are open to every admin-tier zone role (owner / admin / finance /
// auditor). Writes are owner-only — retention controls sit at the same
// gravity as MFA enforcement and zone decommission.

const RETENTION_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
] as const;

tenantZonesRouter.get("/zones/retention-policy", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...RETENTION_READ_ROLES)) {
    return forbidden(c, "Retention policy is admin-only");
  }
  try {
    const policy = await loadRetentionPolicy(db, ctx.zoneId);
    return c.json({ policy });
  } catch (e) {
    if (e instanceof RetentionPolicyError) {
      return c.json({ error: { code: e.code, message: e.message } }, 404);
    }
    throw e;
  }
});

tenantZonesRouter.put(
  "/zones/retention-policy",
  zValidator("json", zoneRetentionPolicySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)) return forbidden(c);
    try {
      const policy = await updateRetentionPolicy(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        policy: c.req.valid("json"),
      });
      return c.json({ policy });
    } catch (e) {
      if (e instanceof RetentionPolicyError) {
        return c.json({ error: { code: e.code, message: e.message } }, 404);
      }
      throw e;
    }
  },
);
