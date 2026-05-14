// packages/api/src/routes/tenant-targets.ts
// Phase 8 — financial targets per (zone, chapter?, giving_type,
// ministry_year). Endpoints:
//
//   GET    /api/tenant/targets         list targets in scope
//   POST   /api/tenant/targets         create
//   PATCH  /api/tenant/targets/:id     update money + count fields
//   DELETE /api/tenant/targets/:id     hard delete (audited)
//
// Access:
//  • READ: any zone reader + any chapter reader (chapter rows clamped
//    to bound chapters; zone-wide rows (chapter_id IS NULL) always
//    visible to chapter readers).
//  • WRITE: zone finance admin / zone admin / zone owner for any
//    target; chapter admin for chapter-scoped targets on their bound
//    chapters only. Treasurers can't set targets — that's a policy
//    decision, not a posting one.
// RELEVANT FILES: packages/db/src/schema/targets.ts, packages/shared/src/schemas.ts, packages/api/src/routes/tenant-giving-common.ts

import { zValidator } from "@hono/zod-validator";
import {
  CHAPTER_ROLES,
  financialTargetCreateSchema,
  financialTargetListQuerySchema,
  financialTargetUpdateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import {
  chapters,
  financialTargets,
  givingTypes,
  ministryYears,
} from "@stewardledger/db/schema";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { writeAudit } from "../services/audit";
import {
  CHAPTER_GIVING_READ_ROLES,
  conflict,
  forbidden,
  GIVING_WRITE_ROLES,
  isUniqueViolation,
  updateValues,
  ZONE_GIVING_READ_ROLES,
} from "./tenant-giving-common";

export const tenantTargetsRouter = new Hono();

function hasChapterRole(ctx: AuthorizedContext, roles: readonly string[]): boolean {
  return ctx.roleCodes.some((code) => roles.includes(code));
}

function hasZoneTargetRead(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...ZONE_GIVING_READ_ROLES);
}

function hasChapterTargetRead(ctx: AuthorizedContext): boolean {
  return hasChapterRole(ctx, CHAPTER_GIVING_READ_ROLES);
}

function hasZoneTargetWrite(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...GIVING_WRITE_ROLES);
}

/** Chapter admin is the only chapter-tier role with target-write rights. */
function hasChapterTargetWrite(ctx: AuthorizedContext): boolean {
  return hasChapterRole(ctx, [CHAPTER_ROLES.CHAPTER_ADMIN]);
}

function canWriteTarget(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneTargetWrite(ctx)) return true;
  // Chapter admin can write chapter-scoped targets on their bound
  // chapters. Zone-wide targets (chapter_id null) are zone-policy and
  // gated above.
  return (
    chapterId !== null &&
    hasChapterTargetWrite(ctx) &&
    ctx.chapterIds.includes(chapterId)
  );
}

async function ensureChapterInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.zoneId, zoneId), eq(chapters.id, id), isNull(chapters.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

async function ensureGivingTypeInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: givingTypes.id })
    .from(givingTypes)
    .where(and(eq(givingTypes.zoneId, zoneId), eq(givingTypes.id, id)))
    .limit(1);
  return rows.length > 0;
}

async function ensureMinistryYearInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: ministryYears.id })
    .from(ministryYears)
    .where(and(eq(ministryYears.zoneId, zoneId), eq(ministryYears.id, id)))
    .limit(1);
  return rows.length > 0;
}

tenantTargetsRouter.get(
  "/targets",
  zValidator("query", financialTargetListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneTargetRead(ctx) && !hasChapterTargetRead(ctx)) return forbidden(c);
    const query = c.req.valid("query");
    const conditions = [eq(financialTargets.zoneId, ctx.zoneId)];

    if (hasZoneTargetRead(ctx)) {
      if (query.chapterId) {
        conditions.push(eq(financialTargets.chapterId, query.chapterId));
      } else if (query.zoneWideOnly) {
        conditions.push(isNull(financialTargets.chapterId));
      }
    } else {
      // Chapter readers see their chapters' rows + zone-wide rows
      // (chapter_id is null). An explicit out-of-scope chapter
      // filter is denied; an explicit in-scope chapter filter is
      // honoured.
      if (query.chapterId && !ctx.chapterIds.includes(query.chapterId)) {
        return forbidden(c);
      }
      if (query.chapterId) {
        conditions.push(eq(financialTargets.chapterId, query.chapterId));
      } else if (query.zoneWideOnly) {
        conditions.push(isNull(financialTargets.chapterId));
      } else if (ctx.chapterIds.length === 0) {
        // Bound to no chapters \u2014 only zone-wide rows are visible.
        conditions.push(isNull(financialTargets.chapterId));
      } else {
        conditions.push(
          or(
            isNull(financialTargets.chapterId),
            inArray(financialTargets.chapterId, ctx.chapterIds),
          )!,
        );
      }
    }
    if (query.givingTypeId) {
      conditions.push(eq(financialTargets.givingTypeId, query.givingTypeId));
    }
    if (query.ministryYearId) {
      conditions.push(eq(financialTargets.ministryYearId, query.ministryYearId));
    }

    const rows = await db
      .select()
      .from(financialTargets)
      .where(and(...conditions))
      .orderBy(
        sql`${financialTargets.chapterId} asc nulls first`,
        asc(financialTargets.givingTypeId),
      )
      .limit(query.limit)
      .offset(query.offset);
    return c.json({ items: rows, limit: query.limit, offset: query.offset });
  },
);

