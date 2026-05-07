// packages/db/src/schema/periods.ts
// Per-zone date dimensions for giving, fiscal, ministry, and partnership
// reporting. Seeded at zone creation and extended by scheduled jobs.

import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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
    unique("fiscal_years_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("fiscal_years_zone_label_idx").on(table.zoneId, table.yearLabel),
    index("fiscal_years_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
    check("fiscal_years_dates_check", sql`${table.endDate} >= ${table.startDate}`),
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
    fiscalYearId: text("fiscal_year_id").notNull(),
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
    unique("fiscal_periods_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("fiscal_periods_zone_year_number_idx").on(
      table.zoneId,
      table.fiscalYearId,
      table.periodNumber,
    ),
    index("fiscal_periods_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
    index("fiscal_periods_status_idx").on(table.status),
    foreignKey({
      name: "fiscal_periods_year_zone_fk",
      columns: [table.zoneId, table.fiscalYearId],
      foreignColumns: [fiscalYears.zoneId, fiscalYears.id],
    }).onDelete("cascade"),
    check("fiscal_periods_number_check", sql`${table.periodNumber} between 1 and 12`),
    check("fiscal_periods_dates_check", sql`${table.endDate} >= ${table.startDate}`),
    check("fiscal_periods_status_check", sql`${table.status} in ('open', 'closing', 'closed')`),
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
    unique("ministry_years_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("ministry_years_zone_label_idx").on(table.zoneId, table.yearLabel),
    index("ministry_years_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
    check("ministry_years_dates_check", sql`${table.endDate} >= ${table.startDate}`),
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
    ministryYearId: text("ministry_year_id").notNull(),
    periodNumber: integer("period_number").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("ministry_periods_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("ministry_periods_zone_year_number_idx").on(
      table.zoneId,
      table.ministryYearId,
      table.periodNumber,
    ),
    index("ministry_periods_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
    foreignKey({
      name: "ministry_periods_year_zone_fk",
      columns: [table.zoneId, table.ministryYearId],
      foreignColumns: [ministryYears.zoneId, ministryYears.id],
    }).onDelete("cascade"),
    check("ministry_periods_number_check", sql`${table.periodNumber} between 1 and 12`),
    check("ministry_periods_dates_check", sql`${table.endDate} >= ${table.startDate}`),
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
    unique("partnership_years_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("partnership_years_zone_label_idx").on(table.zoneId, table.yearLabel),
    index("partnership_years_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
    check("partnership_years_dates_check", sql`${table.endDate} >= ${table.startDate}`),
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
    partnershipYearId: text("partnership_year_id").notNull(),
    periodNumber: integer("period_number").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("partnership_periods_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("partnership_periods_zone_year_number_idx").on(
      table.zoneId,
      table.partnershipYearId,
      table.periodNumber,
    ),
    index("partnership_periods_zone_dates_idx").on(table.zoneId, table.startDate, table.endDate),
    foreignKey({
      name: "partnership_periods_year_zone_fk",
      columns: [table.zoneId, table.partnershipYearId],
      foreignColumns: [partnershipYears.zoneId, partnershipYears.id],
    }).onDelete("cascade"),
    check("partnership_periods_number_check", sql`${table.periodNumber} between 1 and 12`),
    check("partnership_periods_dates_check", sql`${table.endDate} >= ${table.startDate}`),
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
    fiscalPeriodId: text("fiscal_period_id").notNull(),
    ministryPeriodId: text("ministry_period_id").notNull(),
    partnershipPeriodId: text("partnership_period_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("giving_periods_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("giving_periods_zone_date_idx").on(table.zoneId, table.date),
    index("giving_periods_zone_fiscal_idx").on(table.zoneId, table.fiscalPeriodId),
    index("giving_periods_zone_ministry_idx").on(table.zoneId, table.ministryPeriodId),
    index("giving_periods_zone_partnership_idx").on(table.zoneId, table.partnershipPeriodId),
    index("giving_periods_month_idx").on(table.zoneId, table.isoYear, table.month),
    foreignKey({
      name: "giving_periods_fiscal_period_zone_fk",
      columns: [table.zoneId, table.fiscalPeriodId],
      foreignColumns: [fiscalPeriods.zoneId, fiscalPeriods.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "giving_periods_ministry_period_zone_fk",
      columns: [table.zoneId, table.ministryPeriodId],
      foreignColumns: [ministryPeriods.zoneId, ministryPeriods.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "giving_periods_partnership_period_zone_fk",
      columns: [table.zoneId, table.partnershipPeriodId],
      foreignColumns: [partnershipPeriods.zoneId, partnershipPeriods.id],
    }).onDelete("restrict"),
    check("giving_periods_weekday_check", sql`${table.weekday} between 1 and 7`),
    check("giving_periods_iso_week_check", sql`${table.isoWeek} between 1 and 53`),
    check("giving_periods_month_check", sql`${table.month} between 1 and 12`),
    check("giving_periods_quarter_check", sql`${table.quarter} between 1 and 4`),
  ],
);

export type FiscalYear = typeof fiscalYears.$inferSelect;
export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type MinistryYear = typeof ministryYears.$inferSelect;
export type MinistryPeriod = typeof ministryPeriods.$inferSelect;
export type PartnershipYear = typeof partnershipYears.$inferSelect;
export type PartnershipPeriod = typeof partnershipPeriods.$inferSelect;
export type GivingPeriod = typeof givingPeriods.$inferSelect;
