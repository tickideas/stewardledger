// packages/db/src/schema/roles.ts
// Roles & bindings. See docs/PRD.md §6 and packages/shared/src/roles.ts.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import { groups } from "./groups";
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
    /** platform | zone | group | chapter */
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
    groupId: text("group_id"),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    roleScope: text("role_scope").notNull(),
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
    index("user_role_bindings_group_idx").on(table.groupId),
    /** Active zone-tier binding: (user, zone, role) when both scope keys are null. */
    uniqueIndex("user_role_bindings_active_zone_idx")
      .on(table.userId, table.zoneId, table.roleId)
      .where(sql`revoked_at is null and group_id is null and chapter_id is null`),
    /** Active group-tier binding: (user, zone, group, role) when chapter is null. */
    uniqueIndex("user_role_bindings_active_group_idx")
      .on(table.userId, table.zoneId, table.groupId, table.roleId)
      .where(sql`revoked_at is null and group_id is not null and chapter_id is null`),
    /** Active chapter-tier binding: (user, zone, chapter, role) when group is null. */
    uniqueIndex("user_role_bindings_active_chapter_idx")
      .on(table.userId, table.zoneId, table.chapterId, table.roleId)
      .where(sql`revoked_at is null and group_id is null and chapter_id is not null`),
    check(
      "user_role_bindings_scope_shape",
      sql`(
        (role_scope = 'group'    and group_id is not null and chapter_id is null) or
        (role_scope = 'chapter'  and chapter_id is not null and group_id is null) or
        (role_scope = 'zone'     and group_id is null and chapter_id is null) or
        (role_scope = 'platform' and group_id is null and chapter_id is null)
      )`,
    ),
    foreignKey({
      name: "user_role_bindings_zone_group_fk",
      columns: [table.zoneId, table.groupId],
      foreignColumns: [groups.zoneId, groups.id],
    }).onDelete("cascade"),
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
