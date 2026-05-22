// packages/api/src/routes/admin-audit.ts
// Platform-scope audit-event search. Mirrors the zone-audit endpoint
// shape used by /zone/audit but flips the WHERE clause to surface
// rows with `zone_id IS NULL` and `action LIKE 'platform.%'` — the
// partition the audit_events CHECK constraint already enforces.
//
// Super-admin only. The audit trail surfaces every platform-admin's
// actions (grant / revoke / elevate / demote / invite) across every
// tenant, which is privileged information even when read-only.
//
// RELEVANT FILES: packages/api/src/routes/admin-administrators.ts, packages/api/src/services/reports/audit-log.ts, packages/web/src/routes/admin/audit/+page.svelte

import { zValidator } from "@hono/zod-validator";
import { auditEvents, user as userTable } from "@stewardledger/db/schema";
import { PLATFORM_ROLES } from "@stewardledger/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { log } from "../logger";
import {
  requirePlatformRole,
  requireSession,
  type SessionUser,
} from "../middleware/auth";

export const adminAuditRouter = new Hono();

adminAuditRouter.use(
  "*",
  requireSession,
  requirePlatformRole(PLATFORM_ROLES.SUPER_ADMIN),
);

const querySchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    actorUserId: z.string().trim().min(1).max(200).optional(),
    action: z.string().trim().min(1).max(200).optional(),
    entityType: z.string().trim().min(1).max(80).optional(),
    entityId: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(1000).default(500),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });

interface PlatformAuditRow {
  id: string;
  occurredAt: string;
  actorEmail: string | null;
  actorRoleCode: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
}

adminAuditRouter.get("/", zValidator("query", querySchema), async (c) => {
  const user = c.get("user") as SessionUser;
  const q = c.req.valid("query");
  log.info(
    {
      event: "admin.audit.search",
      userId: user.id,
      userEmail: user.email,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      hasActorFilter: Boolean(q.actorUserId),
      hasActionFilter: Boolean(q.action),
      hasEntityFilter: Boolean(q.entityType || q.entityId),
      limit: q.limit,
      requestId: c.req.header("x-request-id") ?? null,
    },
    "admin access",
  );

  // The partitioning CHECK on audit_events guarantees `zone_id IS NULL`
  // iff the action starts with `platform.`. We require BOTH for defence
  // in depth — a future relaxation of the CHECK can't accidentally leak
  // tenant rows through this endpoint.
  const conditions = [
    sql`${auditEvents.zoneId} is null`,
    sql`${auditEvents.action} like 'platform.%'`,
    sql`${auditEvents.occurredAt} >= (${q.dateFrom}::date at time zone 'UTC')`,
    sql`${auditEvents.occurredAt} < ((${q.dateTo}::date + interval '1 day') at time zone 'UTC')`,
  ];
  if (q.actorUserId) conditions.push(eq(auditEvents.actorUserId, q.actorUserId));
  if (q.action) conditions.push(eq(auditEvents.action, q.action));
  if (q.entityType) conditions.push(eq(auditEvents.entityType, q.entityType));
  if (q.entityId) conditions.push(eq(auditEvents.entityId, q.entityId));

  const rows = await db
    .select({
      id: auditEvents.id,
      occurredAt: auditEvents.occurredAt,
      actorEmail: userTable.email,
      actorRoleCode: auditEvents.actorRoleCode,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      reason: auditEvents.reason,
      before: auditEvents.before,
      after: auditEvents.after,
      ipAddress: auditEvents.ipAddress,
      userAgent: auditEvents.userAgent,
    })
    .from(auditEvents)
    .leftJoin(userTable, eq(auditEvents.actorUserId, userTable.id))
    .where(and(...conditions))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(q.limit);

  const items: PlatformAuditRow[] = rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    actorEmail: r.actorEmail,
    actorRoleCode: r.actorRoleCode,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    reason: r.reason,
    before: r.before,
    after: r.after,
    ipAddress: r.ipAddress ? String(r.ipAddress) : null,
    userAgent: r.userAgent,
  }));

  return c.json({ items });
});
