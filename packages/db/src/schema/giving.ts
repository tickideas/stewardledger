// packages/db/src/schema/giving.ts
// Giving setup tables: categories, giving types, payment methods, accounts,
// type-to-account mappings, and service events.

import { sql } from "drizzle-orm";
import {
  boolean,
  type AnyPgColumn,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
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
    uniqueIndex("giving_categories_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    uniqueIndex("giving_categories_zone_short_code_lower_idx")
      .on(table.zoneId, sql`lower(${table.shortCode})`)
      .where(sql`${table.shortCode} is not null`),
    index("giving_categories_zone_idx").on(table.zoneId),
    index("giving_categories_parent_idx").on(table.parentCategoryId),
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
    uniqueIndex("accounts_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    index("accounts_zone_idx").on(table.zoneId),
    index("accounts_currency_idx").on(table.zoneId, table.currencyCode),
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
    categoryId: text("category_id")
      .notNull()
      .references(() => givingCategories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    shortCode: text("short_code"),
    isZonal: boolean("is_zonal").notNull().default(false),
    isChapter: boolean("is_chapter").notNull().default(true),
    hasPartnershipTarget: boolean("has_partnership_target").notNull().default(false),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    ordinal: integer("ordinal").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("giving_types_zone_name_lower_idx").on(table.zoneId, sql`lower(${table.name})`),
    uniqueIndex("giving_types_zone_short_code_lower_idx")
      .on(table.zoneId, sql`lower(${table.shortCode})`)
      .where(sql`${table.shortCode} is not null`),
    index("giving_types_zone_idx").on(table.zoneId),
    index("giving_types_category_idx").on(table.categoryId),
    index("giving_types_account_idx").on(table.accountId),
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
    givingTypeId: text("giving_type_id")
      .notNull()
      .references(() => givingTypes.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
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
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    serviceTypeId: text("service_type_id")
      .notNull()
      .references(() => serviceTypes.id, { onDelete: "restrict" }),
    serviceDate: date("service_date").notNull(),
    givingPeriodId: text("giving_period_id").references(() => givingPeriods.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("service_events_zone_date_idx").on(table.zoneId, table.serviceDate),
    index("service_events_chapter_date_idx").on(table.chapterId, table.serviceDate),
    index("service_events_type_idx").on(table.serviceTypeId),
  ],
);

export type GivingCategory = typeof givingCategories.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type GivingType = typeof givingTypes.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type GivingTypeAccount = typeof givingTypeAccounts.$inferSelect;
export type ServiceType = typeof serviceTypes.$inferSelect;
export type ServiceEvent = typeof serviceEvents.$inferSelect;
