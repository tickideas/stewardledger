// packages/api/src/services/exports/jobs.ts
// Phase 9 §3 — per-zone export bundle: persistence + run logic.
//
// Service responsibilities:
//   1. queueExport(database, ctx)
//        — enqueue a new bundle. Rate-limited to 1 per zone per
//          24h. Audited as `zone.export.request`.
//   2. listExports(database, zoneId, opts)
//        — recent bundles for the zone. Owner-only at the route
//          layer; this service is identity-agnostic.
//   3. getExportForZone(database, zoneId, exportId)
//        — single bundle row; null when cross-zone (so probes
//          look identical to "not found").
//   4. claimExportById(database, exportId)
//        — worker side: atomic queued → running for a known id.
//   5. finalizeExport(database, row, outcome)
//        — worker side: persist completion / failure + audit.
//
// Symmetric with `services/reports/jobs.ts` but simpler — there's
// no per-spec filter / accessCheck and the bundle covers the whole
// zone, so no per-request payload to validate.
//
// RELEVANT FILES: packages/db/src/schema/zone-exports.ts, ./bundle.ts, ./jobs-pgboss.ts

import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  zoneExports,
  type ZoneExport,
} from "@stewardledger/db/schema";
import type { Db, Database } from "@stewardledger/db";
import { log } from "../../logger";
import { writeAudit } from "../audit";

export type ZoneExportStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "expired";

/** Default expiry for a completed bundle. Cleanup prunes the blob; the row stays for audit. */
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Owner cooldown between requests. Bundles are large + bandwidth-heavy. */
const REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export class ExportJobError extends Error {
  constructor(
    readonly code: "rate_limited" | "not_found",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ZoneExportSummary {
  id: string;
  status: ZoneExportStatus;
  byteCount: number | null;
  tableCount: number | null;
  fileCount: number | null;
  artefactCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  emailSentAt: string | null;
  requestedByUserId: string | null;
}

export function toSummary(r: ZoneExport): ZoneExportSummary {
  return {
    id: r.id,
    status: r.status as ZoneExportStatus,
    byteCount: r.byteCount,
    tableCount: r.tableCount,
    fileCount: r.fileCount,
    artefactCount: r.artefactCount,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    emailSentAt: r.emailSentAt?.toISOString() ?? null,
    requestedByUserId: r.requestedByUserId,
  };
}

interface QueueInput {
  zoneId: string;
  /** The `zone_owner` requesting the bundle. Stored for audit + email. */
  requestedByUserId: string;
}

/**
 * Persist a new export row + audit. Enforces the 24h per-zone
 * cooldown so a bored owner cannot DoS object storage with a
 * loop of full-zone dumps. The cooldown looks at ANY non-failed
 * status in the window (queued / running / completed); a `failed`
 * row does not count, so the owner can immediately retry after a
 * crash.
 *
 * Concurrency: the check + insert run inside a single transaction
 * guarded by `pg_advisory_xact_lock(hashtext('zone_export:' ||
 * zoneId))`. The advisory lock serialises concurrent POSTs from
 * the same owner so a network double-tap can't bypass the 24h
 * cooldown. The lock auto-releases at transaction end (commit OR
 * rollback) so there's nothing to clean up.
 *
 * Audited as `zone.export.request`. The pg-boss publish is the
 * caller's responsibility (see `queueExportJob` in jobs-pgboss.ts).
 */
export async function queueExport(
  database: Database,
  input: QueueInput,
): Promise<ZoneExportSummary> {
  return await database.transaction(async (tx) => {
    // Per-zone advisory lock. `hashtext` collapses the variable-
    // length zone id into a stable bigint; the
    // `zone_export:` prefix keeps the keyspace from colliding
    // with future advisory-lock users.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('zone_export:' || ${input.zoneId}))`,
    );

    const since = new Date(Date.now() - REQUEST_COOLDOWN_MS);
    const [recent] = await tx
      .select({
        id: zoneExports.id,
        status: zoneExports.status,
        createdAt: zoneExports.createdAt,
      })
      .from(zoneExports)
      .where(
        and(
          eq(zoneExports.zoneId, input.zoneId),
          gte(zoneExports.createdAt, since),
        ),
      )
      .orderBy(desc(zoneExports.createdAt))
      .limit(1);
    // `failed` rows don't lock out a retry: a worker crash should
    // never strand the owner for 24h. Every other status is
    // treated as "an export exists in the window".
    if (recent && recent.status !== "failed") {
      const cooldownUntil = new Date(
        recent.createdAt.getTime() + REQUEST_COOLDOWN_MS,
      );
      throw new ExportJobError(
        "rate_limited",
        "An export was requested in the last 24 hours; only one bundle per zone per day.",
        {
          cooldownUntil: cooldownUntil.toISOString(),
          existingExportId: recent.id,
        },
      );
    }

    const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_MS);
    const [row] = await tx
      .insert(zoneExports)
      .values({
        zoneId: input.zoneId,
        requestedByUserId: input.requestedByUserId,
        expiresAt,
      })
      .returning();
    await writeAudit(tx, {
      zoneId: input.zoneId,
      actorUserId: input.requestedByUserId,
      action: "zone.export.request",
      entityType: "zone_export",
      entityId: row.id,
      after: { expiresAt: expiresAt.toISOString() },
    });
    return toSummary(row);
  });
}

