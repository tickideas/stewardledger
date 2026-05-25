// packages/api/src/services/erasure/scrub-zone.ts
// Phase 9 §6 — orchestrates the zone-level hard-purge.
//
// Two phases, separated in time by the reversibility window:
//
//   1. `softDecommissionZone` — runs at request creation. Marks
//      the zone soft-deleted so the tenant middleware
//      (`packages/api/src/middleware/tenant.ts`) refuses every
//      authenticated request, freezing the data while the
//      operator still has a cancel handle.
//   2. `hardPurgeZone` — runs from the cron sweep once
//      `applies_at` is past. Enumerates every blob the zone
//      owns from the three storage-bearing tables (`import_files`,
//      `report_jobs`, `zone_exports`), deletes them best-effort,
//      then DELETEs the zone row. Every zone-scoped table FKs
//      `zone_id ON DELETE CASCADE`, so the single zone DELETE
//      removes the entire tenant tree atomically.
//
// The platform-scope audit row written before the DELETE is the
// last record that survives — `audit_events.zone_id` is the only
// nullable FK on that table, and platform-scope rows already
// carry NULL there, so they're exempt from the CASCADE.
//
// RELEVANT FILES: ./requests.ts (apply path), ./scrub-zone.test.ts,
//                 packages/api/src/middleware/tenant.ts,
//                 packages/db/src/schema/zones.ts

import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@stewardledger/db";
import {
  chapters,
  groups,
  importFiles,
  members,
  reportJobs,
  zoneExports,
  zones,
} from "@stewardledger/db/schema";

import { log } from "../../logger";
import { storage } from "../storage";

export interface SoftDecommissionInput {
  zoneId: string;
  now?: Date;
}

/**
 * Mark the zone soft-deleted. Idempotent: if the row is already
 * soft-deleted (re-entry / replay), the prior `deletedAt` stands.
 *
 * `tenant.ts:resolveTenant` filters on `isNull(zones.deletedAt)`,
 * so after this write every authenticated request to the zone's
 * routes returns 404 (tenant not found) — the data is frozen for
 * the duration of the reversibility window.
 */
export async function softDecommissionZone(
  database: Db,
  input: SoftDecommissionInput,
): Promise<void> {
  const now = input.now ?? new Date();
  await database
    .update(zones)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(zones.id, input.zoneId));
}

export interface HardPurgeSummary {
  /**
   * Best-effort count: includes blobs that didn't exist on disk.
   * The underlying `ObjectStorage.delete` is idempotent (FS adapter
   * uses `rm --force`; InMemory adapter ignores misses), so a row
   * that points at an already-purged blob still increments this
   * counter — the post-condition is "after the call, the blob is
   * gone", which is true in both cases.
   */
  blobsDeleted: number;
  /** Transient storage errors; logged + counted so an operator can investigate. */
  blobsFailed: number;
  zoneDeleted: boolean;
}

/**
 * Hard-purge the zone. Enumerates every storage key the zone
 * owns across the three blob-bearing tables, deletes each blob
 * best-effort (missing blobs are fine — retention may already
 * have cleaned them up; transient I/O failures are counted and
 * logged but don't abort the row delete), and then DELETEs the
 * zone row inside a transaction so the cascade is atomic.
 *
 * Blob deletion happens *before* the zone DELETE on purpose:
 * once the row is gone the FK cascade strips every
 * `import_files.storage_key` row in the same transaction, and
 * we'd lose the list of keys to delete. The alternative
 * (snapshot the keys, DELETE the row, then loop the snapshot)
 * is functionally equivalent but adds a second round-trip and
 * means a crash between the DELETE and the loop leaves orphan
 * blobs forever. Deleting first is safe because the keys are
 * partitioned by `{zoneId}/...` so a crash mid-loop leaves
 * orphan blobs that the next manual purge can re-enumerate from
 * any surviving export bundle, and the tenant middleware has
 * already returned 404 since soft-decommission.
 */
