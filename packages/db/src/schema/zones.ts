// packages/db/src/schema/zones.ts
// The zone is the SaaS tenant. Every domain table elsewhere references zones.id
// via a `zone_id NOT NULL` column. See docs/DOMAIN-MODEL.md §2.3.

import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { regions } from "./regions";
import { user } from "./auth";

export const zones = pgTable(
  "zones",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Either regionId or regionNameUnverified must be set, never both. */
    regionId: text("region_id").references(() => regions.id, { onDelete: "set null" }),
    regionNameUnverified: text("region_name_unverified"),
    /** Subdomain — kebab-case, lowercase. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    countryCode: text("country_code").notNull(),
    defaultCurrencyCode: text("default_currency_code").notNull(),
    defaultTimeZone: text("default_time_zone").notNull(),
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
    ministryYearStartMonth: integer("ministry_year_start_month").notNull().default(3),
    /** pending_setup | active | past_due | suspended */
    status: text("status").notNull().default("pending_setup"),
    branding: jsonb("branding").notNull().default({}),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    primaryContactUserId: text("primary_contact_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("zones_slug_idx").on(table.slug),
    index("zones_region_id_idx").on(table.regionId),
    index("zones_status_idx").on(table.status),
  ],
);

export const customDomains = pgTable(
  "custom_domains",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    /** pending | verifying | active | failed */
    status: text("status").notNull().default("pending"),
    verificationStartedAt: timestamp("verification_started_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("custom_domains_hostname_idx").on(table.hostname),
    index("custom_domains_zone_id_idx").on(table.zoneId),
  ],
);

export type Zone = typeof zones.$inferSelect;
export type NewZone = typeof zones.$inferInsert;
export type CustomDomain = typeof customDomains.$inferSelect;
