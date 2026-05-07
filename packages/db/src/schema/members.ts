// packages/db/src/schema/members.ts
// Members and their addresses. See docs/DOMAIN-MODEL.md §3.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import { regions } from "./regions";
import { zones } from "./zones";
import { maritalStatuses, memberTypes, titles } from "./lookups";

export const members = pgTable(
  "members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),
    /** Denormalized from the home chapter's zone for fast region-aware reports. */
    regionId: text("region_id").references(() => regions.id, { onDelete: "set null" }),
    /** Home chapter. Null = no fixed chapter (visiting / pending placement). */
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    /** e.g. "M0000001". Generator preserves a per-zone branding-overridable prefix. */
    referenceCode: text("reference_code").notNull(),
    titleId: text("title_id").references(() => titles.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    middleNames: text("middle_names"),
    lastName: text("last_name"),
    /**
     * Postgres-generated read-only concat of name parts. Uses `||` + COALESCE
     * (both immutable) plus a regex collapse of repeated spaces — `concat_ws`
     * is only STABLE in Postgres and so cannot power a generated column.
     */
    fullName: text("full_name").generatedAlwaysAs(
      sql`trim(both ' ' from regexp_replace(
        coalesce(first_name, '') || ' ' || coalesce(middle_names, '') || ' ' || coalesce(last_name, ''),
        '\s+', ' ', 'g'
      ))`,
    ),
    /** "M" | "F" | "U" | null. */
    gender: text("gender"),
    email: text("email"),
    dateOfBirth: date("date_of_birth"),
    mobile: text("mobile"),
    telephone: text("telephone"),
    kingschatUsername: text("kingschat_username"),
    isActive: boolean("is_active").notNull().default(true),
    maritalStatusId: text("marital_status_id").references(() => maritalStatuses.id, {
      onDelete: "set null",
    }),
    memberTypeId: text("member_type_id").references(() => memberTypes.id, {
      onDelete: "set null",
    }),
    dateJoinedMinistry: date("date_joined_ministry"),
    foundationSchoolGraduationDate: date("foundation_school_graduation_date"),
    isCell: boolean("is_cell").notNull().default(false),
    isDepartment: boolean("is_department").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("members_zone_id_unique").on(table.zoneId, table.id),
    uniqueIndex("members_zone_reference_idx").on(table.zoneId, table.referenceCode),
    index("members_zone_chapter_idx").on(table.zoneId, table.chapterId),
    index("members_zone_active_idx")
      .on(table.zoneId)
      .where(sql`deleted_at is null and is_active = true`),
    index("members_zone_email_lower_idx").on(table.zoneId, sql`lower(${table.email})`),
    index("members_zone_full_name_lower_idx").on(table.zoneId, sql`lower(${table.fullName})`),
    check(
      "members_gender_valid",
      sql`gender is null or gender in ('M', 'F', 'U')`,
    ),
  ],
);

export const memberAddresses = pgTable(
  "member_addresses",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    line1: text("line1"),
    line2: text("line2"),
    city: text("city"),
    regionText: text("region_text"),
    postcode: text("postcode"),
    countryCode: text("country_code"),
    dateFrom: date("date_from").notNull(),
    /** Null = currently active. Set = archived. */
    dateTo: date("date_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("member_addresses_member_idx").on(table.memberId),
    index("member_addresses_zone_idx").on(table.zoneId),
    /** Only one primary, currently-active address per member. */
    uniqueIndex("member_addresses_one_primary_active_idx")
      .on(table.memberId)
      .where(sql`is_primary = true and date_to is null`),
  ],
);

/**
 * Merge proposals: identifies a primary member that should absorb a duplicate.
 * The auto-detection job lands in Phase 6 alongside imports; Phase 3 only
 * stores manually-proposed pairs and applies them.
 */
export const memberMergeProposals = pgTable(
  "member_merge_proposals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    primaryMemberId: text("primary_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    duplicateMemberId: text("duplicate_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    matchScore: numeric("match_score", { precision: 5, scale: 2 }).notNull().default("0.00"),
    matchedFields: jsonb("matched_fields").$type<string[]>().notNull().default([]),
    proposedByUserId: text("proposed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** pending | approved | rejected | applied */
    status: text("status").notNull().default("pending"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (table) => [
    index("member_merge_proposals_zone_status_idx").on(table.zoneId, table.status),
    index("member_merge_proposals_primary_idx").on(table.primaryMemberId),
    index("member_merge_proposals_duplicate_idx").on(table.duplicateMemberId),
    check(
      "member_merge_proposals_distinct",
      sql`primary_member_id <> duplicate_member_id`,
    ),
    check(
      "member_merge_proposals_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'applied')`,
    ),
    /** Only one open (pending|approved) proposal per (primary, duplicate) pair. */
    uniqueIndex("member_merge_proposals_open_pair_idx")
      .on(table.primaryMemberId, table.duplicateMemberId)
      .where(sql`status in ('pending', 'approved')`),
  ],
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type MemberAddress = typeof memberAddresses.$inferSelect;
export type NewMemberAddress = typeof memberAddresses.$inferInsert;
export type MemberMergeProposal = typeof memberMergeProposals.$inferSelect;
export type NewMemberMergeProposal = typeof memberMergeProposals.$inferInsert;