export async function hardPurgeZone(
  database: Db,
  zoneId: string,
): Promise<HardPurgeSummary> {
  const summary: HardPurgeSummary = {
    blobsDeleted: 0,
    blobsFailed: 0,
    zoneDeleted: false,
  };

  // 1) Enumerate storage keys from the three blob-bearing tables.
  //    Each `select` is independently indexed on `zone_id`.
  const [importBlobs, reportBlobs, exportBlobs] = await Promise.all([
    database
      .select({ storageKey: importFiles.storageKey })
      .from(importFiles)
      .where(eq(importFiles.zoneId, zoneId)),
    database
      .select({ storageKey: reportJobs.storageKey })
      .from(reportJobs)
      .where(
        and(eq(reportJobs.zoneId, zoneId), isNotNull(reportJobs.storageKey)),
      ),
    database
      .select({ storageKey: zoneExports.storageKey })
      .from(zoneExports)
      .where(
        and(
          eq(zoneExports.zoneId, zoneId),
          isNotNull(zoneExports.storageKey),
        ),
      ),
  ]);

  const keys = [
    ...importBlobs.map((r) => r.storageKey).filter((k): k is string => !!k),
    ...reportBlobs.map((r) => r.storageKey).filter((k): k is string => !!k),
    ...exportBlobs.map((r) => r.storageKey).filter((k): k is string => !!k),
  ];

  const store = storage();
  // 2) Best-effort delete. The storage interface treats `delete`
  //    as idempotent (FS adapter uses `rm --force`; missing files
  //    are not an error), so an already-purged blob still counts
  //    toward `blobsDeleted` — the post-condition is "the blob is
  //    gone", and it is. Transient storage errors are caught,
  //    logged, and bumped into `blobsFailed` so a failed delete
  //    doesn't prevent the cascade from running.
  for (const key of keys) {
    try {
      await store.delete(key);
      summary.blobsDeleted++;
    } catch (err) {
      summary.blobsFailed++;
      log.warn(
        { err, key, zoneId },
        "zone hard-purge: blob delete failed; continuing",
      );
    }
  }

  // 3) Drop the tenant tree, then the zone row.
  //
  //    Most zone-scoped tables FK `zone_id ON DELETE CASCADE`, but
  //    three carry `ON DELETE RESTRICT` as platform-level safety
  //    rails so an accidental `DELETE FROM zones` can't nuke a
  //    tenant's identity backbone:
  //
  //      - chapters (chapters_zone_id_zones_id_fk RESTRICT)
  //      - members  (members_zone_id_zones_id_fk  RESTRICT)
  //      - groups   (groups_zone_id_zones_id_fk   RESTRICT)
  //
  //    Zone-erase is the one operation explicitly authorised to
  //    bypass them. We delete each child set first; their own
  //    sub-children (member_addresses, contribution_members,
  //    chapter_name_history, etc.) FK these tables with CASCADE so
  //    a single DELETE per parent wipes the subtree.
  //
  //    Order matters: members BEFORE chapters because
  //    `members.chapter_id` FKs chapters (set null, but the
  //    constraint exists). Same logic for groups: chapters can FK
  //    a group, so groups go AFTER chapters.
  //
  //    The whole sequence runs in one transaction so a constraint
  //    failure mid-tree leaves no half-state. The CASCADE depth is
  //    bounded (~3 levels max under any of these parents) so PG's
  //    trigger-recursion budget is not at risk.
  await database.transaction(async (tx) => {
    await tx.delete(members).where(eq(members.zoneId, zoneId));
    await tx.delete(chapters).where(eq(chapters.zoneId, zoneId));
    await tx.delete(groups).where(eq(groups.zoneId, zoneId));
    const deleted = await tx
      .delete(zones)
      .where(eq(zones.id, zoneId))
      .returning({ id: zones.id });
    summary.zoneDeleted = deleted.length > 0;
  });

  return summary;
}
