// packages/db/src/schema/zone-exports.ts
// Per-zone full-data export jobs. One row tracks a single
// queued / running / completed / failed bundle. Mirrors
// `report_jobs` lifecycle and worker-claim pattern so the queue
// machinery in `services/exports/jobs-pgboss.ts` can re-use the
// same `for update skip locked` semantics.
// RELEVANT FILES: packages/api/src/services/exports/

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
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
 *
 * The artefact is a single `.tar.gz` at
 *   {zoneId}/exports/{yyyy}/{mm}/{exportId}.tar.gz
 * containing every zone-scoped row as JSONL plus every uploaded
 * file and retained report artefact. See
 * `services/exports/registry.ts` for the canonical table list.
 */
export const zoneExports = pgTable(
  "zone_exports",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    /**
     * The `zone_owner` who triggered the export. Nullable on user
     * deletion so the audit trail survives (the row is what proves
     * an export happened, not the requester's user row).
     */
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** `queued` | `running` | `completed` | `failed` | `expired`. */
    status: text("status").notNull().default("queued"),
    /** Object-storage key once the bundle is persisted. */
    storageKey: text("storage_key"),
    /**
     * Bundle size in bytes (informational). `bigint` because a
     * mature zone with several years of imports can comfortably
     * push past 2 GB; `integer` would overflow.
     */
    byteCount: bigint("byte_count", { mode: "number" }),
    /** Count of JSONL tables included in the bundle. */
    tableCount: integer("table_count"),
    /** Count of uploaded import files copied into `files/`. */
    fileCount: integer("file_count"),
    /** Count of retained report artefacts copied into `reports/`. */
    artefactCount: integer("artefact_count"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /**
     * Set on a successful "export ready" / "export failed" email
     * send. Treated as the idempotency guard so a pg-boss redeliver
     * cannot double-send. Stays null when no email could be sent
     * (e.g. dev environment without `USESEND_*`).
     */
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    /**
     * Hard expiry. The download endpoint serves 410 Gone past this
     * point so a stale signed URL can't be replayed indefinitely.
     * The cleanup job deletes the blob; the row stays for audit.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Partial index on `created_at` where the worker's claim query
     * reads. Keeps the `for update skip locked` lookup O(1) instead
     * of a seq scan once the table accumulates completed rows.
     */
    index("zone_exports_queued_idx")
      .on(table.createdAt)
      .where(sql`status = 'queued'`),
    /** List endpoint reads (zone, newest-first). */
    index("zone_exports_zone_idx").on(
      table.zoneId,
      table.status,
      table.createdAt.desc(),
    ),
    /** Cleanup sweep reads only completed rows past their expiry. */
    index("zone_exports_expiry_idx")
      .on(table.expiresAt)
      .where(sql`status = 'completed'`),
    // Domain enum enforced in the DB so a buggy queue path can't
    // persist a value the worker would later refuse to handle.
    check(
      "zone_exports_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'expired')`,
    ),
  ],
);

export type ZoneExport = typeof zoneExports.$inferSelect;
export type NewZoneExport = typeof zoneExports.$inferInsert;
