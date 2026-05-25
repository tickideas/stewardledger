// packages/db/src/schema/zones.ts
// The zone is the SaaS tenant. Every domain table elsewhere references zones.id
// via a `zone_id NOT NULL` column. See docs/DOMAIN-MODEL.md §2.3.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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
    /**
     * Role codes that REQUIRE TOTP MFA for users holding them in
     * this zone. Empty by default (opt-in per zone). The post-auth
     * landing path redirects an MFA-less user with a matching role
     * to `/account/security?required=1` until they enrol. Sign-in
     * itself is never blocked — the user keeps a session so they
     * can complete enrolment without an out-of-band recovery flow.
     */
    mfaRequiredRoleCodes: text("mfa_required_role_codes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * Per-zone data retention policy. `jsonb` so dimensions can grow
     * without a migration each time. The Zod schema in
     * `@stewardledger/shared` is the canonical contract — every read
     * hydrates defaults so the column itself can stay empty for new
     * zones. See `packages/api/src/services/retention/`.
     */
    retentionPolicy: jsonb("retention_policy").notNull().default({}),
    groupsEnabled: boolean("groups_enabled").notNull().default(false),
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
    uniqueIndex("zones_name_lower_idx").on(sql`lower(${table.name})`),
    index("zones_region_id_idx").on(table.regionId),
    index("zones_status_idx").on(table.status),
    /** Inbox: zones still on a free-text region. */
    index("zones_unverified_region_idx")
      .on(table.createdAt)
      .where(sql`region_id is null and region_name_unverified is not null`),
    /** Exactly one of region_id or region_name_unverified must be set. */
    check(
      "zones_region_xor_unverified",
      sql`(region_id is not null and region_name_unverified is null)
          or (region_id is null and region_name_unverified is not null)`,
    ),
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
