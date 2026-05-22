// packages/api/src/routes/tenant-paying-in-books.ts
// Phase 8 — paying-in-book CRUD for chapter-scoped deposit-slip pads.
// Endpoints:
//
//   GET    /api/tenant/paying-in-books        list books in scope
//   POST   /api/tenant/paying-in-books        create
//   PATCH  /api/tenant/paying-in-books/:id    partial update
//   DELETE /api/tenant/paying-in-books/:id    hard delete (audited)
//
// Access:
//  • READ: any zone reader + any chapter reader (clamped to bound
//    chapters).
//  • WRITE: zone finance admin / zone admin / zone owner for any
//    book; chapter admin for books on their bound chapters only.
//    Treasurers cannot create / edit books \u2014 the pad is operator-
//    issued, the treasurer just uses the codes inside it.
// RELEVANT FILES: packages/db/src/schema/paying-in-books.ts, packages/api/src/services/paying-in-books/validate.ts, packages/shared/src/schemas.ts

import { zValidator } from "@hono/zod-validator";
import {
  CHAPTER_ROLES,
  payingInBookCreateSchema,
  payingInBookListQuerySchema,
  payingInBookUpdateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { chapters, payingInBooks } from "@stewardledger/db/schema";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole, visibleChapterIds } from "../middleware/auth";
import { writeAudit } from "../services/audit";
import {
  CHAPTER_GIVING_READ_ROLES,
  forbidden,
  GIVING_WRITE_ROLES,
  updateValues,
  ZONE_GIVING_READ_ROLES,
} from "./tenant-giving-common";

export const tenantPayingInBooksRouter = new Hono();

function hasChapterRole(ctx: AuthorizedContext, roles: readonly string[]): boolean {
  return ctx.roleCodes.some((code) => roles.includes(code));
}

function hasZoneRead(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...ZONE_GIVING_READ_ROLES);
}

function hasChapterRead(ctx: AuthorizedContext): boolean {
  return hasChapterRole(ctx, CHAPTER_GIVING_READ_ROLES);
}

function hasZoneWrite(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...GIVING_WRITE_ROLES);
}

/** Chapter admin is the only chapter-tier role with paying-in-book write. */
function hasChapterWrite(ctx: AuthorizedContext): boolean {
  return hasChapterRole(ctx, [CHAPTER_ROLES.CHAPTER_ADMIN]);
}

function canWriteBook(ctx: AuthorizedContext, chapterId: string): boolean {
  if (hasZoneWrite(ctx)) return true;
  return hasChapterWrite(ctx) && ctx.chapterIds.includes(chapterId);
}

async function ensureChapterInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.zoneId, zoneId), eq(chapters.id, id), isNull(chapters.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

tenantPayingInBooksRouter.get(
  "/paying-in-books",
  zValidator("query", payingInBookListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
    const query = c.req.valid("query");
    const conditions = [eq(payingInBooks.zoneId, ctx.zoneId)];

    const scope = await visibleChapterIds(ctx, ZONE_GIVING_READ_ROLES);
    if (scope.kind === "all") {
      if (query.chapterId) conditions.push(eq(payingInBooks.chapterId, query.chapterId));
    } else {
      if (query.chapterId && !scope.ids.includes(query.chapterId)) {
        return forbidden(c);
      }
      if (query.chapterId) {
        conditions.push(eq(payingInBooks.chapterId, query.chapterId));
      } else if (scope.ids.length === 0) {
        return c.json({ items: [], limit: query.limit, offset: query.offset });
      } else {
        conditions.push(inArray(payingInBooks.chapterId, scope.ids));
      }
    }
    if (query.activeOn) {
      conditions.push(lte(payingInBooks.dateFrom, query.activeOn));
      conditions.push(
        or(
          isNull(payingInBooks.dateTo),
          sql`${payingInBooks.dateTo} >= ${query.activeOn}::date`,
        )!,
      );
    }

    const rows = await db
      .select()
      .from(payingInBooks)
      .where(and(...conditions))
      .orderBy(asc(payingInBooks.chapterId), asc(payingInBooks.dateFrom))
      .limit(query.limit)
      .offset(query.offset);
    return c.json({ items: rows, limit: query.limit, offset: query.offset });
  },
);

tenantPayingInBooksRouter.post(
  "/paying-in-books",
  zValidator("json", payingInBookCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneWrite(ctx) && !hasChapterWrite(ctx)) return forbidden(c);
    const input = c.req.valid("json");
    if (!canWriteBook(ctx, input.chapterId)) return forbidden(c);
    if (!(await ensureChapterInZone(ctx.zoneId, input.chapterId))) {
      return c.json(
        { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
        404,
      );
    }
    const [row] = await db
      .insert(payingInBooks)
      .values({
        zoneId: ctx.zoneId,
        chapterId: input.chapterId,
        referenceCodeStart: input.referenceCodeStart,
        referenceCodeEnd: input.referenceCodeEnd,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo ?? null,
      })
      .returning();
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "paying_in_book.create",
      entityType: "paying_in_book",
      entityId: row.id,
      after: row,
    });
    return c.json({ payingInBook: row }, 201);
  },
);

