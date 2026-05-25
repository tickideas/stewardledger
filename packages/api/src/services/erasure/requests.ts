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
  zones,
  type ErasureRequest,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

import {
  ERASURE_DEFAULT_WINDOW_DAYS,
  ERASURE_RECENT_EXPORT_WINDOW_DAYS,
  ERASURE_ZONE_WINDOW_DAYS,
} from "@stewardledger/shared";

import { log } from "../../logger";
import { writeAudit } from "../audit";
import { loadRetentionPolicy } from "../retention/policy";
import { buildMemberScrubPatch } from "./scrub-member";
import { hardPurgeZone } from "./scrub-zone";

export type ErasureScope = "member" | "zone";
export type ErasureStatus = "pending" | "applied" | "cancelled" | "failed";

/**
 * Minimum reversibility window. Zone-scope is fixed at this;
 * member-scope reads the per-zone retention policy and floors
 * to this value when the policy is 0 (= "never purge", the v1
 * default). Spec: `tasks/gdpr-erase-workflow.md` §"Reversibility
 * window". Sourced from `@stewardledger/shared` so the UI
 * mirror in `/zone/settings` stays in lockstep.
 */
const DEFAULT_WINDOW_DAYS = ERASURE_DEFAULT_WINDOW_DAYS;

/**
 * For zone-scope requests, the most recent `completed`
 * `zone_exports` row must sit within this window — refusing to
 * schedule a zone-erase without a recent take-with-them artefact
 * is a hard acceptance criterion.
 */
