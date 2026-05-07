// packages/db/src/schema/lookups.ts
// Per-zone lookup tables used by members. Seeded with sensible defaults at
// signup time. See docs/DOMAIN-MODEL.md §3.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { zones } from "./zones";

/** Honorifics: Mr, Mrs, Pastor, etc. */
export const titles = pgTable(
  "titles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Optional gender hint: "M" | "F" | null for unisex. */
    gender: text("gender"),
    isActive: boolean("is_active").notNull().default(true),
    ordinal: integer("ordinal").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("titles_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    index("titles_zone_idx").on(table.zoneId),
    check("titles_gender_check", sql`${table.gender} is null or ${table.gender} in ('M', 'F')`),
  ],
);

export const maritalStatuses = pgTable(
  "marital_statuses",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ordinal: integer("ordinal").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("marital_statuses_zone_name_lower_idx").on(
      table.zoneId,
      sql`lower(${table.name})`,
    ),
    index("marital_statuses_zone_idx").on(table.zoneId),
  ],
);

export const memberTypes = pgTable(
  "member_types",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ordinal: integer("ordinal").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("member_types_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    index("member_types_zone_idx").on(table.zoneId),
  ],
);

export type Title = typeof titles.$inferSelect;
export type NewTitle = typeof titles.$inferInsert;
export type MaritalStatus = typeof maritalStatuses.$inferSelect;
export type NewMaritalStatus = typeof maritalStatuses.$inferInsert;
export type MemberType = typeof memberTypes.$inferSelect;
export type NewMemberType = typeof memberTypes.$inferInsert;
