// packages/api/src/services/exports/cleanup.ts
// Phase 9 §3 — daily expiry sweep for completed zone-export bundles.
//
// A pg-boss schedule fires this once a day. Selects up to 500
// expired `completed` rows, deletes the blob from object storage,
// flips each row to `expired` (the row stays for audit), and writes
// a single `platform.zone.export.cleanup.run` audit event so we
// have a paper trail per pass.
//
// A blob-delete failure is logged + the row still flips — storage
// isn't transactional; the DB is the source of truth. We re-assert
// `status='completed'` in the UPDATE WHERE to avoid silently
// overwriting a manual replay that moved the row.
//
// Mirrors `services/reports/cleanup.ts` deliberately.
//
// RELEVANT FILES: ../storage.ts, ./jobs-pgboss.ts

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { zoneExports } from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { log } from "../../logger";
import { writeAudit } from "../audit";
import { storage } from "../storage";

const CLEANUP_BATCH = 500;

export interface ExportCleanupSummary {
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
export async function cleanupExpiredZoneExports(
  database: Database,
): Promise<ExportCleanupSummary> {
  const candidates = await database
    .select({ id: zoneExports.id, storageKey: zoneExports.storageKey })
    .from(zoneExports)
    .where(
      and(
        eq(zoneExports.status, "completed"),
        isNotNull(zoneExports.storageKey),
        lt(zoneExports.expiresAt, sql`now()`),
      ),
    )
    .limit(CLEANUP_BATCH);

  if (candidates.length === 0) {
    return { scanned: 0, deletedArtefacts: 0, expiredRows: 0 };
  }

  // Ordering: delete the blob FIRST, flip the row second.
  // Why this order:
  //   - A crash between the two leaves a `completed` row whose
  //     blob is gone. The next sweep re-scans the row, attempts
  //     a delete (idempotent for FS via `force: true` and for
  //     S3 `DeleteObject` against a missing key), then flips.
  //     Eventually consistent.
  //   - The reverse order (flip first, delete second) would let
  //     a crash strand a blob in storage with no DB row pointing
  //     at it — unrecoverable without a manual storage audit.
  let deletedArtefacts = 0;
  for (const row of candidates) {
    if (!row.storageKey) continue;
    try {
      await storage().delete(row.storageKey);
      deletedArtefacts += 1;
    } catch (err) {
      log.warn(
        { err, exportId: row.id },
        "zone export cleanup: blob delete failed",
      );
    }
  }

  const ids = candidates.map((c) => c.id);
  const now = new Date();
  const flipped = await database
    .update(zoneExports)
    .set({ status: "expired", storageKey: null, updatedAt: now })
    .where(
      and(inArray(zoneExports.id, ids), eq(zoneExports.status, "completed")),
    )
    .returning({ id: zoneExports.id });

  // Platform-scope audit (NULL zone_id). The CHECK on `audit_events`
  // requires `platform.*` actions to carry NULL zone_id.
  await writeAudit(database, {
    zoneId: null,
    action: "platform.zone.export.cleanup.run",
    entityType: "zone_export",
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
    "zone export cleanup: pass complete",
  );
  return {
    scanned: candidates.length,
    deletedArtefacts,
    expiredRows: flipped.length,
  };
}
