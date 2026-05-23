// packages/api/src/routes/tenant-groups.ts
// Group CRUD + chapter-move-group + group-history endpoints.
// Service layer (../services/groups) owns invariants; this is HTTP wiring.
// RELEVANT FILES: ../services/groups.ts, packages/db/src/schema/groups.ts

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import {
  chapterGroupHistory,
  chapters,
  groups,
  zones,
} from "@stewardledger/db/schema";
import {
  type AuthorizedContext,
  chapterMoveGroupSchema,
  groupCreateSchema,
  groupUpdateSchema,
  ZONE_ROLES,
} from "@stewardledger/shared";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole, requireChapterScope } from "../middleware/auth";
import { writeAudit } from "../services/audit";
import {
  assertGroupNameAvailable,
  assertGroupSlugAvailable,
  GroupNameTakenError,
  GroupNotEmptyError,
  GroupNotFoundError,
  GroupsNotEnabledError,
  GroupSlugTakenError,
  HistoryViolationError,
  moveChapterToGroup,
  softDeleteGroup,
} from "../services/groups";

export const tenantGroupsRouter = new Hono();

const ZONE_WRITE = [ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN] as const;

const ZONE_GROUP_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  if (!err || typeof err !== "object") return false;
  const direct = err as { code?: unknown; constraint_name?: unknown; cause?: unknown };
  const cause = direct.cause as { code?: unknown; constraint_name?: unknown } | undefined;
  const code = direct.code === "23505" ? "23505" : cause?.code === "23505" ? "23505" : null;
  if (code !== "23505") return false;
  if (!constraintName) return true;
  return direct.constraint_name === constraintName || cause?.constraint_name === constraintName;
}

function forbidden(c: Context) {
  return c.json({ error: { code: "forbidden", message: "Zone admin required" } }, 403);
}

tenantGroupsRouter.get("/groups", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const zoneWide = hasAnyRole(ctx, ...ZONE_GROUP_READ_ROLES);
  const conditions = [eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)];
  if (!zoneWide) {
    if (ctx.groupIds.length === 0) return c.json({ items: [] });
    conditions.push(inArray(groups.id, ctx.groupIds));
  }
  const rows = await db
    .select({
      id: groups.id,
      slug: groups.slug,
      name: groups.name,
      createdAt: groups.createdAt,
      chapterCount: sql<number>`(
        select count(*)::int from ${chapters}
        where ${chapters.zoneId} = ${ctx.zoneId}
          and ${chapters.groupId} = ${groups.id}
          and ${chapters.deletedAt} is null
      )`,
    })
    .from(groups)
    .where(and(...conditions))
    .orderBy(asc(groups.name));
  return c.json({ items: rows });
});

tenantGroupsRouter.post("/groups", zValidator("json", groupCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
  const input = c.req.valid("json");
  try {
    await assertGroupNameAvailable(db, ctx.zoneId, input.name);
    await assertGroupSlugAvailable(db, ctx.zoneId, input.slug);
  } catch (e) {
    if (e instanceof GroupNameTakenError)
      return c.json({ error: { code: "group_name_taken", message: e.message } }, 409);
    if (e instanceof GroupSlugTakenError)
      return c.json({ error: { code: "group_slug_taken", message: e.message } }, 409);
    throw e;
  }
  let result: { id: string; slug: string; name: string; createdAt: Date };
  try {
    result = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(groups)
        .values({ zoneId: ctx.zoneId, slug: input.slug, name: input.name })
        .returning({
          id: groups.id,
          slug: groups.slug,
          name: groups.name,
          createdAt: groups.createdAt,
        });
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "group.create",
        entityType: "group",
        entityId: row.id,
        after: row,
      });
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e, "groups_zone_name_lower_idx"))
      return c.json(
        { error: { code: "group_name_taken", message: `A group named "${input.name}" already exists in this zone.` } },
        409,
      );
    if (isUniqueViolation(e, "groups_zone_slug_idx"))
      return c.json(
        { error: { code: "group_slug_taken", message: `A group with slug "${input.slug}" already exists in this zone.` } },
        409,
      );
    throw e;
  }
  return c.json({ group: result }, 201);
});

tenantGroupsRouter.get("/groups/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const zoneWide = hasAnyRole(ctx, ...ZONE_GROUP_READ_ROLES);
  if (!zoneWide && !ctx.groupIds.includes(id)) {
    return c.json({ error: { code: "not_found", message: "Group not found" } }, 404);
  }
  const [row] = await db
    .select({
      id: groups.id,
      slug: groups.slug,
      name: groups.name,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
    })
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)))
    .limit(1);
  if (!row) return c.json({ error: { code: "not_found", message: "Group not found" } }, 404);
  const [{ chapterCount }] = await db
    .select({ chapterCount: count() })
    .from(chapters)
    .where(
      and(
        eq(chapters.zoneId, ctx.zoneId),
        eq(chapters.groupId, id),
        isNull(chapters.deletedAt),
      ),
    );
  return c.json({ group: { ...row, chapterCount } });
});

