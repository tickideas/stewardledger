// packages/db/src/schema/roles.ts
// Roles & bindings. See docs/PRD.md §6 and packages/shared/src/roles.ts.

import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import { zones } from "./zones";

/**
 * Roles. Either zone-scoped (zoneId set) or platform-wide (zoneId null).
 * Permissions array carries the permission strings the role grants.
 */
export const roles = pgTable(
  "roles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id").references(() => zones.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** platform | zone | chapter */
    scope: text("scope").notNull(),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    isSystem: boolean("is_system").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("roles_zone_code_idx").on(table.zoneId, table.code)],
);

/**
 * A user's binding to a role within a zone.
 * - zone-wide binding: chapterId is null.
 * - chapter binding: chapterId set.
 * Multiple bindings per user/zone are allowed; permissions are unioned.
 */
export const userRoleBindings = pgTable(
  "user_role_bindings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    grantedByUserId: text("granted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("user_role_bindings_user_idx").on(table.userId),
    index("user_role_bindings_zone_idx").on(table.zoneId),
    index("user_role_bindings_chapter_idx").on(table.chapterId),
    uniqueIndex("user_role_bindings_unique_active_idx")
      .on(table.userId, table.zoneId, table.chapterId, table.roleId)
      .where(sql`revoked_at is null`),
  ],
);

/** Platform-level role bindings (super_admin etc.). */
export const platformRoleBindings = pgTable(
  "platform_role_bindings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleCode: text("role_code").notNull(),
    grantedByUserId: text("granted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("platform_role_bindings_user_idx").on(table.userId),
    uniqueIndex("platform_role_bindings_unique_idx")
      .on(table.userId, table.roleCode)
      .where(sql`revoked_at is null`),
  ],
);

export type Role = typeof roles.$inferSelect;
export type UserRoleBinding = typeof userRoleBindings.$inferSelect;
