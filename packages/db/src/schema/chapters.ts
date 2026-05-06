// packages/db/src/schema/chapters.ts
// A chapter is a single local church/congregation. Many chapters per zone.

import { date, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { regions } from "./regions";
import { zones } from "./zones";

export const chapters = pgTable(
  "chapters",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),
    /** Denormalized from zones.region_id for fast region-aware reports. */
    regionId: text("region_id").references(() => regions.id, { onDelete: "set null" }),
    /** Reference code, e.g. "C0000001". Format configurable per zone. */
    referenceCode: text("reference_code").notNull(),
    name: text("name").notNull(),
    countryCode: text("country_code"),
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("chapters_zone_reference_idx").on(table.zoneId, table.referenceCode),
    index("chapters_zone_id_idx").on(table.zoneId),
    index("chapters_region_id_idx").on(table.regionId),
  ],
);

export const chapterNameHistory = pgTable(
  "chapter_name_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chapter_name_history_chapter_id_idx").on(table.chapterId)],
);

export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;
