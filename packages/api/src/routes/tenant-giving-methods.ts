// packages/api/src/routes/tenant-giving-methods.ts
// Payment method and service type setup routes.

import { zValidator } from "@hono/zod-validator";
import {
  paymentMethodCreateSchema,
  paymentMethodUpdateSchema,
  serviceTypeCreateSchema,
  serviceTypeUpdateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { paymentMethods, serviceTypes } from "@stewardledger/db/schema";
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

export const tenantGivingMethodsRouter = new Hono();

tenantGivingMethodsRouter.get("/giving/payment-methods", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.zoneId, ctx.zoneId))
    .orderBy(asc(paymentMethods.ordinal), asc(paymentMethods.name));
  return c.json({ items: rows });
});

tenantGivingMethodsRouter.post(
  "/giving/payment-methods",
  zValidator("json", paymentMethodCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .insert(paymentMethods)
        .values({
          zoneId: ctx.zoneId,
          code: input.code,
          name: input.name,
          isActive: input.isActive ?? true,
          ordinal: input.ordinal ?? 0,
        })
        .returning();
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "giving.payment_method.create",
        entityType: "payment_method",
        entityId: row.id,
        after: row,
      });
      return c.json({ paymentMethod: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "payment_method_exists", "Payment method already exists.");
      throw err;
    }
  },
);

tenantGivingMethodsRouter.patch(
  "/giving/payment-methods/:id",
  zValidator("json", paymentMethodUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .update(paymentMethods)
        .set(updateValues(input))
        .where(and(eq(paymentMethods.id, id), eq(paymentMethods.zoneId, ctx.zoneId)))
        .returning();
      if (!row) return c.json({ error: { code: "not_found", message: "Payment method not found" } }, 404);
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "giving.payment_method.update",
        entityType: "payment_method",
        entityId: row.id,
        after: input,
      });
      return c.json({ paymentMethod: row });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "payment_method_exists", "Payment method already exists.");
      throw err;
    }
  },
);

tenantGivingMethodsRouter.get("/giving/service-types", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...GIVING_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(serviceTypes)
    .where(eq(serviceTypes.zoneId, ctx.zoneId))
    .orderBy(asc(serviceTypes.ordinal), asc(serviceTypes.name));
  return c.json({ items: rows });
});

tenantGivingMethodsRouter.post(
  "/giving/service-types",
  zValidator("json", serviceTypeCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .insert(serviceTypes)
        .values({
          zoneId: ctx.zoneId,
          name: input.name,
          shortCode: input.shortCode ?? null,
          isActive: input.isActive ?? true,
          ordinal: input.ordinal ?? 0,
        })
        .returning();
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "giving.service_type.create",
        entityType: "service_type",
        entityId: row.id,
        after: row,
      });
      return c.json({ serviceType: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "service_type_exists", "Service type already exists.");
      throw err;
    }
  },
);

tenantGivingMethodsRouter.patch(
  "/giving/service-types/:id",
  zValidator("json", serviceTypeUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...GIVING_WRITE_ROLES)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .update(serviceTypes)
        .set(updateValues(input))
        .where(and(eq(serviceTypes.id, id), eq(serviceTypes.zoneId, ctx.zoneId)))
        .returning();
      if (!row) return c.json({ error: { code: "not_found", message: "Service type not found" } }, 404);
      await writeAudit(db, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "giving.service_type.update",
        entityType: "service_type",
        entityId: row.id,
        after: input,
      });
      return c.json({ serviceType: row });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "service_type_exists", "Service type already exists.");
      throw err;
    }
  },
);
