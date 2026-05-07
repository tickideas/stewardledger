// packages/api/src/routes/tenant-giving.ts
// Tenant-scoped giving setup API for Phase 4.

import { zValidator } from "@hono/zod-validator";
import {
  accountCreateSchema,
  accountUpdateSchema,
  givingCategoryCreateSchema,
  givingCategoryUpdateSchema,
  givingTypeCreateSchema,
  givingTypeUpdateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  accounts,
  givingCategories,
  givingTypes,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { writeAudit } from "../services/audit";
import {
  GIVING_READ_ROLES,
  GIVING_WRITE_ROLES,
  conflict,
  forbidden,
  isUniqueViolation,
  updateValues,
} from "./tenant-giving-common";

export const tenantGivingRouter = new Hono();

async function ensureCategoryInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: givingCategories.id })
    .from(givingCategories)
    .where(and(eq(givingCategories.zoneId, zoneId), eq(givingCategories.id, id)))
    .limit(1);
  return rows.length > 0;
}

async function ensureAccountInZone(zoneId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.zoneId, zoneId), eq(accounts.id, id)))
    .limit(1);
  return rows.length > 0;
}

async function zoneDefaultCurrency(zoneId: string): Promise<string> {
  const [zone] = await db
    .select({ defaultCurrencyCode: zones.defaultCurrencyCode })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!zone) throw new Error(`Zone ${zoneId} missing while creating account`);
  return zone.defaultCurrencyCode;
}

// ─── Categories ──────────────────────────────────────────────────────

tenantGivingRouter.get("/giving/categories", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(givingCategories)
    .where(eq(givingCategories.zoneId, ctx.zoneId))
    .orderBy(asc(givingCategories.ordinal), asc(givingCategories.name));
  return c.json({ items: rows });
});

tenantGivingRouter.post(
  "/giving/categories",
  zValidator("json", givingCategoryCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
    const input = c.req.valid("json");
    if (input.parentCategoryId && !(await ensureCategoryInZone(ctx.zoneId, input.parentCategoryId))) {
      return c.json({ error: { code: "category_not_found", message: "Parent category not in this zone" } }, 404);
    }
    try {
      const [row] = await db
        .insert(givingCategories)
        .values({
          zoneId: ctx.zoneId,
          parentCategoryId: input.parentCategoryId ?? null,
          name: input.name,
          shortCode: input.shortCode ?? null,
          ordinal: input.ordinal ?? 0,
          dateFrom: input.dateFrom ?? new Date().toISOString().slice(0, 10),
          dateTo: input.dateTo ?? null,
        })
        .returning();
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "giving.category.create",
        entityType: "giving_category",
        entityId: row.id,
        after: row,
      });
      return c.json({ category: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "category_exists", "Giving category already exists.");
      throw err;
    }
  },
);

tenantGivingRouter.patch(
  "/giving/categories/:id",
  zValidator("json", givingCategoryUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    if (input.parentCategoryId === id) {
      return c.json({ error: { code: "category_cycle", message: "Category cannot be its own parent" } }, 400);
    }
    if (input.parentCategoryId && !(await ensureCategoryInZone(ctx.zoneId, input.parentCategoryId))) {
      return c.json({ error: { code: "category_not_found", message: "Parent category not in this zone" } }, 404);
    }
    try {
      const [row] = await db
        .update(givingCategories)
        .set(updateValues(input))
        .where(and(eq(givingCategories.id, id), eq(givingCategories.zoneId, ctx.zoneId)))
        .returning();
      if (!row) return c.json({ error: { code: "not_found", message: "Giving category not found" } }, 404);
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "giving.category.update",
        entityType: "giving_category",
        entityId: row.id,
        after: input,
      });
      return c.json({ category: row });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "category_exists", "Giving category already exists.");
      throw err;
    }
  },
);

// ─── Accounts ────────────────────────────────────────────────────────

tenantGivingRouter.get("/giving/accounts", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.zoneId, ctx.zoneId))
    .orderBy(asc(accounts.name));
  return c.json({ items: rows });
});

