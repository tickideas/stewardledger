// packages/api/src/services/erasure/requests.ts
// Phase 9 §6 — erasure request lifecycle service.
//
// Owns the `pending -> applied | cancelled | failed` state
// machine, the role-aware reversibility-window computation, the
// confirm-export gate for zone-scope erases, and the audit row
// for every transition.
//
// Routes (`tenant-erasure.ts`, `admin-erasure.ts`) are thin HTTP
// wrappers around this module; the cron sweep (`cron.ts`) calls
// `applyErasureRequest` for every past-due row.
//
// RELEVANT FILES: ./scrub-member.ts, ./scrub-zone.ts, ./cron.ts,
//                 packages/api/src/routes/tenant-erasure.ts,
//                 packages/api/src/routes/admin-erasure.ts,
//                 packages/db/src/schema/erasure-requests.ts

import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  erasureRequests,
  members,
  zoneExports,
  type ErasureRequest,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

import { log } from "../../logger";
import { writeAudit } from "../audit";
import { loadRetentionPolicy } from "../retention/policy";
import { buildMemberScrubPatch } from "./scrub-member";
import { hardPurgeZone, softDecommissionZone } from "./scrub-zone";

export type ErasureScope = "member" | "zone";
export type ErasureStatus = "pending" | "applied" | "cancelled" | "failed";

/**
 * Minimum reversibility window. Zone-scope is fixed at this;
 * member-scope reads the per-zone retention policy and floors
 * to this value when the policy is 0 (= "never purge", the v1
 * default). Spec: `tasks/gdpr-erase-workflow.md` §"Reversibility
 * window".
 */
const DEFAULT_WINDOW_DAYS = 14;

/**
 * For zone-scope requests, the most recent `completed`
 * `zone_exports` row must sit within this window — refusing to
 * schedule a zone-erase without a recent take-with-them artefact
 * is a hard acceptance criterion.
 */
const RECENT_EXPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class ErasureRequestError extends Error {
  constructor(
    readonly code:
      | "invalid_scope"
      | "member_required"
      | "member_forbidden"
      | "duplicate_pending"
      | "not_found"
      | "not_pending"
      | "recent_export_required",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ErasureRequestError";
  }
}

export interface ErasureRequestSummary {
  id: string;
  zoneId: string;
  scope: ErasureScope;
  memberId: string | null;
  status: ErasureStatus;
  reason: string | null;
  reversibilityWindowDays: number;
  appliesAt: string;
  appliedAt: string | null;
  cancelledAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedByUserId: string | null;
  cancelledByUserId: string | null;
  createdAt: string;
}

