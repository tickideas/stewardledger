// packages/db/src/schema/saved-report-filters.ts
// Per-user saved filter bundles for the report registry.
// One row = one named (user, zone, report) filter payload.
// RELEVANT FILES: packages/api/src/services/reports/saved-filters.ts, packages/api/src/routes/tenant-reports.ts

import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { zones } from "./zones";

export const savedReportFilters = pgTable(
  "saved_report_filters",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /**
     * Tenant boundary. Required even though a saved-filter row is
     * personal because a user can hold roles in multiple zones; the
     * saved filter belongs to the zone the user was in when they
     * pressed Save, and follows the same tenant-isolation rules as
     * every other domain row.
     */
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Matches `ReportSpec.id`. Stored as free text because the
     * registry is the source of truth — a row left behind by a
     * removed report no-ops (the route layer rejects unknown ids on
     * read).
     */
    reportId: text("report_id").notNull(),
    name: text("name").notNull(),
    /**
     * The parsed filter object the report's Zod schema accepts.
     * Validated on write via `parseReportFilters` so a malformed
     * row can't sneak in.
     */
    filters: jsonb("filters").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Unique on (user, zone, report, lower(name)) so a user can't
     * have two "monthly close" entries on the same report in the
     * same zone. Case-insensitive to match human expectation.
     */
    uniqueIndex("saved_report_filters_unique_name_idx").on(
      table.userId,
      table.zoneId,
      table.reportId,
      sql`lower(${table.name})`,
    ),
    /** List endpoint hits this prefix on every page load. */
    index("saved_report_filters_user_zone_report_idx").on(
      table.userId,
      table.zoneId,
      table.reportId,
    ),
  ],
);

export type SavedReportFilter = typeof savedReportFilters.$inferSelect;
export type NewSavedReportFilter = typeof savedReportFilters.$inferInsert;
