// packages/db/src/schema/report-jobs.ts
// Per-tenant async report-generation jobs. One row tracks a single
// queued / running / completed / failed export. The worker picks up
// `queued` rows in `created_at` order via `for update skip locked` so
// multiple processes can co-exist safely.
// RELEVANT FILES: packages/api/src/services/reports/jobs.ts, packages/api/src/services/reports/jobs-pgboss.ts

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { zones } from "./zones";

/**
 * Lifecycle:
 *   queued    -> running   (worker claim)
 *   running   -> completed (artefact persisted, storage_key set)
 *   running   -> failed    (error captured; row kept for audit)
 *   completed -> expired   (cleanup job: blob deleted, row retained)
 */
export const reportJobs = pgTable(
  "report_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    /**
     * Owning user. We re-resolve their role bindings inside `runJob`
     * before invoking the spec so a job queued before a role
     * revocation cannot serve PII after the revocation lands.
     */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Matches `ReportSpec.id`. */
    reportId: text("report_id").notNull(),
    /** Validated Zod output for the spec's filter schema. */
    filters: jsonb("filters").notNull().default({}),
    /** `xlsx` or `pdf` \u2014 chosen at queue time. */
    format: text("format").notNull(),
    /** `queued` | `running` | `completed` | `failed`. */
    status: text("status").notNull().default("queued"),
    /** Object-storage key once the artefact is persisted. */
    storageKey: text("storage_key"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** `result.rows.length` (informational). */
    rowCount: integer("row_count"),
    /** Rendered artefact size in bytes (informational). */
    byteCount: integer("byte_count"),
    /**
     * Set on a successful "export ready" / "export failed" email
     * send. Treated as the idempotency guard so a pg-boss redeliver
     * cannot double-send. Stays null when no email could be sent
     * (e.g. dev environment without `USESEND_*`).
     */
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    /**
     * Hard expiry. The download endpoint serves 404 past this point
     * so a stale signed URL can't be replayed indefinitely. PR 2's
     * cleanup job deletes the blob; the row stays for audit.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Partial index on `(status, created_at)` where the worker's
     * claim query reads. Filtering on a fast index keeps the
     * `for update skip locked` lookup O(1) instead of a seq scan
     * once the table accumulates completed rows.
     */
    index("report_jobs_queued_idx")
      .on(table.createdAt)
      .where(sql`status = 'queued'`),
    /** List endpoint reads (zone, user, newest-first). */
    index("report_jobs_user_idx").on(
      table.zoneId,
      table.userId,
      table.createdAt.desc(),
    ),
    // Domain enums are enforced in the DB so a buggy queue path can't
    // persist a value the worker would later refuse to handle.
    check(
      "report_jobs_format_check",
      sql`${table.format} in ('xlsx', 'pdf')`,
    ),
    check(
      "report_jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'expired')`,
    ),
  ],
);

export type ReportJob = typeof reportJobs.$inferSelect;
export type NewReportJob = typeof reportJobs.$inferInsert;
