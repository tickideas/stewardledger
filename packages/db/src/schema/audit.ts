// packages/db/src/schema/audit.ts
// Append-only audit log. See docs/ARCHITECTURE.md §13.
// Triggers and service helpers write here on every sensitive write.

import { index, inet, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { zones } from "./zones";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
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
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
