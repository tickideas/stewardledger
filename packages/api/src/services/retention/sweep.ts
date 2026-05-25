// packages/api/src/services/retention/sweep.ts
// Phase 9 — per-dimension retention sweeps.
//
// One exported function per dimension. Each:
//   - Is bounded by a `LIMIT` chunk to avoid long-running transactions.
//   - Returns a count of rows affected so the cron handler can roll
//     them into a single per-zone audit row.
//   - No-ops when `retainDays === 0` (the "never purge" sentinel).
//   - Honours zone scope at the SQL level: a sweep for zone A never
//     touches zone B's rows.
//
// The cron handler in `./cron.ts` is the only production caller; tests
// call each function directly.
//
// RELEVANT FILES: ./policy.ts, ./cron.ts, packages/api/src/services/storage.ts

import type { Db } from "@stewardledger/db";
import {
  auditEvents,
  importFiles,
  importJobs,
  importRows,
  reportJobs,
} from "@stewardledger/db/schema";
import { and, eq, inArray, isNull, lt, notInArray } from "drizzle-orm";

import { log } from "../../logger";
import { storage } from "../storage";

/** Per-pass batch cap. Keeps each statement well under Postgres limits. */
const SWEEP_BATCH = 5_000;

export interface SweepResult {
  /** Number of rows deleted / purged in this pass. */
  deleted: number;
}

function cutoffFor(retainDays: number): Date {
  return new Date(Date.now() - retainDays * 86_400_000);
}

/**
 * Delete tenant-scope `audit_events` older than the window. Platform-
 * scope rows (`zone_id IS NULL`, action `platform.%`) are never
 * affected because we filter on `zone_id = $1`.
 */
export async function sweepAuditEvents(
  database: Db,
  zoneId: string,
  retainDays: number,
): Promise<SweepResult> {
  if (retainDays <= 0) return { deleted: 0 };
  const cutoff = cutoffFor(retainDays);
  let total = 0;
  // Chunked DELETE … WHERE id IN (subquery LIMIT n). The subquery
  // pattern lets us stay within `SWEEP_BATCH` per round trip without
  // depending on a server-side cursor.
  for (;;) {
    const deleted = await database
      .delete(auditEvents)
      .where(
        and(
          eq(auditEvents.zoneId, zoneId),
          lt(auditEvents.occurredAt, cutoff),
          inArray(
            auditEvents.id,
            database
              .select({ id: auditEvents.id })
              .from(auditEvents)
              .where(
                and(
                  eq(auditEvents.zoneId, zoneId),
                  lt(auditEvents.occurredAt, cutoff),
                ),
              )
              .limit(SWEEP_BATCH),
          ),
        ),
      )
      .returning({ id: auditEvents.id });
    total += deleted.length;
    if (deleted.length < SWEEP_BATCH) break;
  }
  if (total > 0) {
    log.info({ zoneId, deleted: total }, "retention: swept audit_events");
  }
  return { deleted: total };
}

/**
 * Purge the **bytes** for expired import files. The row itself stays —
 * `import_jobs(import_file_id)` is `restrict`, so a hard delete would
 * throw whenever historical jobs reference the file. Instead we delete
 * the blob from object storage and flip `purged_at` so downstream code
 * can render the file as "no longer recoverable" without losing the
 * audit trail.
 *
 * Anchored on `uploaded_at` (not `committed_at`): a long-uncommitted
 * file is itself a candidate for cleanup. Best-effort storage delete:
 * a 404 / transient error is logged but the row still flips so we
 * don't loop on it forever. Loops in chunks of {@link SWEEP_BATCH} so
 * a single zone with many ancient files drains over multiple passes.
 */
export async function sweepImportFiles(
  database: Db,
  zoneId: string,
  retainDays: number,
): Promise<SweepResult> {
  if (retainDays <= 0) return { deleted: 0 };
  const cutoff = cutoffFor(retainDays);
  let total = 0;
  for (;;) {
    const candidates = await database
      .select({ id: importFiles.id, storageKey: importFiles.storageKey })
      .from(importFiles)
      .where(
        and(
          eq(importFiles.zoneId, zoneId),
          lt(importFiles.uploadedAt, cutoff),
          isNull(importFiles.purgedAt),
        ),
      )
      .limit(SWEEP_BATCH);
    if (candidates.length === 0) break;
    for (const row of candidates) {
      try {
        await storage().delete(row.storageKey);
      } catch (err) {
        log.warn(
          { err, zoneId, fileId: row.id },
          "retention: import file blob delete failed",
        );
      }
    }
    const now = new Date();
    const flipped = await database
      .update(importFiles)
      .set({ purgedAt: now })
      .where(
        and(
          eq(importFiles.zoneId, zoneId),
          isNull(importFiles.purgedAt),
          inArray(
            importFiles.id,
            candidates.map((c) => c.id),
          ),
        ),
      )
      .returning({ id: importFiles.id });
    total += flipped.length;
    if (candidates.length < SWEEP_BATCH) break;
  }
  if (total > 0) {
    log.info({ zoneId, purged: total }, "retention: swept import_files");
  }
  return { deleted: total };
}

