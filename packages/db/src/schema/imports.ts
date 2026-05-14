// packages/db/src/schema/imports.ts
// Phase 6 — import pipeline schema. See docs/DOMAIN-MODEL.md §7.
//
// Pipeline: upload → parse → match → schedule (preview) → commit. Every
// row carries `zone_id`; cross-tenant references are blocked by composite
// `(zone_id, id)` FKs as elsewhere. The state machine on `import_jobs.status`
// is enforced in the service layer, not in triggers.
//
// Idempotency: `processed_transactions(zone_id, external_transaction_id)` is
// the row-level guard. File-level upload dedupe is keyed by zone, checksum,
// file type, source type, and chapter scope. The match step skips rows whose
// `external_transaction_id` is already present; the commit step records new
// ones inside the same tx that inserts the contribution.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import {
  accounts,
  givingTypes,
  paymentMethods,
  serviceEvents,
} from "./giving";
import { contributions } from "./contributions";
import { members } from "./members";
import { givingPeriods } from "./periods";
import { zones } from "./zones";

export const importFiles = pgTable(
  "import_files",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id"),
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    originalFileName: text("original_file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    /** statement | member | giving | target */
    fileType: text("file_type").notNull(),
    /** "bank_csv" | "generic_csv" | "online_giving" | ... */
    sourceType: text("source_type").notNull().default("generic_csv"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("import_files_zone_id_unique").on(table.zoneId, table.id),
    // Same checksum + parser context cannot be uploaded twice within the
    // same chapter scope; chapter_id changes matcher semantics for rows
    // that omit a chapter, so zone-wide and per-chapter uploads must not
    // reuse each other's jobs. Split partial indexes because Postgres
    // treats NULL values as distinct in regular unique constraints.
    uniqueIndex("import_files_zone_checksum_unique")
      .on(table.zoneId, table.checksumSha256, table.fileType, table.sourceType)
      .where(sql`${table.chapterId} is null`),
    uniqueIndex("import_files_zone_chapter_checksum_unique")
      .on(
        table.zoneId,
        table.chapterId,
        table.checksumSha256,
        table.fileType,
        table.sourceType,
      )
      .where(sql`${table.chapterId} is not null`),
    index("import_files_zone_idx").on(table.zoneId),
    foreignKey({
      name: "import_files_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("restrict"),
    check(
      "import_files_file_type_check",
      sql`${table.fileType} in ('statement', 'member', 'giving', 'target')`,
    ),
  ],
);

/**
 * State machine for `import_jobs.status`. Single source of truth: the
 * SQL check constraint below is derived from this tuple, the
 * TypeScript `ImportJobStatus` union is too, and consumers (the
 * dashboard, the import-reconciliation report, route layers) import
 * the union from here rather than duplicate it.
 */
export const IMPORT_JOB_STATUSES = [
  "received",
  "parsing",
  "parsed",
  "matching",
  "matched",
  "scheduled",
  "committing",
  "committed",
  "failed",
  "rolled_back",
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

export const importJobs = pgTable(
  "import_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    importFileId: text("import_file_id").notNull(),
    /** See `IMPORT_JOB_STATUSES` for the full enum. */
    status: text("status").$type<ImportJobStatus>().notNull().default("received"),
    totalRows: integer("total_rows").notNull().default(0),
    matchedRows: integer("matched_rows").notNull().default(0),
    unmatchedRows: integer("unmatched_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    committedRows: integer("committed_rows").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("import_jobs_zone_id_unique").on(table.zoneId, table.id),
    index("import_jobs_zone_status_idx").on(table.zoneId, table.status),
    index("import_jobs_zone_created_idx").on(table.zoneId, table.createdAt.desc()),
    foreignKey({
      name: "import_jobs_file_zone_fk",
      columns: [table.zoneId, table.importFileId],
      foreignColumns: [importFiles.zoneId, importFiles.id],
    }).onDelete("restrict"),
    check(
      "import_jobs_status_check",
      sql`${table.status} in (
        'received', 'parsing', 'parsed', 'matching', 'matched',
        'scheduled', 'committing', 'committed', 'failed', 'rolled_back'
      )`,
    ),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").notNull(),
    parsed: jsonb("parsed"),
    /** pending | matched | partial | unmatched */
    matchStatus: text("match_status").notNull().default("pending"),
    memberId: text("member_id"),
    chapterId: text("chapter_id"),
    givingTypeId: text("giving_type_id"),
    serviceEventId: text("service_event_id"),
    givingPeriodId: text("giving_period_id"),
    accountId: text("account_id"),
    paymentMethodId: text("payment_method_id"),
    currencyCode: text("currency_code"),
    /** Bank reference / online-giving id; copied to `contributions.external_transaction_id`. */
    externalTransactionId: text("external_transaction_id"),
    contributionId: text("contribution_id"),
    isDuplicate: boolean("is_duplicate").notNull().default(false),
    duplicateOfContributionId: text("duplicate_of_contribution_id"),
    /** pending | valid | invalid */
    validationStatus: text("validation_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("import_rows_zone_id_unique").on(table.zoneId, table.id),
    unique("import_rows_job_row_unique").on(table.importJobId, table.rowNumber),
    index("import_rows_zone_job_idx").on(table.zoneId, table.importJobId),
    index("import_rows_zone_match_idx").on(table.zoneId, table.matchStatus),
    index("import_rows_zone_validation_idx").on(table.zoneId, table.validationStatus),
    foreignKey({
      name: "import_rows_job_zone_fk",
      columns: [table.zoneId, table.importJobId],
      foreignColumns: [importJobs.zoneId, importJobs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "import_rows_member_zone_fk",
      columns: [table.zoneId, table.memberId],
      foreignColumns: [members.zoneId, members.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_giving_type_zone_fk",
      columns: [table.zoneId, table.givingTypeId],
      foreignColumns: [givingTypes.zoneId, givingTypes.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_service_event_zone_fk",
      columns: [table.zoneId, table.serviceEventId],
      foreignColumns: [serviceEvents.zoneId, serviceEvents.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_giving_period_zone_fk",
      columns: [table.zoneId, table.givingPeriodId],
      foreignColumns: [givingPeriods.zoneId, givingPeriods.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_account_zone_fk",
      columns: [table.zoneId, table.accountId],
      foreignColumns: [accounts.zoneId, accounts.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_payment_method_zone_fk",
      columns: [table.zoneId, table.paymentMethodId],
      foreignColumns: [paymentMethods.zoneId, paymentMethods.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_contribution_zone_fk",
      columns: [table.zoneId, table.contributionId],
      foreignColumns: [contributions.zoneId, contributions.id],
    }).onDelete("set null"),
    foreignKey({
      name: "import_rows_duplicate_of_zone_fk",
      columns: [table.zoneId, table.duplicateOfContributionId],
      foreignColumns: [contributions.zoneId, contributions.id],
    }).onDelete("set null"),
    check(
      "import_rows_match_status_check",
      sql`${table.matchStatus} in ('pending', 'matched', 'partial', 'unmatched')`,
    ),
    check(
      "import_rows_validation_status_check",
      sql`${table.validationStatus} in ('pending', 'valid', 'invalid')`,
    ),
  ],
);

export const importFailureTypes = pgTable(
  "import_failure_types",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** null = platform-default catalog row */
    zoneId: text("zone_id").references(() => zones.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    description: text("description").notNull(),
    detailsPlaceholder: text("details_placeholder"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Two partial unique indexes — a vanilla `unique(zone_id, code)`
    // gives no protection against duplicate platform-default rows
    // (Postgres treats NULL ≠ NULL in unique constraints), so two
    // concurrent bootstrap callers would each insert the full catalog.
    // Splitting into (a) platform defaults keyed on code alone and (b)
    // per-zone overrides keyed on (zone_id, code) makes both branches
    // race-safe and keeps `onConflictDoNothing` deterministic.
    uniqueIndex("import_failure_types_platform_code_unique")
      .on(table.code)
      .where(sql`${table.zoneId} is null`),
    uniqueIndex("import_failure_types_zone_code_unique")
      .on(table.zoneId, table.code)
      .where(sql`${table.zoneId} is not null`),
    index("import_failure_types_code_idx").on(table.code),
  ],
);

export const importRowFailures = pgTable(
  "import_row_failures",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    rowId: text("row_id").notNull(),
    // Intentional non-composite FK: failure types can be platform defaults
    // (`zone_id is null`) or per-zone overrides. The service resolver is
    // responsible for selecting either the platform row or the same-zone
    // override; `failureCode` is the tenant-safe snapshot used at reads.
    failureTypeId: text("failure_type_id")
      .notNull()
      .references(() => importFailureTypes.id, { onDelete: "restrict" }),
    /** Optional code snapshot — convenient when a platform-default type was renamed. */
    failureCode: text("failure_code").notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("import_row_failures_row_idx").on(table.rowId),
    index("import_row_failures_zone_code_idx").on(table.zoneId, table.failureCode),
    foreignKey({
      name: "import_row_failures_row_zone_fk",
      columns: [table.zoneId, table.rowId],
      foreignColumns: [importRows.zoneId, importRows.id],
    }).onDelete("cascade"),
  ],
);

export const importSchedules = pgTable(
  "import_schedules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id").notNull(),
    scheduledByUserId: text("scheduled_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    committedByUserId: text("committed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    rolledBackByUserId: text("rolled_back_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    rolledBackReason: text("rolled_back_reason"),
  },
  (table) => [
    unique("import_schedules_zone_id_unique").on(table.zoneId, table.id),
    // Only one active schedule per job. Active = not committed AND not
    // rolled back. A partial unique index enforces this at the DB level
    // so a future `scheduleImport` bug that re-inserts can't poison the
    // audit trail with two concurrent schedules; re-scheduling AFTER a
    // rollback still works because the previous schedule's
    // `rolled_back_at` is non-null and drops out of the index.
    uniqueIndex("import_schedules_active_unique")
      .on(table.zoneId, table.importJobId)
      .where(
        sql`${table.committedAt} is null and ${table.rolledBackAt} is null`,
      ),
    foreignKey({
      name: "import_schedules_job_zone_fk",
      columns: [table.zoneId, table.importJobId],
      foreignColumns: [importJobs.zoneId, importJobs.id],
    }).onDelete("cascade"),
  ],
);

export const processedTransactions = pgTable(
  "processed_transactions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    /** Bank reference / online-giving transaction id / payment-processor reference. */
    externalTransactionId: text("external_transaction_id").notNull(),
    importJobId: text("import_job_id").notNull(),
    contributionId: text("contribution_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Idempotency invariant: a given external transaction is recorded at
    // most once per zone, regardless of how many times the source file is
    // re-uploaded.
    unique("processed_transactions_zone_ext_unique").on(
      table.zoneId,
      table.externalTransactionId,
    ),
    index("processed_transactions_zone_job_idx").on(table.zoneId, table.importJobId),
    foreignKey({
      name: "processed_transactions_job_zone_fk",
      columns: [table.zoneId, table.importJobId],
      foreignColumns: [importJobs.zoneId, importJobs.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "processed_transactions_contribution_zone_fk",
      columns: [table.zoneId, table.contributionId],
      foreignColumns: [contributions.zoneId, contributions.id],
    }).onDelete("set null"),
  ],
);

export type ImportFile = typeof importFiles.$inferSelect;
export type NewImportFile = typeof importFiles.$inferInsert;
export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;
export type ImportRow = typeof importRows.$inferSelect;
export type NewImportRow = typeof importRows.$inferInsert;
export type ImportFailureType = typeof importFailureTypes.$inferSelect;
export type ImportRowFailure = typeof importRowFailures.$inferSelect;
export type ImportSchedule = typeof importSchedules.$inferSelect;
export type ProcessedTransaction = typeof processedTransactions.$inferSelect;
