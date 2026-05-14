// packages/db/src/schema/targets.ts
// Phase 8 — financial targets per (zone, chapter?, giving_type,
// ministry_year). Zone-wide targets carry `chapter_id IS NULL`.
// Targets aren't soft-deletable; the audit log keeps history.
// RELEVANT FILES: docs/DOMAIN-MODEL.md §8, packages/db/src/schema/giving.ts, packages/db/src/schema/periods.ts, packages/api/src/routes/tenant-targets.ts

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { chapters } from "./chapters";
import { givingTypes } from "./giving";
import { ministryYears } from "./periods";
import { zones } from "./zones";

const MONEY = { precision: 19, scale: 4 } as const;

/**
 * One row per `(zone, chapter?, giving_type, ministry_year)` tuple.
 * `chapter_id IS NULL` means "zone-wide target" — every chapter in
 * the zone aggregates against it. The two partial unique indexes
 * keep that interpretation enforceable: a normal unique constraint
 * would let multiple zone-wide rows coexist because Postgres treats
 * NULL as distinct.
 */
export const financialTargets = pgTable(
  "financial_targets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id"),
    givingTypeId: text("giving_type_id").notNull(),
    ministryYearId: text("ministry_year_id").notNull(),
    fullTarget: numeric("full_target", MONEY).notNull(),
    monthlyTarget: numeric("monthly_target", MONEY),
    weeklyBreakdown: numeric("weekly_breakdown", MONEY),
    fullTargetCopies: integer("full_target_copies"),
    numberOfPartners: integer("number_of_partners"),
    currencyCode: text("currency_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("financial_targets_zone_id_unique").on(table.zoneId, table.id),
    // Chapter-scoped uniqueness: one row per
    // (zone, chapter, giving_type, ministry_year).
    uniqueIndex("financial_targets_chapter_tuple_idx")
      .on(
        table.zoneId,
        table.chapterId,
        table.givingTypeId,
        table.ministryYearId,
      )
      .where(sql`${table.chapterId} is not null`),
    // Zone-wide uniqueness: one row per
    // (zone, giving_type, ministry_year) when chapter_id is null.
    uniqueIndex("financial_targets_zone_tuple_idx")
      .on(table.zoneId, table.givingTypeId, table.ministryYearId)
      .where(sql`${table.chapterId} is null`),
    index("financial_targets_zone_year_type_idx").on(
      table.zoneId,
      table.ministryYearId,
      table.givingTypeId,
    ),
    foreignKey({
      name: "financial_targets_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "financial_targets_giving_type_zone_fk",
      columns: [table.zoneId, table.givingTypeId],
      foreignColumns: [givingTypes.zoneId, givingTypes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "financial_targets_ministry_year_zone_fk",
      columns: [table.zoneId, table.ministryYearId],
      foreignColumns: [ministryYears.zoneId, ministryYears.id],
    }).onDelete("restrict"),
    // Money fields must be non-negative. `null` is the explicit
    // "not yet set" sentinel and stays permitted on optional cols.
    check(
      "financial_targets_money_nonneg",
      sql`${table.fullTarget} >= 0
          and (${table.monthlyTarget} is null or ${table.monthlyTarget} >= 0)
          and (${table.weeklyBreakdown} is null or ${table.weeklyBreakdown} >= 0)`,
    ),
    check(
      "financial_targets_counts_nonneg",
      sql`(${table.fullTargetCopies} is null or ${table.fullTargetCopies} >= 0)
          and (${table.numberOfPartners} is null or ${table.numberOfPartners} >= 0)`,
    ),
  ],
);

export type FinancialTarget = typeof financialTargets.$inferSelect;
export type NewFinancialTarget = typeof financialTargets.$inferInsert;