/**
 * Drop expired `import_rows` whose owning job is in a **terminal**
 * state. Terminal = `committed | failed | rolled_back`; every other
 * status (the seven listed below) means the job is still being worked
 * on and its rows must stay around for the dashboard / inline-fix
 * flow. Rows on `failed` jobs DO age out: once the job has been
 * failed for `retainDays`, the parse output is no longer useful for
 * investigation and a re-upload would create a fresh job.
 */
const NON_TERMINAL_JOB_STATUSES = [
  "received",
  "parsing",
  "parsed",
  "matching",
  "matched",
  "scheduled",
  "committing",
] as const;

export async function sweepImportRows(
  database: Db,
  zoneId: string,
  retainDays: number,
): Promise<SweepResult> {
  if (retainDays <= 0) return { deleted: 0 };
  const cutoff = cutoffFor(retainDays);
  // Subquery: jobs in this zone that are still active. Their rows
  // are excluded from the sweep regardless of age.
  const activeJobsSub = database
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(
      and(
        eq(importJobs.zoneId, zoneId),
        inArray(importJobs.status, [...NON_TERMINAL_JOB_STATUSES]),
      ),
    );
  let total = 0;
  for (;;) {
    const deleted = await database
      .delete(importRows)
      .where(
        and(
          eq(importRows.zoneId, zoneId),
          lt(importRows.createdAt, cutoff),
          notInArray(importRows.importJobId, activeJobsSub),
          inArray(
            importRows.id,
            database
              .select({ id: importRows.id })
              .from(importRows)
              .where(
                and(
                  eq(importRows.zoneId, zoneId),
                  lt(importRows.createdAt, cutoff),
                  notInArray(importRows.importJobId, activeJobsSub),
                ),
              )
              .limit(SWEEP_BATCH),
          ),
        ),
      )
      .returning({ id: importRows.id });
    total += deleted.length;
    if (deleted.length < SWEEP_BATCH) break;
  }
  if (total > 0) {
    log.info({ zoneId, deleted: total }, "retention: swept import_rows");
  }
  return { deleted: total };
}

/**
 * Drop `report_jobs` rows that have already been flipped to `expired`
 * by the artefact cleanup. The artefact bytes are already gone at
 * this point; we're trimming the metadata row itself.
 *
 * `completedAt` is the anchor for terminal rows; the cleanup job sets
 * `updatedAt` when flipping to `expired` but the original
 * `completedAt` remains the right truth for "how old is this record".
 */
export async function sweepReportJobs(
  database: Db,
  zoneId: string,
  retainDays: number,
): Promise<SweepResult> {
  if (retainDays <= 0) return { deleted: 0 };
  const cutoff = cutoffFor(retainDays);
  let total = 0;
  for (;;) {
    const deleted = await database
      .delete(reportJobs)
      .where(
        and(
          eq(reportJobs.zoneId, zoneId),
          eq(reportJobs.status, "expired"),
          lt(reportJobs.completedAt, cutoff),
          inArray(
            reportJobs.id,
            database
              .select({ id: reportJobs.id })
              .from(reportJobs)
              .where(
                and(
                  eq(reportJobs.zoneId, zoneId),
                  eq(reportJobs.status, "expired"),
                  lt(reportJobs.completedAt, cutoff),
                ),
              )
              .limit(SWEEP_BATCH),
          ),
        ),
      )
      .returning({ id: reportJobs.id });
    total += deleted.length;
    if (deleted.length < SWEEP_BATCH) break;
  }
  if (total > 0) {
    log.info({ zoneId, deleted: total }, "retention: swept report_jobs");
  }
  return { deleted: total };
}

export interface ZoneSweepSummary {
  audit_events: number;
  import_files: number;
  import_rows: number;
  report_jobs: number;
}

// Internal helper so the cron handler doesn't duplicate the
// dimension-by-dimension orchestration; tests can import it too.
export async function sweepZone(
  database: Db,
  zoneId: string,
  policy: {
    audit_events: { retainDays: number };
    import_files: { retainDays: number };
    import_rows: { retainDays: number };
    report_jobs: { retainDays: number };
  },
): Promise<ZoneSweepSummary> {
  const a = await sweepAuditEvents(database, zoneId, policy.audit_events.retainDays);
  const f = await sweepImportFiles(database, zoneId, policy.import_files.retainDays);
  const r = await sweepImportRows(database, zoneId, policy.import_rows.retainDays);
  const j = await sweepReportJobs(database, zoneId, policy.report_jobs.retainDays);
  return {
    audit_events: a.deleted,
    import_files: f.deleted,
    import_rows: r.deleted,
    report_jobs: j.deleted,
  };
}