tenantGivingRouter.post("/giving/accounts", zValidator("json", accountCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
  const input = c.req.valid("json");
  const currencyCode = input.currencyCode ?? (await zoneDefaultCurrency(ctx.zoneId));
  try {
    const [row] = await db
      .insert(accounts)
      .values({
        zoneId: ctx.zoneId,
        name: input.name,
        description: input.description ?? null,
        currencyCode,
        dateFrom: input.dateFrom ?? new Date().toISOString().slice(0, 10),
        dateTo: input.dateTo ?? null,
      })
      .returning();
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "giving.account.create",
      entityType: "account",
      entityId: row.id,
      after: row,
    });
    return c.json({ account: row }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) return conflict(c, "account_exists", "Account already exists.");
    throw err;
  }
});

tenantGivingRouter.patch(
  "/giving/accounts/:id",
  zValidator("json", accountUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .update(accounts)
        .set(updateValues(input))
        .where(and(eq(accounts.id, id), eq(accounts.zoneId, ctx.zoneId)))
        .returning();
      if (!row) return c.json({ error: { code: "not_found", message: "Account not found" } }, 404);
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "giving.account.update",
        entityType: "account",
        entityId: row.id,
        after: input,
      });
      return c.json({ account: row });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "account_exists", "Account already exists.");
      throw err;
    }
  },
);

// ─── Giving types ────────────────────────────────────────────────────

tenantGivingRouter.get("/giving/types", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(givingTypes)
    .where(eq(givingTypes.zoneId, ctx.zoneId))
    .orderBy(asc(givingTypes.ordinal), asc(givingTypes.name));
  return c.json({ items: rows });
});

tenantGivingRouter.post("/giving/types", zValidator("json", givingTypeCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
  const input = c.req.valid("json");
  if (!(await ensureCategoryInZone(ctx.zoneId, input.categoryId))) {
    return c.json({ error: { code: "category_not_found", message: "Category not in this zone" } }, 404);
  }
  if (input.accountId && !(await ensureAccountInZone(ctx.zoneId, input.accountId))) {
    return c.json({ error: { code: "account_not_found", message: "Account not in this zone" } }, 404);
  }
  try {
    const [row] = await db
      .insert(givingTypes)
      .values({
        zoneId: ctx.zoneId,
        categoryId: input.categoryId,
        name: input.name,
        shortCode: input.shortCode ?? null,
        isZonal: input.isZonal ?? false,
        isChapter: input.isChapter ?? true,
        hasPartnershipTarget: input.hasPartnershipTarget ?? false,
        accountId: input.accountId ?? null,
        ordinal: input.ordinal ?? 0,
        isActive: input.isActive ?? true,
      })
      .returning();
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "giving.type.create",
      entityType: "giving_type",
      entityId: row.id,
      after: row,
    });
    return c.json({ givingType: row }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) return conflict(c, "giving_type_exists", "Giving type already exists.");
    throw err;
  }
});

tenantGivingRouter.patch("/giving/types/:id", zValidator("json", givingTypeUpdateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
  const id = c.req.param("id");
  const input = c.req.valid("json");
  if (input.categoryId && !(await ensureCategoryInZone(ctx.zoneId, input.categoryId))) {
    return c.json({ error: { code: "category_not_found", message: "Category not in this zone" } }, 404);
  }
  if (input.accountId && !(await ensureAccountInZone(ctx.zoneId, input.accountId))) {
    return c.json({ error: { code: "account_not_found", message: "Account not in this zone" } }, 404);
  }
  try {
    const [row] = await db
      .update(givingTypes)
      .set(updateValues(input))
      .where(and(eq(givingTypes.id, id), eq(givingTypes.zoneId, ctx.zoneId)))
      .returning();
    if (!row) return c.json({ error: { code: "not_found", message: "Giving type not found" } }, 404);
    await writeAudit(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "giving.type.update",
      entityType: "giving_type",
      entityId: row.id,
      after: input,
    });
    return c.json({ givingType: row });
  } catch (err) {
    if (isUniqueViolation(err)) return conflict(c, "giving_type_exists", "Giving type already exists.");
    throw err;
  }
});