export function toSummary(row: ErasureRequest): ErasureRequestSummary {
  return {
    id: row.id,
    zoneId: row.zoneId,
    scope: row.scope as ErasureScope,
    memberId: row.memberId,
    status: row.status as ErasureStatus,
    reason: row.reason,
    reversibilityWindowDays: row.reversibilityWindowDays,
    appliesAt: row.appliesAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    requestedByUserId: row.requestedByUserId,
    cancelledByUserId: row.cancelledByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateErasureRequestInput {
  zoneId: string;
  actorUserId: string | null;
  scope: ErasureScope;
  memberId?: string | null;
  reason?: string | null;
  /**
   * Optional override; defaults are computed from the zone's
   * retention policy (member-scope) or fixed at 14 days
   * (zone-scope). The DB CHECK rejects <= 0.
   */
  windowDays?: number;
  /**
   * Zone-scope only: the `zone_exports.id` the caller asserts
   * is their take-with-them artefact. Required for `scope='zone'`;
   * must reference a `completed` row owned by the same zone and
   * created within the last 7 days.
   */
  confirmExportId?: string | null;
  /** Injected for deterministic tests. */
  now?: Date;
}

/**
 * Schedule a new erase. Returns the persisted row.
 *
 * - `scope='member'`: requires `memberId`. Picks the window from
 *   the zone's `member_soft_deletes.retainDays` policy floored at
 *   14 days (the policy default is 0 = never-purge; the erase
 *   workflow always needs a real reversibility window).
 * - `scope='zone'`: requires `confirmExportId` pointing at a
 *   recent completed export. Window fixed at 14 days. Marks the
 *   zone soft-deleted immediately so the tenant middleware
 *   returns 404 for the duration of the cancel window.
 *
 * Audit:
 *   - member-scope: tenant-scope `member.erase.scheduled`
 *   - zone-scope:   platform-scope `platform.zone.erase.scheduled`
 *                   (the zone has just been frozen; the audit row
 *                   is platform-scope so it survives the eventual
 *                   hard-purge cascade).
 */
export async function createErasureRequest(
  database: Db,
  input: CreateErasureRequestInput,
): Promise<ErasureRequestSummary> {
  const now = input.now ?? new Date();

  if (input.scope !== "member" && input.scope !== "zone") {
    throw new ErasureRequestError(
      "invalid_scope",
      `unknown scope: ${String(input.scope)}`,
    );
  }
  if (input.scope === "member" && !input.memberId) {
    throw new ErasureRequestError(
      "member_required",
      "scope='member' requires a memberId",
    );
  }
  if (input.scope === "zone" && input.memberId) {
    throw new ErasureRequestError(
      "member_forbidden",
      "scope='zone' must not carry a memberId",
    );
  }

  // Resolve the reversibility window.
  let windowDays: number;
  if (input.scope === "zone") {
    windowDays = DEFAULT_WINDOW_DAYS;
  } else {
    const policy = await loadRetentionPolicy(database, input.zoneId);
    const policyDays = policy.member_soft_deletes.retainDays;
    windowDays = Math.max(
      DEFAULT_WINDOW_DAYS,
      policyDays > 0 ? policyDays : DEFAULT_WINDOW_DAYS,
    );
  }
  if (input.windowDays !== undefined) {
    if (
      !Number.isInteger(input.windowDays) ||
      input.windowDays < 1 ||
      input.windowDays > 365
    ) {
      throw new ErasureRequestError(
        "invalid_scope",
        "windowDays must be an integer in [1, 365]",
      );
    }
    windowDays = input.windowDays;
  }

  // Zone-scope: confirm a recent export exists.
  if (input.scope === "zone") {
    if (!input.confirmExportId) {
      throw new ErasureRequestError(
        "recent_export_required",
        "scope='zone' requires confirmExportId pointing at a recent completed export",
      );
    }
    const cutoff = new Date(now.getTime() - RECENT_EXPORT_WINDOW_MS);
    const [exportRow] = await database
      .select({ id: zoneExports.id, completedAt: zoneExports.completedAt })
      .from(zoneExports)
      .where(
        and(
          eq(zoneExports.id, input.confirmExportId),
          eq(zoneExports.zoneId, input.zoneId),
          eq(zoneExports.status, "completed"),
          gte(zoneExports.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (!exportRow) {
      throw new ErasureRequestError(
        "recent_export_required",
        "confirmExportId must reference a completed export for this zone created in the last 7 days",
      );
    }
  }

  // Member-scope: surface a clearer 409 than the bare unique-index
  // violation when a duplicate pending row already exists.
  if (input.scope === "member" && input.memberId) {
    const [existing] = await database
      .select({ id: erasureRequests.id })
      .from(erasureRequests)
      .where(
        and(
          eq(erasureRequests.zoneId, input.zoneId),
          eq(erasureRequests.memberId, input.memberId),
          eq(erasureRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ErasureRequestError(
        "duplicate_pending",
        "an erasure request is already pending for this member",
        { existingId: existing.id },
      );
    }
  }
  // Zone-scope: same shape but the unique index has different keys.
  if (input.scope === "zone") {
    const [existing] = await database
      .select({ id: erasureRequests.id })
      .from(erasureRequests)
      .where(
        and(
          eq(erasureRequests.zoneId, input.zoneId),
          eq(erasureRequests.scope, "zone"),
          eq(erasureRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ErasureRequestError(
        "duplicate_pending",
        "a zone-erase request is already pending for this zone",
        { existingId: existing.id },
      );
    }
  }

  const appliesAt = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  return await database.transaction(async (tx) => {
    const [row] = await tx
      .insert(erasureRequests)
      .values({
        zoneId: input.zoneId,
        scope: input.scope,
        memberId: input.scope === "member" ? (input.memberId ?? null) : null,
        requestedByUserId: input.actorUserId,
        reason: input.reason ?? null,
        status: "pending",
        reversibilityWindowDays: windowDays,
        appliesAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Zone-scope: we intentionally DO NOT soft-decommission the
    // zone at scheduling time. The cancel window has to remain a
    // usable window — the owner needs `/zone/settings` to render
    // so they can hit "Cancel deletion". Soft-decommission would
    // mean the tenant middleware (which filters on
    // `isNull(zones.deletedAt)`) returns 404 for every route, so
    // the cancel UI is unreachable except via a platform-admin.
    // The apply path performs the soft-decommission immediately
    // before the hard-purge instead.

    // Audit. Member-scope is tenant-scope so it shows up on
    // `/zone/audit`; zone-scope is platform-scope so the row
    // survives the eventual cascade.
    if (input.scope === "member") {
      await writeAudit(tx, {
        zoneId: input.zoneId,
        actorUserId: input.actorUserId,
        action: "member.erase.scheduled",
        entityType: "member",
        entityId: input.memberId ?? null,
        after: toSummary(row),
      });
    } else {
      await writeAudit(tx, {
        zoneId: null,
        actorUserId: input.actorUserId,
        action: "platform.zone.erase.scheduled",
        entityType: "zone",
        entityId: input.zoneId,
        after: toSummary(row),
      });
    }

    return toSummary(row);
  });
}

export interface CancelErasureRequestInput {
  zoneId: string;
  requestId: string;
  actorUserId: string | null;
  reason?: string | null;
  now?: Date;
}

/**
 * Cancel a `pending` request. 404 when the row doesn't belong to
 * the caller's zone (so cross-zone probes look identical to "not
 * found"). 409 when the row is no longer `pending`.
 *
 * For zone-scope: re-activates the zone by clearing `deleted_at`
 * so the operator regains access. Member-scope: no zone change
 * needed (the member row was never touched).
 */
export async function cancelErasureRequest(
  database: Db,
  input: CancelErasureRequestInput,
): Promise<ErasureRequestSummary> {
  const now = input.now ?? new Date();
  return await database.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(erasureRequests)
      .where(
        and(
          eq(erasureRequests.id, input.requestId),
          eq(erasureRequests.zoneId, input.zoneId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new ErasureRequestError("not_found", "erasure request not found");
    }
    if (row.status !== "pending") {
      throw new ErasureRequestError(
        "not_pending",
        `cannot cancel request in status ${row.status}`,
      );
    }

    const [updated] = await tx
      .update(erasureRequests)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelledByUserId: input.actorUserId,
        reason: input.reason ?? row.reason,
        updatedAt: now,
      })
      .where(eq(erasureRequests.id, row.id))
      .returning();

    // Zone-scope cancel: nothing to undo on the zone row because
    // we never soft-decommissioned at scheduling time (see
    // `createErasureRequest` comment). The audit row and the
    // `status='cancelled'` flip below are the whole change.

    if (row.scope === "member") {
      await writeAudit(tx, {
        zoneId: input.zoneId,
        actorUserId: input.actorUserId,
        action: "member.erase.cancelled",
        entityType: "member",
        entityId: row.memberId,
        before: toSummary(row),
        after: toSummary(updated),
        reason: input.reason ?? null,
      });
    } else {
      await writeAudit(tx, {
        zoneId: null,
        actorUserId: input.actorUserId,
        action: "platform.zone.erase.cancelled",
        entityType: "zone",
        entityId: input.zoneId,
        before: toSummary(row),
        after: toSummary(updated),
        reason: input.reason ?? null,
      });
    }

    return toSummary(updated);
  });
}

export interface ApplyErasureRequestInput {
  requestId: string;
  /** Cron-applied scrubs carry null. */
  actorUserId: string | null;
  now?: Date;
}

/**
 * Run the scrub. Idempotent only at the row-status level —
 * calling this twice on a `pending` row is undefined; the cron
 * sweep + the route use `for update skip locked` to claim a row
 * before the call so only one worker apply per row at a time.
 *
 * Member-scope: UPDATE the member row in place with the scrub
 * patch, hard-delete every `member_addresses` row, write the
 * tenant-scope `member.erase.applied` audit row carrying the
 * pre-scrub member shape as `before` (the audit-truth
 * requirement).
 *
 * Zone-scope: call `hardPurgeZone` which deletes every blob and
 * DELETEs the zone tree. The platform-scope
 * `platform.zone.erase.applied` audit row is written BEFORE the
 * hard-purge so a CASCADE failure mid-write doesn't lose the
 * GDPR evidence trail.
 */
export async function applyErasureRequest(
  database: Db,
  input: ApplyErasureRequestInput,
): Promise<ErasureRequestSummary> {
  const now = input.now ?? new Date();
  // We deliberately split the transactions: the read-and-claim
  // is one tx; the scrub work is the next. For zone-scope the
  // hard-purge has to span an inter-table cascade that's larger
  // than we want to hold the row lock for, and a failure after
  // the claim is correctly captured as `failed` via the catch.
  const [row] = await database
    .select()
    .from(erasureRequests)
    .where(eq(erasureRequests.id, input.requestId))
    .limit(1);
  if (!row) {
    throw new ErasureRequestError("not_found", "erasure request not found");
  }
  if (row.status !== "pending") {
    throw new ErasureRequestError(
      "not_pending",
      `cannot apply request in status ${row.status}`,
    );
  }

  try {
    if (row.scope === "member") {
      if (!row.memberId) {
        // Defensive: a pending member-scope row without a
        // member_id would violate the CHECK; the row shouldn't
        // exist. Surface as a hard error.
        throw new Error(
          `pending member-scope erasure_request ${row.id} has null member_id`,
        );
      }
      await database.transaction(async (tx) => {
        // The `pending` member-scope row CHECK guarantees a
        // non-null member_id, and the FK ON DELETE SET NULL
        // collides with that CHECK — so the member row is
        // un-hard-deletable while a pending request exists.
        // The SELECT therefore always returns a row.
        const [pre] = await tx
          .select()
          .from(members)
          .where(eq(members.id, row.memberId as string))
          .limit(1);
        if (!pre) {
          // Defensive: a manual SQL surgery could in theory
          // bypass the FK guard. Treat as a hard error rather
          // than a silent success — the operator should know.
          throw new Error(
            `member ${row.memberId} missing for pending erasure_request ${row.id}`,
          );
        }
        const patch = buildMemberScrubPatch({
          member: { deletedAt: pre.deletedAt },
          requestId: row.id,
          actorUserId: input.actorUserId,
          now,
        });
        await tx.update(members).set(patch).where(eq(members.id, pre.id));
        // Hard-delete addresses (every PII row for the
        // member). The member_addresses table cascades on
        // member_id but we want it gone now, not on a
        // hypothetical future member hard-delete.
        await tx.execute(
          sql`delete from member_addresses where member_id = ${pre.id}`,
        );
        await writeAudit(tx, {
          zoneId: row.zoneId,
          actorUserId: input.actorUserId,
          action: "member.erase.applied",
          entityType: "member",
          entityId: pre.id,
          before: pre,
          after: patch,
        });
        await tx
          .update(erasureRequests)
          .set({ status: "applied", appliedAt: now, updatedAt: now })
          .where(eq(erasureRequests.id, row.id));
      });
    } else {
      // Zone-scope apply. Order:
      //   1. Soft-decommission so the tenant middleware refuses
      //      every authenticated request mid-purge (a long-
      //      running purge could otherwise overlap with a final
      //      pre-cancel write).
      //   2. Commit the platform-scope audit row + status flip
      //      so the GDPR evidence trail outlives the cascade.
      //   3. Hard-purge.
      await softDecommissionZone(database, { zoneId: row.zoneId, now });
      await database.transaction(async (tx) => {
        await writeAudit(tx, {
          zoneId: null,
          actorUserId: input.actorUserId,
          action: "platform.zone.erase.applied",
          entityType: "zone",
          entityId: row.zoneId,
          before: toSummary(row),
          after: {
            ...toSummary(row),
            status: "applied",
            appliedAt: now.toISOString(),
          },
        });
        await tx
          .update(erasureRequests)
          .set({ status: "applied", appliedAt: now, updatedAt: now })
          .where(eq(erasureRequests.id, row.id));
      });
      // The hard-purge is outside the audit transaction because
      // it cascades the zone row away — including the
      // erasure_requests row we just updated. We've already
      // committed the platform-scope audit row and the request
      // status, so a failure here just leaves orphan blobs (the
      // zone is already soft-decommissioned + invisible).
      const summary = await hardPurgeZone(database, row.zoneId);
      log.info(
        { requestId: row.id, zoneId: row.zoneId, summary },
        "erasure apply: zone hard-purge complete",
      );
    }

    const [final] = await database
      .select()
      .from(erasureRequests)
      .where(eq(erasureRequests.id, row.id))
      .limit(1);
    // Zone-scope: the row is gone (cascade swept it).
    // Return a synthetic summary built from the pre-cascade row.
    return final
      ? toSummary(final)
      : toSummary({ ...row, status: "applied", appliedAt: now, updatedAt: now });
  } catch (err) {
    log.error(
      { err, requestId: row.id, zoneId: row.zoneId },
      "erasure apply: scrub failed; marking request failed",
    );
    await database
      .update(erasureRequests)
      .set({
        status: "failed",
        errorCode: "apply_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        updatedAt: now,
      })
      .where(eq(erasureRequests.id, row.id));
    throw err;
  }
}

export interface ListErasureRequestsInput {
  zoneId: string;
  status?: ErasureStatus;
  scope?: ErasureScope;
  limit?: number;
}

export async function listErasureRequests(
  database: Db,
  input: ListErasureRequestsInput,
): Promise<ErasureRequestSummary[]> {
  const conds = [eq(erasureRequests.zoneId, input.zoneId)];
  if (input.status) conds.push(eq(erasureRequests.status, input.status));
  if (input.scope) conds.push(eq(erasureRequests.scope, input.scope));
  const rows = await database
    .select()
    .from(erasureRequests)
    .where(and(...conds))
    .orderBy(desc(erasureRequests.createdAt))
    .limit(input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 50);
  return rows.map(toSummary);
}

export async function getErasureRequestForZone(
  database: Db,
  zoneId: string,
  requestId: string,
): Promise<ErasureRequestSummary | null> {
  const [row] = await database
    .select()
    .from(erasureRequests)
    .where(
      and(
        eq(erasureRequests.id, requestId),
        eq(erasureRequests.zoneId, zoneId),
      ),
    )
    .limit(1);
  return row ? toSummary(row) : null;
}
