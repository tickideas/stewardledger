// packages/api/src/routes/tenant-giving-events.ts
// Service event setup routes with giving-period derivation.

import { zValidator } from "@hono/zod-validator";
import {
  serviceEventCreateSchema,
  serviceEventListQuerySchema,
  serviceEventUpdateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { Hono } from "hono";
import { chapters, serviceEvents, serviceTypes } from "@stewardledger/db/schema";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { writeAudit } from "../services/audit";
import { deriveGivingPeriodForDate } from "../services/period-seed";
import {
  CHAPTER_GIVING_READ_ROLES,
  CHAPTER_GIVING_WRITE_ROLES,
  GIVING_WRITE_ROLES,
  ZONE_GIVING_READ_ROLES,
  forbidden,
  updateValues,
} from "./tenant-giving-common";

export const tenantGivingEventsRouter = new Hono();

function hasChapterRole(ctx: AuthorizedContext, roles: readonly string[]): boolean {
  return ctx.roleCodes.some((code) => roles.includes(code));
}

function hasZoneEventRead(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...ZONE_GIVING_READ_ROLES);
}

function hasChapterEventRead(ctx: AuthorizedContext): boolean {
  return hasChapterRole(ctx, CHAPTER_GIVING_READ_ROLES);
}

function hasZoneEventWrite(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...GIVING_WRITE_ROLES);
}

function hasChapterEventWrite(ctx: AuthorizedContext): boolean {
  return hasChapterRole(ctx, CHAPTER_GIVING_WRITE_ROLES);
}

function canReadEvent(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneEventRead(ctx)) return true;
  return hasChapterEventRead(ctx) && (chapterId === null || ctx.chapterIds.includes(chapterId));
}

function canWriteEvent(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneEventWrite(ctx)) return true;
  return chapterId !== null && hasChapterEventWrite(ctx) && ctx.chapterIds.includes(chapterId);
}

async function ensureChapterInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.zoneId, zoneId), eq(chapters.id, id), isNull(chapters.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

async function ensureServiceTypeInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.zoneId, zoneId), eq(serviceTypes.id, id)))
    .limit(1);
  return rows.length > 0;
}

async function givingPeriodIdForDate(zoneId: string, serviceDate: string): Promise<string | null> {
  const period = await deriveGivingPeriodForDate(db, zoneId, serviceDate);
  return period?.id ?? null;
}

tenantGivingEventsRouter.get(
  "/giving/service-events",
  zValidator("query", serviceEventListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneEventRead(ctx) && !hasChapterEventRead(ctx)) return forbidden(c);
    const query = c.req.valid("query");
    const conditions = [eq(serviceEvents.zoneId, ctx.zoneId)];

    if (hasZoneEventRead(ctx)) {
      if (query.chapterId) conditions.push(eq(serviceEvents.chapterId, query.chapterId));
    } else {
      if (ctx.chapterIds.length === 0) {
        return c.json({ items: [], limit: query.limit, offset: query.offset });
      }
      if (query.chapterId && !ctx.chapterIds.includes(query.chapterId)) return forbidden(c);
      conditions.push(
        query.chapterId
          ? eq(serviceEvents.chapterId, query.chapterId)
          : or(isNull(serviceEvents.chapterId), inArray(serviceEvents.chapterId, ctx.chapterIds))!,
      );
    }
    if (query.serviceTypeId) conditions.push(eq(serviceEvents.serviceTypeId, query.serviceTypeId));
    if (query.dateFrom) conditions.push(gte(serviceEvents.serviceDate, query.dateFrom));
    if (query.dateTo) conditions.push(lte(serviceEvents.serviceDate, query.dateTo));

    const rows = await db
      .select()
      .from(serviceEvents)
      .where(and(...conditions))
      .orderBy(asc(serviceEvents.serviceDate), asc(serviceEvents.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return c.json({ items: rows, limit: query.limit, offset: query.offset });
  },
);

tenantGivingEventsRouter.post(
  "/giving/service-events",
  zValidator("json", serviceEventCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneEventWrite(ctx) && !hasChapterEventWrite(ctx)) return forbidden(c);
    const input = c.req.valid("json");
    const chapterId = input.chapterId ?? null;
    if (!canWriteEvent(ctx, chapterId)) return forbidden(c);
    if (chapterId && !(await ensureChapterInZone(ctx.zoneId, chapterId))) {
      return c.json({ error: { code: "chapter_not_found", message: "Chapter not in this zone" } }, 404);
    }
    if (!(await ensureServiceTypeInZone(ctx.zoneId, input.serviceTypeId))) {
      return c.json({ error: { code: "service_type_not_found", message: "Service type not in this zone" } }, 404);
    }
    const givingPeriodId = await givingPeriodIdForDate(ctx.zoneId, input.serviceDate);
    if (!givingPeriodId) {
      return c.json({ error: { code: "period_not_seeded", message: "No giving period for serviceDate" } }, 400);
    }

    const [row] = await db
      .insert(serviceEvents)
      .values({
        zoneId: ctx.zoneId,
        chapterId,
        serviceTypeId: input.serviceTypeId,
        serviceDate: input.serviceDate,
        givingPeriodId,
        notes: input.notes ?? null,
      })
      .returning();
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "giving.service_event.create",
      entityType: "service_event",
      entityId: row.id,
      after: row,
    });
    return c.json({ serviceEvent: row }, 201);
  },
);

tenantGivingEventsRouter.patch(
  "/giving/service-events/:id",
  zValidator("json", serviceEventUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneEventWrite(ctx) && !hasChapterEventWrite(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");

    const [existing] = await db
      .select({ id: serviceEvents.id, chapterId: serviceEvents.chapterId, serviceDate: serviceEvents.serviceDate })
      .from(serviceEvents)
      .where(and(eq(serviceEvents.id, id), eq(serviceEvents.zoneId, ctx.zoneId)))
      .limit(1);
    if (!existing || !canWriteEvent(ctx, existing.chapterId)) {
      return c.json({ error: { code: "not_found", message: "Service event not found" } }, 404);
    }

    const nextChapterId = input.chapterId !== undefined ? input.chapterId ?? null : existing.chapterId;
    if (!canWriteEvent(ctx, nextChapterId)) return forbidden(c);
    if (nextChapterId && !(await ensureChapterInZone(ctx.zoneId, nextChapterId))) {
      return c.json({ error: { code: "chapter_not_found", message: "Chapter not in this zone" } }, 404);
    }
    if (input.serviceTypeId && !(await ensureServiceTypeInZone(ctx.zoneId, input.serviceTypeId))) {
      return c.json({ error: { code: "service_type_not_found", message: "Service type not in this zone" } }, 404);
    }

    const nextServiceDate = input.serviceDate ?? existing.serviceDate;
    const givingPeriodId = await givingPeriodIdForDate(ctx.zoneId, nextServiceDate);
    if (!givingPeriodId) {
      return c.json({ error: { code: "period_not_seeded", message: "No giving period for serviceDate" } }, 400);
    }

    const [row] = await db
      .update(serviceEvents)
      .set({
        ...updateValues(input),
        chapterId: nextChapterId,
        givingPeriodId,
      })
      .where(and(eq(serviceEvents.id, id), eq(serviceEvents.zoneId, ctx.zoneId)))
      .returning();
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "giving.service_event.update",
      entityType: "service_event",
      entityId: row.id,
      after: input,
    });
    return c.json({ serviceEvent: row });
  },
);
