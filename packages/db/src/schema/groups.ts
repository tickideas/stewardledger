// packages/db/src/schema/groups.ts
// Tenant-scoped grouping of chapters between Zone and Chapter.
// Holds the registry table plus the chapter_group_history segments.
// RELEVANT FILES: ./chapters.ts, ./zones.ts, ./index.ts

import { sql } from "drizzle-orm";
import {
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { chapters } from "./chapters";
import { zones } from "./zones";

export const groups = pgTable(
  "groups",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),
    /** URL-safe identifier, unique per zone among non-deleted. */
    slug: text("slug").notNull(),
    /** Display name, unique per zone (case-insensitive) among non-deleted. */
    name: text("name").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    /** Composite cross-tenant FK target — mirrors chapters_zone_row_id_unique. */
    unique("groups_zone_row_id_unique").on(table.zoneId, table.id),
    uniqueIndex("groups_zone_slug_idx")
      .on(table.zoneId, table.slug)
      .where(sql`deleted_at is null`),
    uniqueIndex("groups_zone_name_lower_idx")
      .on(table.zoneId, sql`lower(${table.name})`)
      .where(sql`deleted_at is null`),
    index("groups_zone_id_idx").on(table.zoneId),
  ],
);

export const chapterGroupHistory = pgTable(
  "chapter_group_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").notNull(),
    groupId: text("group_id").notNull(),
    /** Inclusive lower bound. */
    dateFrom: date("date_from").notNull(),
    /** Null = current open segment. */
    dateTo: date("date_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chapter_group_history_chapter_idx").on(table.chapterId, table.dateFrom),
    index("chapter_group_history_group_idx").on(table.groupId, table.dateFrom),
    foreignKey({
      name: "chapter_group_history_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chapter_group_history_group_zone_fk",
      columns: [table.zoneId, table.groupId],
      foreignColumns: [groups.zoneId, groups.id],
    }).onDelete("restrict"),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type ChapterGroupHistoryRow = typeof chapterGroupHistory.$inferSelect;
