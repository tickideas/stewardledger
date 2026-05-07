// packages/db/src/schema/periods.ts
// Per-zone date dimensions for giving, fiscal, ministry, and partnership
// reporting. Seeded at zone creation and extended by scheduled jobs.

import { sql } from "drizzle-orm";
import { date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { zones } from "./zones";

export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    yearLabel: text("year_label").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fiscal_years_zone_label_idx").on(table.zoneId, table.yearLabel),
    index("fiscal_years_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
  ],
);

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    fiscalYearId: text("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    periodNumber: integer("period_number").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: text("closed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fiscal_periods_zone_year_number_idx").on(
      table.zoneId,
      table.fiscalYearId,
      table.periodNumber,
    ),
    index("fiscal_periods_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
    index("fiscal_periods_status_idx").on(table.status),
  ],
);

export const ministryYears = pgTable(
  "ministry_years",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    yearLabel: text("year_label").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ministry_years_zone_label_idx").on(table.zoneId, table.yearLabel),
    index("ministry_years_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
  ],
);

export const ministryPeriods = pgTable(
  "ministry_periods",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    ministryYearId: text("ministry_year_id")
      .notNull()
      .references(() => ministryYears.id, { onDelete: "cascade" }),
    periodNumber: integer("period_number").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ministry_periods_zone_year_number_idx").on(
      table.zoneId,
      table.ministryYearId,
      table.periodNumber,
    ),
    index("ministry_periods_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
  ],
);

export const partnershipYears = pgTable(
  "partnership_years",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    yearLabel: text("year_label").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("partnership_years_zone_label_idx").on(table.zoneId, table.yearLabel),
    index("partnership_years_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
  ],
);

export const partnershipPeriods = pgTable(
  "partnership_periods",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    partnershipYearId: text("partnership_year_id")
      .notNull()
      .references(() => partnershipYears.id, { onDelete: "cascade" }),
    periodNumber: integer("period_number").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("partnership_periods_zone_year_number_idx").on(
      table.zoneId,
      table.partnershipYearId,
      table.periodNumber,
    ),
    index("partnership_periods_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
  ],
);

export const givingPeriods = pgTable(
  "giving_periods",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    weekday: integer("weekday").notNull(),
    isoWeek: integer("iso_week").notNull(),
    isoYear: integer("iso_year").notNull(),
    month: integer("month").notNull(),
    quarter: integer("quarter").notNull(),
    fiscalPeriodId: text("fiscal_period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "restrict" }),
    ministryPeriodId: text("ministry_period_id")
      .notNull()
      .references(() => ministryPeriods.id, { onDelete: "restrict" }),
    partnershipPeriodId: text("partnership_period_id")
      .notNull()
      .references(() => partnershipPeriods.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("giving_periods_zone_date_idx").on(table.zoneId, table.date),
    index("giving_periods_zone_fiscal_idx").on(table.zoneId, table.fiscalPeriodId),
    index("giving_periods_zone_ministry_idx").on(table.zoneId, table.ministryPeriodId),
    index("giving_periods_zone_partnership_idx").on(table.zoneId, table.partnershipPeriodId),
    index("giving_periods_month_idx").on(table.zoneId, table.isoYear, table.month),
    index("giving_periods_valid_weekday_idx").on(table.weekday).where(sql`weekday between 1 and 7`),
  ],
);

export type FiscalYear = typeof fiscalYears.$inferSelect;
export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type MinistryYear = typeof ministryYears.$inferSelect;
export type MinistryPeriod = typeof ministryPeriods.$inferSelect;
export type PartnershipYear = typeof partnershipYears.$inferSelect;
export type PartnershipPeriod = typeof partnershipPeriods.$inferSelect;
export type GivingPeriod = typeof givingPeriods.$inferSelect;
