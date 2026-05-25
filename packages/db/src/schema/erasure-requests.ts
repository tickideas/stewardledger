// packages/db/src/schema/erasure-requests.ts
// Phase 9 §6 — GDPR data-subject erasure requests.
//
// One row per scheduled erase. The row stays in `pending` for
// the reversibility window (`applies_at - created_at`) and is
// the cancel handle. A daily cron sweep transitions every
// past-due `pending` row to `applied` (or `failed`).
//
// Two scopes coexist in the same table because the audit
// pattern, the cancellable window, the role-gate, and the
// status state-machine are identical; only the *target* of the
// scrub differs (`scope='member'` scrubs one member row;
// `scope='zone'` decommissions the whole zone).
//
// Restore-bundle contract: the table is included in the export
// bundle (`services/exports/registry.ts:erasure_requests`) so
// the operator's last bundle carries the GDPR erase ledger
// alongside the audit log. PR 3's restore-helper MUST rewrite
// every `pending` row to `cancelled` on import with the cancel
// reason `auto-cancelled on bundle restore` — otherwise the
// next cron sweep on the restore target will apply an erase
// scheduled on the source environment, potentially weeks ago,
// against a different operator's data. This is the only piece
// of restore logic the schema reaches into; it's documented
// here (rather than only in the restore-helper) because the
// invariant is structural, not implementation detail.
//
// RELEVANT FILES: packages/api/src/services/erasure/,
//                 packages/api/src/routes/tenant-erasure.ts,
//                 packages/api/src/routes/admin-erasure.ts,
//                 packages/api/src/services/exports/restore.ts,
//                 docs/DOMAIN-MODEL.md §16, tasks/gdpr-erase-workflow.md

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { members } from "./members";
import { zones } from "./zones";

/**
 * Lifecycle:
 *   pending   -> applied    (reversibility window elapsed; cron ran)
 *   pending   -> cancelled  (owner / admin pulled it back in time)
 *   pending   -> failed     (apply path raised; needs operator)
 *
 * `applied` and `cancelled` are terminal. `failed` is also
 * terminal at the row level — the operator can create a fresh
 * `pending` row to retry.
 */
export const erasureRequests = pgTable(
  "erasure_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    /** `member` | `zone`. */
    scope: text("scope").notNull(),
    /**
     * For `scope='member'`, the member row to scrub. Nullable on
     * `scope='zone'` (the whole zone is the target) and on member
     * row deletion so the audit trail outlives the source row.
     */
    memberId: text("member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /**
     * The user who scheduled the erase. Nullable on user deletion
     * so the audit trail survives; the row itself is the proof.
     */
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /**
     * Operator-supplied free text: "member-supplied written
     * request" / "owner-supplied cancellation" / ticket reference.
     * Surfaced verbatim in audit + UI; never used for control flow.
     */
    reason: text("reason"),
    /**
     * `pending` | `applied` | `cancelled` | `failed`. State
     * transitions enforced in service layer + CHECK below.
     */
    status: text("status").notNull().default("pending"),
    /**
     * Snapshotted at creation time. Member-scope reads from the
     * zone's retention policy with a 14-day floor; zone-scope is
     * fixed at 14. Persisted on the row so a later retention
     * policy edit can't retroactively shorten an in-flight window.
     */
    reversibilityWindowDays: integer("reversibility_window_days").notNull(),
    /**
     * Hard deadline: the cron sweep applies every `pending` row
     * with `applies_at < now()`. Cancelling before this point is
     * the operator's escape hatch.
     */
    appliesAt: timestamp("applies_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: text("cancelled_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Cron sweep reads. The partial predicate keeps the index
     * small as `applied` / `cancelled` rows accumulate.
     */
    index("erasure_requests_pending_idx")
      .on(table.appliesAt)
      .where(sql`status = 'pending'`),
    /** List endpoint (zone, newest-first). */
    index("erasure_requests_zone_idx").on(
      table.zoneId,
      table.status,
      table.createdAt.desc(),
    ),
    /**
     * At most one open member-scope request per (zone, member).
     * A second request must explicitly cancel the first; the
     * service layer surfaces a 409 if the caller doesn't.
     */
    uniqueIndex("erasure_requests_zone_member_pending_uidx")
      .on(table.zoneId, table.memberId)
      .where(sql`status = 'pending' and member_id is not null`),
    /**
     * At most one open zone-scope request per zone. Without this
     * a caller could schedule the same zone-erase twice and one
     * `applied` would race the other's `pending` cancel window.
     */
    uniqueIndex("erasure_requests_zone_scope_pending_uidx")
      .on(table.zoneId)
      .where(sql`status = 'pending' and scope = 'zone'`),
    check(
      "erasure_requests_scope_check",
      sql`${table.scope} in ('member', 'zone')`,
    ),
    check(
      "erasure_requests_status_check",
      sql`${table.status} in ('pending', 'applied', 'cancelled', 'failed')`,
    ),
    // Member-scope requests must carry a member_id at creation
    // time; zone-scope must not. The service layer enforces the
    // creation-time invariant; this CHECK is the DB-side guard.
    //
    // The member-scope arm intentionally tolerates `member_id IS
    // NULL` on terminal-status rows (`applied` / `cancelled` /
    // `failed`): the FK to `members(id)` is `ON DELETE SET NULL`
    // so a hard-delete of the parent member (e.g. the apply pass
    // itself, or a downstream platform-admin purge) can null the
    // column without violating the CHECK and orphaning the audit
    // trail. Without this carve-out the FK action would raise
    // `check_violation` at commit and the audit row would be
    // un-survivable — the opposite of the column-level intent
    // documented on `memberId` above.
    //
    // A `pending` member-scope row, by contrast, MUST carry a
    // `member_id`: there's nothing to apply against without one,
    // and the partial unique index
    // `erasure_requests_zone_member_pending_uidx` only protects
    // against duplicates when `member_id IS NOT NULL`.
    check(
      "erasure_requests_scope_member_consistency_check",
      sql`(${table.scope} = 'member' and (
            ${table.memberId} is not null
            or ${table.status} in ('applied', 'cancelled', 'failed')
          ))
       or (${table.scope} = 'zone' and ${table.memberId} is null)`,
    ),
    // A zero or negative window is always a logic bug.
    check(
      "erasure_requests_window_positive_check",
      sql`${table.reversibilityWindowDays} > 0`,
    ),
    // The applies_at must sit strictly in the future of the
    // create instant; an equal or earlier value would mean the
    // row was DOA (cron would apply it on first sweep).
    check(
      "erasure_requests_applies_after_created_check",
      sql`${table.appliesAt} > ${table.createdAt}`,
    ),
  ],
);

export type ErasureRequest = typeof erasureRequests.$inferSelect;
export type NewErasureRequest = typeof erasureRequests.$inferInsert;