/** Recent bundles for the zone, newest first. */
export async function listExports(
  database: Db,
  zoneId: string,
  opts: { limit?: number } = {},
): Promise<ZoneExportSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = await database
    .select()
    .from(zoneExports)
    .where(eq(zoneExports.zoneId, zoneId))
    .orderBy(desc(zoneExports.createdAt))
    .limit(limit);
  return rows.map(toSummary);
}

/**
 * Read a single bundle, scoped to the zone. Returns null when the
 * row doesn't exist OR belongs to a different zone, so cross-zone
 * probes look identical to "not found".
 */
export async function getExportForZone(
  database: Db,
  zoneId: string,
  exportId: string,
): Promise<ZoneExport | null> {
  const [row] = await database
    .select()
    .from(zoneExports)
    .where(and(eq(zoneExports.id, exportId), eq(zoneExports.zoneId, zoneId)))
    .limit(1);
  return row ?? null;
}

/** Worker-side typed read by id. No identity scoping. */
export async function getExportById(
  database: Db,
  exportId: string,
): Promise<ZoneExport | null> {
  const [row] = await database
    .select()
    .from(zoneExports)
    .where(eq(zoneExports.id, exportId))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically flip `queued` → `running` for a known id. Returns the
 * claimed row or null when the row is already non-queued (another
 * worker beat us / manual flip / terminal already).
 */
export async function claimExportById(
  database: Db,
  exportId: string,
): Promise<ZoneExport | null> {
  const now = new Date();
  const [row] = await database
    .update(zoneExports)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(eq(zoneExports.id, exportId), eq(zoneExports.status, "queued")),
    )
    .returning();
  return row ?? null;
}

export interface ExportOutcome {
  status: "completed" | "failed";
  storageKey?: string;
  byteCount?: number;
  tableCount?: number;
  fileCount?: number;
  artefactCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Persist the outcome of a run + write the audit event. Anchors
 * the retention window to *completion* (a bundle that sat queued
 * for hours would otherwise burn most of its 7-day window before
 * the artefact even exists).
 */
export async function finalizeExport(
  database: Database,
  row: ZoneExport,
  outcome: ExportOutcome,
): Promise<ZoneExport> {
  const completedAt = new Date();
  const expiresAt =
    outcome.status === "completed"
      ? new Date(completedAt.getTime() + DEFAULT_EXPIRY_MS)
      : row.expiresAt;
  return await database.transaction(async (tx) => {
    const [updated] = await tx
      .update(zoneExports)
      .set({
        status: outcome.status,
        storageKey: outcome.storageKey ?? null,
        byteCount: outcome.byteCount ?? null,
        tableCount: outcome.tableCount ?? null,
        fileCount: outcome.fileCount ?? null,
        artefactCount: outcome.artefactCount ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        completedAt,
        expiresAt,
        updatedAt: completedAt,
      })
      .where(eq(zoneExports.id, row.id))
      .returning();
    await writeAudit(tx, {
      zoneId: row.zoneId,
      actorUserId: row.requestedByUserId,
      action:
        outcome.status === "completed"
          ? "zone.export.completed"
          : "zone.export.failed",
      entityType: "zone_export",
      entityId: row.id,
      after: {
        status: outcome.status,
        byteCount: outcome.byteCount ?? null,
        tableCount: outcome.tableCount ?? null,
        fileCount: outcome.fileCount ?? null,
        artefactCount: outcome.artefactCount ?? null,
        errorCode: outcome.errorCode ?? null,
      },
    });
    return updated;
  });
}

/**
 * Build the object-storage key for a bundle. Encodes tenant +
 * year/month so a single directory listing never mixes zones.
 */
export function bundleStorageKey(zoneId: string, exportId: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${zoneId}/exports/${yyyy}/${mm}/${exportId}.tar.gz`;
}

/**
 * Logging helper used by both the boot sweep and the cleanup
 * job. Kept here so the lifecycle constants stay in one file.
 */
export const ZONE_EXPORT_EXPIRY_MS = DEFAULT_EXPIRY_MS;
export const ZONE_EXPORT_REQUEST_COOLDOWN_MS = REQUEST_COOLDOWN_MS;

/**
 * Route-facing wrapper: persist the row + publish to pg-boss.
 * Mirrors `services/reports/jobs.ts:queueJob` — row commits first,
 * publish is best-effort, the boot sweep recovers orphaned rows on
 * the next process start if `boss.send` fails between commit + try.
 *
 * The dynamic import is deliberate, for two reasons:
 *   1. `jobs-pgboss.ts` imports back from this module
 *      (`claimExportById`, `finalizeExport`, etc.), so a static
 *      import here would create a load-order cycle.
 *   2. Tests that don't exercise queueing don't have to pull
 *      pg-boss into the module graph.
 */
export async function queueExportJob(
  database: Database,
  input: QueueInput,
): Promise<ZoneExportSummary> {
  const summary = await queueExport(database, input);
  try {
    const { enqueueZoneExportJob } = await import("./jobs-pgboss");
    await enqueueZoneExportJob(summary.id);
  } catch (err) {
    log.warn(
      { err, exportId: summary.id },
      "queueExportJob: pg-boss enqueue failed; row will be recovered by boot sweep",
    );
  }
  return summary;
}

// re-export so test files don't have to chase imports
export { log };
