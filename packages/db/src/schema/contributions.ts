// packages/db/src/schema/contributions.ts
// Phase 5 — unified contributions model. One shape covers envelope batches,
// online giving, manual entry, and bank-import lines. See docs/DOMAIN-MODEL.md §6.
//
// Hard rules enforced here (and reinforced by triggers in `bootstrap-triggers.ts`):
//   • All money is `numeric(19,4)` paired with `currency_code`.
//   • Posted contributions and their lines are immutable; corrections are
//     reversals (`reversal_of_contribution_id`), never silent updates.
//   • A contribution and its lines share one `currency_code`.
//   • Every domain row carries `zone_id`; cross-tenant references are blocked
//     by composite `(zone_id, id)` foreign keys.

import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import { accounts, givingTypes, paymentMethods, serviceEvents } from "./giving";
import { members } from "./members";
import { givingPeriods } from "./periods";
import { regions } from "./regions";
import { zones } from "./zones";

const MONEY = { precision: 19, scale: 4 } as const;

export const contributionBatches = pgTable(
  "contribution_batches",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").notNull(),
    serviceEventId: text("service_event_id"),
    paymentMethodId: text("payment_method_id"),
    /** envelope | online | bank_import | oblation | manual */
    sourceType: text("source_type").notNull(),
    /** draft | submitted | approved | posted | voided */
    status: text("status").notNull().default("draft"),
    referenceCode: text("reference_code"),
    cashTotal: numeric("cash_total", MONEY),
    chequeTotal: numeric("cheque_total", MONEY),
    currencyCode: text("currency_code").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedByUserId: text("submitted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedByUserId: text("posted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: text("voided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
  },
  (table) => [
    unique("contribution_batches_zone_id_unique").on(table.zoneId, table.id),
    index("contribution_batches_zone_status_idx").on(table.zoneId, table.status),
    index("contribution_batches_zone_chapter_idx").on(table.zoneId, table.chapterId),
    index("contribution_batches_service_event_idx").on(table.serviceEventId),
    foreignKey({
      name: "contribution_batches_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contribution_batches_service_event_zone_fk",
      columns: [table.zoneId, table.serviceEventId],
      foreignColumns: [serviceEvents.zoneId, serviceEvents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contribution_batches_payment_method_zone_fk",
      columns: [table.zoneId, table.paymentMethodId],
      foreignColumns: [paymentMethods.zoneId, paymentMethods.id],
    }).onDelete("restrict"),
    check(
      "contribution_batches_source_type_check",
      sql`${table.sourceType} in ('envelope', 'online', 'bank_import', 'oblation', 'manual')`,
    ),
    check(
      "contribution_batches_status_check",
      sql`${table.status} in ('draft', 'submitted', 'approved', 'posted', 'voided')`,
    ),
    check(
      "contribution_batches_cash_total_nonneg",
      sql`${table.cashTotal} is null or ${table.cashTotal} >= 0`,
    ),
    check(
      "contribution_batches_cheque_total_nonneg",
      sql`${table.chequeTotal} is null or ${table.chequeTotal} >= 0`,
    ),
  ],
);

export const contributions = pgTable(
  "contributions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    /** Denormalized for fast region-aware reports. Refreshed by zone-region jobs. */
    regionId: text("region_id").references(() => regions.id, { onDelete: "set null" }),
    batchId: text("batch_id"),
    chapterId: text("chapter_id").notNull(),
    /** Null allowed for anonymous / unallocated contributions. */
    memberId: text("member_id"),
    /** Set only on the corrective contribution that reverses an earlier one. */
    parentContributionId: text("parent_contribution_id"),
    /** envelope | online | bank_import | oblation | manual */
    sourceType: text("source_type").notNull(),
    paymentMethodId: text("payment_method_id"),
    serviceEventId: text("service_event_id"),
    givingPeriodId: text("giving_period_id"),
    contributionDate: date("contribution_date").notNull(),
    totalAmount: numeric("total_amount", MONEY).notNull(),
    currencyCode: text("currency_code").notNull(),
    externalTransactionId: text("external_transaction_id"),
    description: text("description"),
    /** draft | posted | voided | reversed */
    status: text("status").notNull().default("draft"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedByUserId: text("posted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: text("voided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    reversalOfContributionId: text("reversal_of_contribution_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    unique("contributions_zone_id_unique").on(table.zoneId, table.id),
    index("contributions_zone_chapter_date_idx").on(
      table.zoneId,
      table.chapterId,
      table.contributionDate.desc(),
    ),
    index("contributions_zone_member_date_idx").on(
      table.zoneId,
      table.memberId,
      table.contributionDate.desc(),
    ),
    index("contributions_zone_status_idx").on(table.zoneId, table.status),
    index("contributions_zone_period_idx").on(table.zoneId, table.givingPeriodId),
    index("contributions_batch_idx").on(table.batchId),
    foreignKey({
      name: "contributions_batch_zone_fk",
      columns: [table.zoneId, table.batchId],
      foreignColumns: [contributionBatches.zoneId, contributionBatches.id],
    }).onDelete("set null"),
    foreignKey({
      name: "contributions_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contributions_member_zone_fk",
      columns: [table.zoneId, table.memberId],
      foreignColumns: [members.zoneId, members.id],
    }).onDelete("set null"),
    foreignKey({
      name: "contributions_payment_method_zone_fk",
      columns: [table.zoneId, table.paymentMethodId],
      foreignColumns: [paymentMethods.zoneId, paymentMethods.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contributions_service_event_zone_fk",
      columns: [table.zoneId, table.serviceEventId],
      foreignColumns: [serviceEvents.zoneId, serviceEvents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contributions_giving_period_zone_fk",
      columns: [table.zoneId, table.givingPeriodId],
      foreignColumns: [givingPeriods.zoneId, givingPeriods.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contributions_reversal_of_zone_fk",
      columns: [table.zoneId, table.reversalOfContributionId],
      foreignColumns: [table.zoneId, table.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contributions_parent_zone_fk",
      columns: [table.zoneId, table.parentContributionId],
      foreignColumns: [table.zoneId, table.id],
    }).onDelete("restrict"),
    check(
      "contributions_source_type_check",
      sql`${table.sourceType} in ('envelope', 'online', 'bank_import', 'oblation', 'manual')`,
    ),
    check(
      "contributions_status_check",
      sql`${table.status} in ('draft', 'posted', 'voided', 'reversed')`,
    ),
    check("contributions_total_nonneg", sql`${table.totalAmount} >= 0`),
    check(
      "contributions_posted_requires_timestamp",
      sql`(${table.status} <> 'posted') or (${table.postedAt} is not null)`,
    ),
    check(
      "contributions_voided_requires_timestamp",
      sql`(${table.status} <> 'voided') or (${table.voidedAt} is not null)`,
    ),
  ],
);

export const contributionLines = pgTable(
  "contribution_lines",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    contributionId: text("contribution_id").notNull(),
    givingTypeId: text("giving_type_id").notNull(),
    /** Optional override; usually inherited from giving_types.account_id. */
    accountId: text("account_id"),
    amount: numeric("amount", MONEY).notNull(),
    currencyCode: text("currency_code").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("contribution_lines_zone_id_unique").on(table.zoneId, table.id),
    index("contribution_lines_contribution_idx").on(table.contributionId),
    index("contribution_lines_zone_giving_type_idx").on(table.zoneId, table.givingTypeId),
    index("contribution_lines_zone_account_idx").on(table.zoneId, table.accountId),
    foreignKey({
      name: "contribution_lines_contribution_zone_fk",
      columns: [table.zoneId, table.contributionId],
      foreignColumns: [contributions.zoneId, contributions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contribution_lines_giving_type_zone_fk",
      columns: [table.zoneId, table.givingTypeId],
      foreignColumns: [givingTypes.zoneId, givingTypes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contribution_lines_account_zone_fk",
      columns: [table.zoneId, table.accountId],
      foreignColumns: [accounts.zoneId, accounts.id],
    }).onDelete("restrict"),
    check("contribution_lines_amount_nonneg", sql`${table.amount} >= 0`),
  ],
);

export const contributionMembers = pgTable(
  "contribution_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    contributionId: text("contribution_id").notNull(),
    memberId: text("member_id").notNull(),
    allocationPercent: numeric("allocation_percent", { precision: 5, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("contribution_members_unique").on(table.contributionId, table.memberId),
    index("contribution_members_member_idx").on(table.memberId),
    foreignKey({
      name: "contribution_members_contribution_zone_fk",
      columns: [table.zoneId, table.contributionId],
      foreignColumns: [contributions.zoneId, contributions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contribution_members_member_zone_fk",
      columns: [table.zoneId, table.memberId],
      foreignColumns: [members.zoneId, members.id],
    }).onDelete("restrict"),
    check(
      "contribution_members_allocation_range",
      sql`${table.allocationPercent} is null or (${table.allocationPercent} >= 0 and ${table.allocationPercent} <= 100)`,
    ),
  ],
);

export type ContributionBatch = typeof contributionBatches.$inferSelect;
export type NewContributionBatch = typeof contributionBatches.$inferInsert;
export type Contribution = typeof contributions.$inferSelect;
export type NewContribution = typeof contributions.$inferInsert;
export type ContributionLine = typeof contributionLines.$inferSelect;
export type NewContributionLine = typeof contributionLines.$inferInsert;
export type ContributionMember = typeof contributionMembers.$inferSelect;
export type NewContributionMember = typeof contributionMembers.$inferInsert;
