// packages/db/src/schema/audit.ts
// Append-only audit log. See docs/ARCHITECTURE.md §13.
// Triggers and service helpers write here on every sensitive write.

import { sql } from "drizzle-orm";
import { check, index, inet, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { zones } from "./zones";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /**
     * Null for platform-scope events (e.g. granting a `support_admin` role).
     * Set for every tenant-scope event. The CHECK below pins this invariant
     * against the action namespace so we can't accidentally write a
     * tenant-scope event with NULL zone_id.
     */
    zoneId: text("zone_id").references(() => zones.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorRoleCode: text("actor_role_code"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_zone_entity_idx").on(table.zoneId, table.entityType, table.entityId),
    index("audit_events_zone_occurred_idx").on(table.zoneId, table.occurredAt.desc()),
    /**
     * Platform-scope events are namespaced `platform.*` and have NULL
     * zone_id; every other event must have a zone_id. This is what makes
     * audit search safe to widen — a tenant-scope event can’t leak with
     * NULL zone_id and a platform event can’t accidentally pin to a zone.
     */
    check(
      "audit_events_zone_scope_check",
      sql`((${table.action} like 'platform.%') and ${table.zoneId} is null)
          or ((${table.action} not like 'platform.%') and ${table.zoneId} is not null)`,
    ),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
