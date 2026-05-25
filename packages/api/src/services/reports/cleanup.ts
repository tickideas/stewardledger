// packages/api/src/services/reports/cleanup.ts
// Phase 7 PR 2 — daily expiry cleanup for completed report artefacts.
//
// A pg-boss schedule fires this once a day. Selects up to 500 expired
// `completed` rows, deletes the blob from object storage, flips the
// row to `expired` (retains it for audit) and writes a platform-scope
// `report.cleanup.run` audit event so we have a paper trail for the
// purge. A blob-delete failure is logged + the row still flips —
// storage is best-effort; the DB is the source of truth.
//
// RELEVANT FILES: packages/api/src/services/storage.ts, packages/api/src/services/reports/jobs-pgboss.ts

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { reportJobs } from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { log } from "../../logger";
import { writeAudit } from "../audit";
import { storage } from "../storage";

const CLEANUP_BATCH = 500;

export interface CleanupSummary {
  scanned: number;
  deletedArtefacts: number;
  expiredRows: number;
}

/**
 * Scan for `completed` rows with `expires_at < now()`, delete each
 * blob, then flip every scanned row to `status='expired'`. Bounded
 * to {@link CLEANUP_BATCH} rows per call so we never hold a long
 * transaction; the next scheduled run picks up the rest.
 */
export async function cleanupExpiredArtefacts(
  database: Database,
): Promise<CleanupSummary> {
  const candidates = await database
    .select({ id: reportJobs.id, storageKey: reportJobs.storageKey })
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.status, "completed"),
        isNotNull(reportJobs.storageKey),
        lt(reportJobs.expiresAt, sql`now()`),
      ),
    )
    .limit(CLEANUP_BATCH);

  if (candidates.length === 0) {
    return { scanned: 0, deletedArtefacts: 0, expiredRows: 0 };
  }

  let deletedArtefacts = 0;
  for (const row of candidates) {
    if (!row.storageKey) continue;
    try {
      await storage().delete(row.storageKey);
      deletedArtefacts += 1;
    } catch (err) {
      // Storage isn't transactional; a missing blob is benign,
      // anything else is logged and we still flip the row so we
      // don't loop on it forever.
      log.warn({ err, jobId: row.id }, "report cleanup: blob delete failed");
    }
  }

  const ids = candidates.map((c) => c.id);
  const now = new Date();
  // Re-assert `status='completed'` in the WHERE clause. Between the
  // initial SELECT and this UPDATE (seconds for a batch of 500) a
  // manual replay / admin SQL could have moved the row — we don't
  // want to silently overwrite that back to `expired`.
  const flipped = await database
    .update(reportJobs)
    .set({
      status: "expired",
      storageKey: null,
      updatedAt: now,
    })
    .where(
      and(inArray(reportJobs.id, ids), eq(reportJobs.status, "completed")),
    )
    .returning({ id: reportJobs.id });

  // Platform-scope audit (NULL zone_id). Mirrors `import.rollback`
  // for cross-tenant operations; the CHECK on `audit_events`
  // requires `platform.*` actions to carry NULL zone_id.
  await writeAudit(database, {
    zoneId: null,
    action: "platform.report.cleanup.run",
    entityType: "report_job",
    after: {
      scanned: candidates.length,
      deletedArtefacts,
      expiredRows: flipped.length,
    },
  });

  log.info(
    {
      scanned: candidates.length,
      deletedArtefacts,
      expiredRows: flipped.length,
    },
    "report cleanup: pass complete",
  );
  return {
    scanned: candidates.length,
    deletedArtefacts,
    expiredRows: flipped.length,
  };
}
