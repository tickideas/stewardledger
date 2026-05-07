// packages/db/src/schema/giving.ts
// Giving setup tables: categories, giving types, payment methods, accounts,
// type-to-account mappings, and service events.

import { sql } from "drizzle-orm";
import {
  boolean,
  type AnyPgColumn,
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
import { chapters } from "./chapters";
import { givingPeriods } from "./periods";
import { zones } from "./zones";

export const givingCategories = pgTable(
  "giving_categories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    parentCategoryId: text("parent_category_id").references(
      (): AnyPgColumn => givingCategories.id,
      { onDelete: "restrict" },
    ),
    name: text("name").notNull(),
    shortCode: text("short_code"),
    ordinal: integer("ordinal").notNull().default(0),
    dateFrom: date("date_from").notNull().default(sql`now()::date`),
    dateTo: date("date_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("giving_categories_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("giving_categories_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    uniqueIndex("giving_categories_zone_short_code_lower_idx")
      .on(table.zoneId, sql`lower(${table.shortCode})`)
      .where(sql`${table.shortCode} is not null`),
    index("giving_categories_zone_idx").on(table.zoneId),
    index("giving_categories_parent_idx").on(table.parentCategoryId),
    foreignKey({
      name: "giving_categories_parent_zone_fk",
      columns: [table.zoneId, table.parentCategoryId],
      foreignColumns: [table.zoneId, table.id],
    }).onDelete("restrict"),
    check("giving_categories_dates_check", sql`${table.dateTo} is null or ${table.dateTo} >= ${table.dateFrom}`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    currencyCode: text("currency_code").notNull(),
    dateFrom: date("date_from").notNull().default(sql`now()::date`),
    dateTo: date("date_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("accounts_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("accounts_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    index("accounts_zone_idx").on(table.zoneId),
    index("accounts_currency_idx").on(table.zoneId, table.currencyCode),
    check("accounts_dates_check", sql`${table.dateTo} is null or ${table.dateTo} >= ${table.dateFrom}`),
  ],
);

export const givingTypes = pgTable(
  "giving_types",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    categoryId: text("category_id").notNull(),
    name: text("name").notNull(),
    shortCode: text("short_code"),
    isZonal: boolean("is_zonal").notNull().default(false),
    isChapter: boolean("is_chapter").notNull().default(true),
    hasPartnershipTarget: boolean("has_partnership_target").notNull().default(false),
    accountId: text("account_id"),
    ordinal: integer("ordinal").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("giving_types_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("giving_types_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    uniqueIndex("giving_types_zone_short_code_lower_idx")
      .on(table.zoneId, sql`lower(${table.shortCode})`)
      .where(sql`${table.shortCode} is not null`),
    index("giving_types_zone_idx").on(table.zoneId),
    index("giving_types_category_idx").on(table.categoryId),
    index("giving_types_account_idx").on(table.accountId),
    foreignKey({
      name: "giving_types_category_zone_fk",
      columns: [table.zoneId, table.categoryId],
      foreignColumns: [givingCategories.zoneId, givingCategories.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "giving_types_account_zone_fk",
      columns: [table.zoneId, table.accountId],
      foreignColumns: [accounts.zoneId, accounts.id],
    }).onDelete("restrict"),
  ],
);

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ordinal: integer("ordinal").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("payment_methods_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("payment_methods_zone_code_lower_idx").on(table.zoneId, sql`lower(${table.code})`),
    uniqueIndex("payment_methods_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    index("payment_methods_zone_idx").on(table.zoneId),
  ],
);

export const givingTypeAccounts = pgTable(
  "giving_type_accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    givingTypeId: text("giving_type_id").notNull(),
    accountId: text("account_id").notNull(),
    dateFrom: date("date_from").notNull().default(sql`now()::date`),
    dateTo: date("date_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("giving_type_accounts_current_idx")
      .on(table.zoneId, table.givingTypeId)
      .where(sql`${table.dateTo} is null`),
    index("giving_type_accounts_account_idx").on(table.zoneId, table.accountId),
    foreignKey({
      name: "giving_type_accounts_type_zone_fk",
      columns: [table.zoneId, table.givingTypeId],
      foreignColumns: [givingTypes.zoneId, givingTypes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "giving_type_accounts_account_zone_fk",
      columns: [table.zoneId, table.accountId],
      foreignColumns: [accounts.zoneId, accounts.id],
    }).onDelete("restrict"),
    check("giving_type_accounts_dates_check", sql`${table.dateTo} is null or ${table.dateTo} >= ${table.dateFrom}`),
  ],
);

export const serviceTypes = pgTable(
  "service_types",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    shortCode: text("short_code"),
    isActive: boolean("is_active").notNull().default(true),
    ordinal: integer("ordinal").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("service_types_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("service_types_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    uniqueIndex("service_types_zone_short_code_lower_idx")
      .on(table.zoneId, sql`lower(${table.shortCode})`)
      .where(sql`${table.shortCode} is not null`),
    index("service_types_zone_idx").on(table.zoneId),
  ],
);

export const serviceEvents = pgTable(
  "service_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id"),
    serviceTypeId: text("service_type_id").notNull(),
    serviceDate: date("service_date").notNull(),
    givingPeriodId: text("giving_period_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("service_events_zone_id_unique").on(table.zoneId, table.id),
    index("service_events_zone_date_idx").on(table.zoneId, table.serviceDate),
    index("service_events_chapter_date_idx").on(table.chapterId, table.serviceDate),
    index("service_events_type_idx").on(table.serviceTypeId),
    foreignKey({
      name: "service_events_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "service_events_service_type_zone_fk",
      columns: [table.zoneId, table.serviceTypeId],
      foreignColumns: [serviceTypes.zoneId, serviceTypes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "service_events_giving_period_zone_fk",
      columns: [table.zoneId, table.givingPeriodId],
      foreignColumns: [givingPeriods.zoneId, givingPeriods.id],
    }).onDelete("restrict"),
  ],
);

export type GivingCategory = typeof givingCategories.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type GivingType = typeof givingTypes.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type GivingTypeAccount = typeof givingTypeAccounts.$inferSelect;
export type ServiceType = typeof serviceTypes.$inferSelect;
export type ServiceEvent = typeof serviceEvents.$inferSelect;