tenantGroupsRouter.patch("/groups/:id", zValidator("json", groupUpdateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
  const id = c.req.param("id");
  const input = c.req.valid("json");
  try {
    if (input.name)
      await assertGroupNameAvailable(db, ctx.zoneId, input.name, { excludeGroupId: id });
    if (input.slug)
      await assertGroupSlugAvailable(db, ctx.zoneId, input.slug, { excludeGroupId: id });
  } catch (e) {
    if (e instanceof GroupNameTakenError)
      return c.json({ error: { code: "group_name_taken", message: e.message } }, 409);
    if (e instanceof GroupSlugTakenError)
      return c.json({ error: { code: "group_slug_taken", message: e.message } }, 409);
    throw e;
  }
  let result: { id: string; slug: string; name: string } | null;
  try {
    result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(groups)
        .where(and(eq(groups.id, id), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)))
        .limit(1);
      if (!before) return null;
      const [row] = await tx
        .update(groups)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(groups.id, id), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)))
        .returning({ id: groups.id, slug: groups.slug, name: groups.name });
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "group.update",
        entityType: "group",
        entityId: id,
        before: { name: before.name, slug: before.slug },
        after: row,
      });
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e, "groups_zone_name_lower_idx"))
      return c.json(
        { error: { code: "group_name_taken", message: `A group named "${input.name}" already exists in this zone.` } },
        409,
      );
    if (isUniqueViolation(e, "groups_zone_slug_idx"))
      return c.json(
        { error: { code: "group_slug_taken", message: `A group with slug "${input.slug}" already exists in this zone.` } },
        409,
      );
    throw e;
  }
  if (!result) return c.json({ error: { code: "not_found", message: "Group not found" } }, 404);
  return c.json({ group: result });
});

tenantGroupsRouter.delete("/groups/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
  const id = c.req.param("id");
  try {
    await softDeleteGroup(db, { zoneId: ctx.zoneId, groupId: id, actorUserId: ctx.userId });
  } catch (e) {
    if (e instanceof GroupNotFoundError) {
      return c.json({ error: { code: "group_not_found", message: e.message } }, 404);
    }
    if (e instanceof GroupNotEmptyError) {
      return c.json(
        {
          error: {
            code: "group_not_empty",
            message: e.message,
            details: { chapterCount: e.chapterCount },
          },
        },
        409,
      );
    }
    throw e;
  }
  return c.json({ status: "deleted" });
});

tenantGroupsRouter.post(
  "/chapters/:id/move-group",
  zValidator("json", chapterMoveGroupSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
    const chapterId = c.req.param("id");
    const input = c.req.valid("json");

    const [chap] = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(
        and(
          eq(chapters.id, chapterId),
          eq(chapters.zoneId, ctx.zoneId),
          isNull(chapters.deletedAt),
        ),
      )
      .limit(1);
    if (!chap)
      return c.json({ error: { code: "chapter_not_found", message: "Chapter not in this zone" } }, 404);

    let effectiveDate = input.effectiveDate;
    if (!effectiveDate) {
      const [z] = await db
        .select({ tz: zones.defaultTimeZone })
        .from(zones)
        .where(eq(zones.id, ctx.zoneId))
        .limit(1);
      effectiveDate = new Date().toLocaleDateString("en-CA", { timeZone: z.tz });
    }

    try {
      const out = await moveChapterToGroup(db, {
        zoneId: ctx.zoneId,
        chapterId,
        newGroupId: input.groupId,
        effectiveDate,
        actorUserId: ctx.userId,
      });
      return c.json({ status: out.changed ? "moved" : "noop" });
    } catch (e) {
      if (e instanceof GroupsNotEnabledError)
        return c.json({ error: { code: "groups_not_enabled", message: e.message } }, 409);
      if (e instanceof HistoryViolationError)
        return c.json({ error: { code: "history_violation", message: e.message } }, 400);
      if (e instanceof Error && e.message.includes("Target group not found"))
        return c.json({ error: { code: "group_not_found", message: "Group not in this zone" } }, 404);
      throw e;
    }
  },
);

tenantGroupsRouter.get("/chapters/:id/group-history", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const chapterId = c.req.param("id");
  const scope = await requireChapterScope(ctx, chapterId, ZONE_GROUP_READ_ROLES);
  if (!scope.ok) {
    return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
  }

  const rows = await db
    .select({
      id: chapterGroupHistory.id,
      groupId: chapterGroupHistory.groupId,
      groupName: groups.name,
      dateFrom: chapterGroupHistory.dateFrom,
      dateTo: chapterGroupHistory.dateTo,
    })
    .from(chapterGroupHistory)
    .innerJoin(
      groups,
      and(eq(groups.id, chapterGroupHistory.groupId), eq(groups.zoneId, ctx.zoneId)),
    )
    .where(
      and(
        eq(chapterGroupHistory.zoneId, ctx.zoneId),
        eq(chapterGroupHistory.chapterId, chapterId),
      ),
    )
    .orderBy(asc(chapterGroupHistory.dateFrom));
  return c.json({ items: rows });
});