tenantTargetsRouter.post(
  "/targets",
  zValidator("json", financialTargetCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneTargetWrite(ctx) && !hasChapterTargetWrite(ctx)) return forbidden(c);
    const input = c.req.valid("json");
    const chapterId = input.chapterId ?? null;
    if (!canWriteTarget(ctx, chapterId)) return forbidden(c);

    if (chapterId && !(await ensureChapterInZone(ctx.zoneId, chapterId))) {
      return c.json(
        { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
        404,
      );
    }
    if (!(await ensureGivingTypeInZone(ctx.zoneId, input.givingTypeId))) {
      return c.json(
        { error: { code: "giving_type_not_found", message: "Giving type not in this zone" } },
        404,
      );
    }
    if (!(await ensureMinistryYearInZone(ctx.zoneId, input.ministryYearId))) {
      return c.json(
        { error: { code: "ministry_year_not_found", message: "Ministry year not in this zone" } },
        404,
      );
    }

    try {
      const [row] = await db
        .insert(financialTargets)
        .values({
          zoneId: ctx.zoneId,
          chapterId,
          givingTypeId: input.givingTypeId,
          ministryYearId: input.ministryYearId,
          fullTarget: input.fullTarget,
          monthlyTarget: input.monthlyTarget ?? null,
          weeklyBreakdown: input.weeklyBreakdown ?? null,
          fullTargetCopies: input.fullTargetCopies ?? null,
          numberOfPartners: input.numberOfPartners ?? null,
          currencyCode: input.currencyCode,
        })
        .returning();
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "target.create",
        entityType: "financial_target",
        entityId: row.id,
        after: row,
      });
      return c.json({ target: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return conflict(
          c,
          "target_exists",
          "A target already exists for this chapter / giving type / ministry year.",
        );
      }
      throw err;
    }
  },
);

tenantTargetsRouter.patch(
  "/targets/:id",
  zValidator("json", financialTargetUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneTargetWrite(ctx) && !hasChapterTargetWrite(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");

    const [existing] = await db
      .select({ id: financialTargets.id, chapterId: financialTargets.chapterId })
      .from(financialTargets)
      .where(and(eq(financialTargets.id, id), eq(financialTargets.zoneId, ctx.zoneId)))
      .limit(1);
    if (!existing) {
      return c.json({ error: { code: "not_found", message: "Target not found" } }, 404);
    }
    if (!canWriteTarget(ctx, existing.chapterId)) return forbidden(c);

    const [row] = await db
      .update(financialTargets)
      .set(updateValues(input))
      .where(and(eq(financialTargets.id, id), eq(financialTargets.zoneId, ctx.zoneId)))
      .returning();
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "target.update",
      entityType: "financial_target",
      entityId: row.id,
      after: input,
    });
    return c.json({ target: row });
  },
);

tenantTargetsRouter.delete("/targets/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneTargetWrite(ctx) && !hasChapterTargetWrite(ctx)) return forbidden(c);
  const id = c.req.param("id");

  const [existing] = await db
    .select()
    .from(financialTargets)
    .where(and(eq(financialTargets.id, id), eq(financialTargets.zoneId, ctx.zoneId)))
    .limit(1);
  if (!existing) {
    return c.json({ error: { code: "not_found", message: "Target not found" } }, 404);
  }
  if (!canWriteTarget(ctx, existing.chapterId)) return forbidden(c);

  await db
    .delete(financialTargets)
    .where(and(eq(financialTargets.id, id), eq(financialTargets.zoneId, ctx.zoneId)));
  await writeAudit(db, {
    zoneId: ctx.zoneId,
    actorUserId: ctx.userId,
    action: "target.delete",
    entityType: "financial_target",
    entityId: id,
    before: existing,
  });
  return c.json({ deleted: true });
});
