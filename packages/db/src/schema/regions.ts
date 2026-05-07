// packages/db/src/schema/regions.ts
// Regions are platform-curated reference data, not tenants.
// A zone selects a region during signup or submits an unverified region name.
// Platform admins (region_curator) maintain this table.

import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const regions = pgTable(
  "regions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    shortCode: text("short_code"),
    countryCode: text("country_code"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("regions_name_lower_idx").on(sql`lower(${table.name})`),
    uniqueIndex("regions_short_code_idx").on(table.shortCode),
  ],
);

export type Region = typeof regions.$inferSelect;
export type NewRegion = typeof regions.$inferInsert;