const RECENT_EXPORT_WINDOW_MS =
  ERASURE_RECENT_EXPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export class ErasureRequestError extends Error {
  constructor(
    readonly code:
      | "invalid_scope"
      | "member_required"
      | "member_forbidden"
      | "duplicate_pending"
      | "not_found"
      | "not_pending"
      | "recent_export_required"
      | "concurrent_apply",
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

  // Resolve the reversibility window. Zone-scope is fixed at
  // the shared `ERASURE_ZONE_WINDOW_DAYS`; member-scope reads
  // the per-zone retention policy and floors to the shared
  // default. Sourcing both from `@stewardledger/shared` keeps
  // the UI mirrors in lockstep.
  let windowDays: number;
  if (input.scope === "zone") {
    windowDays = ERASURE_ZONE_WINDOW_DAYS;
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
 * Run the scrub. The apply path opens a transaction that claims
 * the row with `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent
 * workers (cron beat + operator-triggered apply, or two cron
 * beats in a multi-node future) can never both process the same
 * row: the second caller sees zero rows from the locking SELECT
 * and surfaces a `concurrent_apply` error.
 *
 * Member-scope: claim → load member → UPDATE the member row
 * with the scrub patch → hard-delete every `member_addresses`
 * row → write the tenant-scope `member.erase.applied` audit row
 * carrying the pre-scrub member shape as `before` (the audit-
 * truth requirement) → flip status to `applied`. All in one
 * transaction; the row lock is released at COMMIT.
 *
 * Zone-scope: claim → soft-decommission (idempotent UPDATE inside
 * the same tx) → write platform-scope
 * `platform.zone.erase.applied` audit row → flip status to
 * `applied` → COMMIT (releasing the row lock). The hard-purge
 * (`hardPurgeZone`) then runs OUTSIDE the transaction because it
 * cascades the row away — including the erasure_requests row we
 * just updated — and we don't want to hold a lock on a row
 * across a `DELETE FROM zones` that's about to remove it. The
 * audit row + status commit BEFORE the hard-purge so a CASCADE
 * failure mid-write doesn't lose the GDPR evidence trail.
 */
export async function applyErasureRequest(
  database: Db,
  input: ApplyErasureRequestInput,
): Promise<ErasureRequestSummary> {
  const now = input.now ?? new Date();

  // Claim + scrub inside one transaction. The locking SELECT
  // (FOR UPDATE SKIP LOCKED) is the concurrency boundary — a
  // second concurrent caller against the same row sees zero
  // rows here and falls into the `concurrent_apply` branch.
  // Returns the captured row for the zone-scope hard-purge
  // that has to run after COMMIT (it cascades the row away).
  type Captured = {
    row: ErasureRequest;
    appliedRow: ErasureRequest | undefined;
  };
  let captured: Captured;
  try {
    captured = await database.transaction<Captured>(async (tx) => {
      const [row] = await tx
        .select()
        .from(erasureRequests)
        .where(eq(erasureRequests.id, input.requestId))
        .for("update", { skipLocked: true })
        .limit(1);
      if (!row) {
        // Either the row doesn't exist OR another worker is
        // already holding the lock. Distinguish with a quick
        // unlocked probe so callers get the correct error code.
        const [probe] = await tx
          .select({ id: erasureRequests.id })
          .from(erasureRequests)
          .where(eq(erasureRequests.id, input.requestId))
          .limit(1);
        if (!probe) {
          throw new ErasureRequestError(
            "not_found",
            "erasure request not found",
          );
        }
        throw new ErasureRequestError(
          "concurrent_apply",
          "erasure request is being applied by another worker",
        );
      }
      if (row.status !== "pending") {
        throw new ErasureRequestError(
          "not_pending",
          `cannot apply request in status ${row.status}`,
        );
      }

      if (row.scope === "member") {
        if (!row.memberId) {
          // Defensive: a pending member-scope row without a
          // member_id would violate the CHECK; the row shouldn't
          // exist. Surface as a hard error.
          throw new Error(
            `pending member-scope erasure_request ${row.id} has null member_id`,
          );
        }
        // The `pending` member-scope row CHECK guarantees a
        // non-null member_id, and the FK ON DELETE SET NULL
        // collides with that CHECK — so the member row is
        // un-hard-deletable while a pending request exists.
        // The SELECT therefore always returns a row.
        const [pre] = await tx
          .select()
          .from(members)
          .where(eq(members.id, row.memberId))
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
        const [appliedRow] = await tx
          .update(erasureRequests)
          .set({ status: "applied", appliedAt: now, updatedAt: now })
          .where(eq(erasureRequests.id, row.id))
          .returning();
        return { row, appliedRow };
      }

      // Zone-scope apply (in-tx phase). Order:
      //   1. Soft-decommission so the tenant middleware refuses
      //      every authenticated request mid-purge (a long-
      //      running purge could otherwise overlap with a final
      //      pre-cancel write).
      //   2. Commit the platform-scope audit row + status flip
      //      so the GDPR evidence trail outlives the cascade.
      //   3. (Outside this tx) Hard-purge.
      await tx
        .update(zones)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(zones.id, row.zoneId));
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
      const [appliedRow] = await tx
        .update(erasureRequests)
        .set({ status: "applied", appliedAt: now, updatedAt: now })
        .where(eq(erasureRequests.id, row.id))
        .returning();
      return { row, appliedRow };
    });
  } catch (err) {
    // In-tx failures: the transaction rolled back, no audit row
    // committed, no member scrub committed, no status flip. The
    // row is still `pending` and another sweep can retry it.
    // We additionally write a non-tx status='failed' marker so
    // an operator can see the failure on the next list call.
    if (err instanceof ErasureRequestError) throw err;
    log.error(
      { err, requestId: input.requestId },
      "erasure apply: in-transaction failure; marking request failed",
    );
    await database
      .update(erasureRequests)
      .set({
        status: "failed",
        errorCode: "apply_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        updatedAt: now,
      })
      .where(
        and(
          eq(erasureRequests.id, input.requestId),
          eq(erasureRequests.status, "pending"),
        ),
      );
    throw err;
  }

  const { row, appliedRow } = captured;

  if (row.scope === "zone") {
    // Post-commit hard-purge. Runs outside the audit tx because
    // it cascades the zone row away — including the
    // erasure_requests row we just updated. The platform-scope
    // audit row + the request status are already committed, so
    // a failure here just leaves orphan blobs (the zone is
    // already soft-decommissioned + invisible). We log loudly
    // and re-throw so the cron telemetry counts the failure;
    // we deliberately do NOT flip the request status back to
    // `failed` because the request DID apply at the audit-log
    // level — a status mismatch would contradict the audit row.
    try {
      const summary = await hardPurgeZone(database, row.zoneId);
      log.info(
        { requestId: row.id, zoneId: row.zoneId, summary },
        "erasure apply: zone hard-purge complete",
      );
    } catch (err) {
      log.error(
        { err, requestId: row.id, zoneId: row.zoneId },
        "erasure apply: post-commit hard-purge failed; request remains 'applied' (audit row already written); operator must clean up storage / cascade state manually",
      );
      throw err;
    }
  }

  // Member-scope: appliedRow holds the post-update row.
  // Zone-scope: appliedRow held the row pre-cascade (or undefined
  // if hard-purge already swept it before we got here, which can
  // happen if the cascade fired synchronously in a follow-up
  // race). Synthesise from the captured `row` as a fallback.
  return appliedRow
    ? toSummary(appliedRow)
    : toSummary({
        ...row,
        status: "applied",
        appliedAt: now,
        updatedAt: now,
      });
}

export interface ListErasureRequestsInput {
  zoneId: string;
  status?: ErasureStatus;
  scope?: ErasureScope;
  /**
   * Narrow to a single member's requests. Used by the member-
   * detail UI so a Privacy panel render is O(1) per member
   * instead of fetching the zone's entire erasure history.
   */
  memberId?: string;
  limit?: number;
}

export async function listErasureRequests(
  database: Db,
  input: ListErasureRequestsInput,
): Promise<ErasureRequestSummary[]> {
  const conds = [eq(erasureRequests.zoneId, input.zoneId)];
  if (input.status) conds.push(eq(erasureRequests.status, input.status));
  if (input.scope) conds.push(eq(erasureRequests.scope, input.scope));
  if (input.memberId)
    conds.push(eq(erasureRequests.memberId, input.memberId));
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