tenantPayingInBooksRouter.patch(
  "/paying-in-books/:id",
  zValidator("json", payingInBookUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneWrite(ctx) && !hasChapterWrite(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");

    const [existing] = await db
      .select()
      .from(payingInBooks)
      .where(and(eq(payingInBooks.id, id), eq(payingInBooks.zoneId, ctx.zoneId)))
      .limit(1);
    if (!existing) {
      return c.json({ error: { code: "not_found", message: "Paying-in book not found" } }, 404);
    }
    const nextChapter = input.chapterId ?? existing.chapterId;
    if (!canWriteBook(ctx, existing.chapterId)) return forbidden(c);
    if (input.chapterId && !canWriteBook(ctx, input.chapterId)) return forbidden(c);
    if (input.chapterId && !(await ensureChapterInZone(ctx.zoneId, input.chapterId))) {
      return c.json(
        { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
        404,
      );
    }
    // Service-level cross-validation: the resolved (after-patch)
    // start/end pair must still satisfy `start <= end`, and the
    // resolved date window must still satisfy `dateTo >= dateFrom`
    // (when dateTo is non-null). The DB CHECKs are the canonical
    // guards, but failing fast here gives a cleaner error envelope
    // than a raw 500 on the constraint.
    const nextStart = input.referenceCodeStart ?? existing.referenceCodeStart;
    const nextEnd = input.referenceCodeEnd ?? existing.referenceCodeEnd;
    if (nextStart.length !== nextEnd.length) {
      return c.json(
        {
          error: {
            code: "invalid_range",
            message:
              "referenceCodeStart and referenceCodeEnd must be the same length after the patch.",
          },
        },
        400,
      );
    }
    if (nextStart > nextEnd) {
      return c.json(
        {
          error: {
            code: "invalid_range",
            message: "referenceCodeStart must be <= referenceCodeEnd after the patch.",
          },
        },
        400,
      );
    }
    const nextDateFrom = input.dateFrom ?? existing.dateFrom;
    // `dateTo` is nullable: an explicit `null` in the patch clears
    // the close-out, an omitted key keeps the existing value.
    const nextDateTo =
      "dateTo" in input ? (input.dateTo ?? null) : existing.dateTo;
    if (nextDateTo !== null && nextDateTo < nextDateFrom) {
      return c.json(
        {
          error: {
            code: "invalid_date_window",
            message: "dateTo must be on or after dateFrom after the patch.",
          },
        },
        400,
      );
    }
    void nextChapter;
    const [row] = await db
      .update(payingInBooks)
      .set(updateValues(input))
      .where(and(eq(payingInBooks.id, id), eq(payingInBooks.zoneId, ctx.zoneId)))
      .returning();
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "paying_in_book.update",
      entityType: "paying_in_book",
      entityId: row.id,
      after: input,
    });
    return c.json({ payingInBook: row });
  },
);

tenantPayingInBooksRouter.delete("/paying-in-books/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneWrite(ctx) && !hasChapterWrite(ctx)) return forbidden(c);
  const id = c.req.param("id");
  const [existing] = await db
    .select()
    .from(payingInBooks)
    .where(and(eq(payingInBooks.id, id), eq(payingInBooks.zoneId, ctx.zoneId)))
    .limit(1);
  if (!existing) {
    return c.json({ error: { code: "not_found", message: "Paying-in book not found" } }, 404);
  }
  if (!canWriteBook(ctx, existing.chapterId)) return forbidden(c);
  await db
    .delete(payingInBooks)
    .where(and(eq(payingInBooks.id, id), eq(payingInBooks.zoneId, ctx.zoneId)));
  await writeAudit(db, {
    zoneId: ctx.zoneId,
    actorUserId: ctx.userId,
    action: "paying_in_book.delete",
    entityType: "paying_in_book",
    entityId: id,
    before: existing,
  });
  return c.json({ deleted: true });
});
