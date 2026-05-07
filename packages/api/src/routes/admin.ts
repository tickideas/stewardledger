// packages/api/src/routes/admin.ts
// Platform-admin API. Mounted on the API host (apex / api subdomain).
// Guarded by requireSession + requirePlatformRole. Cross-zone reads are allowed
// here and ONLY here. Every write is audited.

import { zValidator } from "@hono/zod-validator";
import {
  PLATFORM_ROLES,
  regionCreateSchema,
  regionPromoteSchema,
  regionUpdateSchema,
} from "@stewardledger/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { chapters, regions, zones } from "@stewardledger/db/schema";
import { db } from "../db";
import {
  requirePlatformRole,
  requireSession,
  type SessionUser,
} from "../middleware/auth";
import { writeAudit } from "../services/audit";
import { assertNameAvailable, NameTakenError } from "../services/names";

export const adminRouter = new Hono();

adminRouter.use(
  "*",
  requireSession,
  requirePlatformRole(PLATFORM_ROLES.SUPER_ADMIN, PLATFORM_ROLES.REGION_CURATOR),
);

// ─── Regions CRUD ─────────────────────────────────────────────────────

adminRouter.get("/regions", async (c) => {
  const rows = await db
    .select({
      id: regions.id,
      name: regions.name,
      shortCode: regions.shortCode,
      countryCode: regions.countryCode,
      isActive: regions.isActive,
      createdAt: regions.createdAt,
    })
    .from(regions)
    .orderBy(asc(regions.name));
  return c.json({ items: rows });
});

adminRouter.post("/regions", zValidator("json", regionCreateSchema), async (c) => {
  const user = c.get("user") as SessionUser;
  const input = c.req.valid("json");
  try {
    await assertNameAvailable(db, input.name);
  } catch (err) {
    if (err instanceof NameTakenError)
      return c.json({ error: { code: err.code, message: err.message } }, 409);
    throw err;
  }
  const [row] = await db
    .insert(regions)
    .values({
      name: input.name,
      shortCode: input.shortCode ?? null,
      countryCode: input.countryCode ?? null,
      createdByUserId: user.id,
    })
    .returning();
  return c.json({ region: row }, 201);
});

adminRouter.patch("/regions/:id", zValidator("json", regionUpdateSchema), async (c) => {
  const id = c.req.param("id");
  const input = c.req.valid("json");
  if (input.name) {
    try {
      await assertNameAvailable(db, input.name, { ignoreRegionId: id });
    } catch (err) {
      if (err instanceof NameTakenError)
        return c.json({ error: { code: err.code, message: err.message } }, 409);
      throw err;
    }
  }
  const [row] = await db
    .update(regions)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.shortCode !== undefined && { shortCode: input.shortCode }),
      ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(regions.id, id))
    .returning();
  if (!row) return c.json({ error: { code: "not_found", message: "Region not found" } }, 404);
  return c.json({ region: row });
});

// ─── Unverified-region inbox ──────────────────────────────────────────

/** Zones whose region is still a free-text submission awaiting curation. */
adminRouter.get("/regions/inbox", async (c) => {
  const rows = await db
    .select({
      zoneId: zones.id,
      zoneSlug: zones.slug,
      zoneName: zones.name,
      countryCode: zones.countryCode,
      regionNameUnverified: zones.regionNameUnverified,
      createdAt: zones.createdAt,
    })
    .from(zones)
    .where(and(isNull(zones.regionId), sql`${zones.regionNameUnverified} is not null`))
    .orderBy(desc(zones.createdAt));
  return c.json({ items: rows });
});

/**
 * Promote a free-text region into the curated `regions` table and re-target
 * one or more zones onto it. Either pass `regionId` (existing region) or
 * `regionDraft` (creates a new region in the same transaction).
 *
 * On success: updates each target zone's region_id, clears
 * region_name_unverified, fans out the denormalized region_id onto every
 * chapter row in those zones, and emits one audit event per zone.
 */
adminRouter.post("/regions/promote", zValidator("json", regionPromoteSchema), async (c) => {
  const user = c.get("user") as SessionUser;
  const input = c.req.valid("json");

  const result = await db.transaction(async (tx) => {
    let regionId: string;
    if (input.regionId) {
      const [region] = await tx
        .select({ id: regions.id, isActive: regions.isActive })
        .from(regions)
        .where(eq(regions.id, input.regionId))
        .limit(1);
      if (!region || !region.isActive) {
        throw new PromoteError("region_not_found", "Region not found or inactive.");
      }
      regionId = region.id;
    } else if (input.regionDraft) {
      try {
        await assertNameAvailable(tx, input.regionDraft.name);
      } catch (err) {
        if (err instanceof NameTakenError) throw new PromoteError(err.code, err.message);
        throw err;
      }
      const [created] = await tx
        .insert(regions)
        .values({
          name: input.regionDraft.name,
          shortCode: input.regionDraft.shortCode ?? null,
          countryCode: input.regionDraft.countryCode ?? null,
          createdByUserId: user.id,
        })
        .returning({ id: regions.id });
      regionId = created.id;
    } else {
      throw new PromoteError("invalid_input", "regionId or regionDraft is required.");
    }

    // Lock + load target zones; ensure they're all currently in the inbox.
    const targets = await tx
      .select({
        id: zones.id,
        regionNameUnverified: zones.regionNameUnverified,
        regionId: zones.regionId,
      })
      .from(zones)
      .where(inArray(zones.id, input.zoneIds));

    if (targets.length !== input.zoneIds.length) {
      throw new PromoteError("zone_not_found", "One or more zones do not exist.");
    }
    for (const z of targets) {
      if (z.regionId !== null || z.regionNameUnverified === null) {
        throw new PromoteError(
          "zone_not_unverified",
          `Zone ${z.id} is not awaiting region curation.`,
        );
      }
    }

    await tx
      .update(zones)
      .set({ regionId, regionNameUnverified: null, updatedAt: new Date() })
      .where(inArray(zones.id, input.zoneIds));

    // Fan out denormalized region_id to chapters.
    await tx
      .update(chapters)
      .set({ regionId, updatedAt: new Date() })
      .where(inArray(chapters.zoneId, input.zoneIds));

    for (const zoneId of input.zoneIds) {
      await writeAudit(tx, {
        zoneId,
        actorUserId: user.id,
        actorRoleCode: PLATFORM_ROLES.REGION_CURATOR,
        action: "region.promote",
        entityType: "zone",
        entityId: zoneId,
        after: { regionId },
      });
    }

    return { regionId, zoneIds: input.zoneIds };
  }).catch((err) => {
    if (err instanceof PromoteError) return err;
    throw err;
  });

  if (result instanceof PromoteError) {
    return c.json({ error: { code: result.code, message: result.message } }, 409);
  }
  return c.json({ status: "promoted", regionId: result.regionId, zoneIds: result.zoneIds });
});

class PromoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
