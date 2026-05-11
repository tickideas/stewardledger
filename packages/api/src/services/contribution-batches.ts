// packages/api/src/services/contribution-batches.ts
// Phase 5 — contribution batch lifecycle (draft → submitted → approved →
// posted; or → voided from any non-posted state). Posting a batch flips
// every still-draft contribution attached to it to posted in the same tx.
//
// Single-currency invariant: every contribution attached to a batch must
// share the batch's currencyCode. The contribution write paths
// (services/contributions.ts) reject mismatched-currency attaches; this
// module re-checks at post time as defense-in-depth.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  chapters,
  contributionBatches,
  contributions,
  paymentMethods,
  serviceEvents,
  zones,
  type ContributionBatch,
} from "@stewardledger/db/schema";
import type { Database, Db } from "@stewardledger/db";
import type {
  ContributionBatchCreateInput,
  ContributionBatchListQuery,
  ContributionBatchUpdateInput,
} from "@stewardledger/shared";
import { writeAudit, writeAuditMany } from "./audit";
import { ContributionError } from "./contributions";
import { existsInZone } from "./_zone-scope";

interface ActorContext {
  zoneId: string;
  userId: string;
}

async function loadBatch(
  database: Db,
  zoneId: string,
  id: string,
): Promise<ContributionBatch | null> {
  const [row] = await database
    .select()
    .from(contributionBatches)
    .where(and(eq(contributionBatches.zoneId, zoneId), eq(contributionBatches.id, id)))
    .limit(1);
  return row ?? null;
}

export async function getBatch(
  database: Database,
  zoneId: string,
  id: string,
): Promise<ContributionBatch | null> {
  return loadBatch(database, zoneId, id);
}

export async function listBatches(
  database: Database,
  zoneId: string,
  query: ContributionBatchListQuery,
  scope: { chapterIds?: string[] } = {},
): Promise<{ items: ContributionBatch[]; total: number }> {
  const conditions = [eq(contributionBatches.zoneId, zoneId)];
  if (query.chapterId) conditions.push(eq(contributionBatches.chapterId, query.chapterId));
  if (query.status) conditions.push(eq(contributionBatches.status, query.status));
  if (scope.chapterIds && scope.chapterIds.length > 0) {
    // `inArray` produces a properly-parameterised `chapter_id = ANY($1)`;
    // the previous `sql\`in ${array}\`` template bound the array as a
    // single param and either errored or mis-filtered.
    conditions.push(inArray(contributionBatches.chapterId, scope.chapterIds));
  } else if (scope.chapterIds) {
    return { items: [], total: 0 };
  }
  const where = and(...conditions);
  const items = await database
    .select()
    .from(contributionBatches)
    .where(where)
    .orderBy(desc(contributionBatches.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [{ total }] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(contributionBatches)
    .where(where);
  return { items, total };
}

export async function createBatch(
  database: Database,
  ctx: ActorContext,
  input: ContributionBatchCreateInput,
): Promise<ContributionBatch> {
  return database.transaction(async (tx) => {
    if (!(await existsInZone(tx, chapters, ctx.zoneId, input.chapterId))) {
      throw new ContributionError("chapter_not_found", "Chapter not in this zone.");
    }
    if (input.serviceEventId) {
      const [evt] = await tx
        .select({ id: serviceEvents.id, chapterId: serviceEvents.chapterId })
        .from(serviceEvents)
        .where(
          and(
            eq(serviceEvents.zoneId, ctx.zoneId),
            eq(serviceEvents.id, input.serviceEventId),
          ),
        )
        .limit(1);
      if (!evt) {
        throw new ContributionError("service_event_not_found", "Service event not in this zone.");
      }
      if (evt.chapterId !== null && evt.chapterId !== input.chapterId) {
        throw new ContributionError(
          "service_event_chapter_mismatch",
          "Service event belongs to a different chapter than the batch.",
        );
      }
    }
    if (
      input.paymentMethodId &&
      !(await existsInZone(tx, paymentMethods, ctx.zoneId, input.paymentMethodId))
    ) {
      throw new ContributionError("payment_method_not_found", "Payment method not in this zone.");
    }
    let currency = input.currencyCode;
    if (!currency) {
      const [zone] = await tx
        .select({ defaultCurrencyCode: zones.defaultCurrencyCode })
        .from(zones)
        .where(eq(zones.id, ctx.zoneId))
        .limit(1);
      if (!zone) throw new ContributionError("zone_default_currency_missing", "Zone is missing.");
      currency = zone.defaultCurrencyCode;
    }
    const [row] = await tx
      .insert(contributionBatches)
      .values({
        zoneId: ctx.zoneId,
        chapterId: input.chapterId,
        serviceEventId: input.serviceEventId ?? null,
        paymentMethodId: input.paymentMethodId ?? null,
        sourceType: input.sourceType,
        referenceCode: input.referenceCode ?? null,
        cashTotal: input.cashTotal ?? null,
        chequeTotal: input.chequeTotal ?? null,
        currencyCode: currency,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution_batch.create",
      entityType: "contribution_batch",
      entityId: row.id,
      after: { status: row.status, currencyCode: row.currencyCode },
    });
    return row;
  });
}

// Allow-list of writable columns on draft-batch update. Using an explicit
// list — rather than `Object.entries(patch)` — keeps an unrelated future
// schema addition (e.g. `chapterId`, `currencyCode`, `status`,
// `posted_*`) from silently widening the SQL update surface and turning
// a bookkeeper PATCH into a privilege escalation.
const BATCH_UPDATE_COLUMNS = [
  "serviceEventId",
  "paymentMethodId",
  "referenceCode",
  "cashTotal",
  "chequeTotal",
  "notes",
] as const;
type BatchUpdateColumn = (typeof BATCH_UPDATE_COLUMNS)[number];

export async function updateDraftBatch(
  database: Database,
  ctx: ActorContext,
  id: string,
  patch: ContributionBatchUpdateInput,
): Promise<ContributionBatch> {
  return database.transaction(async (tx) => {
    const existing = await loadBatch(tx, ctx.zoneId, id);
    if (!existing) {
      throw new ContributionError("not_found", "Batch not in this zone.");
    }
    if (existing.status !== "draft") {
      throw new ContributionError(
        "not_draft",
        `Only draft batches can be edited (status='${existing.status}').`,
      );
    }
    if (patch.serviceEventId) {
      const [evt] = await tx
        .select({ id: serviceEvents.id, chapterId: serviceEvents.chapterId })
        .from(serviceEvents)
        .where(
          and(
            eq(serviceEvents.zoneId, ctx.zoneId),
            eq(serviceEvents.id, patch.serviceEventId),
          ),
        )
        .limit(1);
      if (!evt) {
        throw new ContributionError("service_event_not_found", "Service event not in this zone.");
      }
      if (evt.chapterId !== null && evt.chapterId !== existing.chapterId) {
        throw new ContributionError(
          "service_event_chapter_mismatch",
          "Service event belongs to a different chapter than the batch.",
        );
      }
    }
    if (
      patch.paymentMethodId &&
      !(await existsInZone(tx, paymentMethods, ctx.zoneId, patch.paymentMethodId))
    ) {
      throw new ContributionError("payment_method_not_found", "Payment method not in this zone.");
    }
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedByUserId: ctx.userId,
    };
    for (const k of BATCH_UPDATE_COLUMNS) {
      const v = (patch as Partial<Record<BatchUpdateColumn, unknown>>)[k];
      if (v !== undefined) updates[k] = v;
    }
    const [row] = await tx
      .update(contributionBatches)
      .set(updates)
      .where(and(eq(contributionBatches.zoneId, ctx.zoneId), eq(contributionBatches.id, id)))
      .returning();
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution_batch.update",
      entityType: "contribution_batch",
      entityId: id,
      after: patch,
    });
    return row;
  });
}

type Transition =
  | { from: ContributionBatch["status"][]; to: "submitted"; action: "submit" }
  | { from: ContributionBatch["status"][]; to: "approved"; action: "approve" }
  | { from: ContributionBatch["status"][]; to: "voided"; action: "void"; voidReason: string };

async function applyTransition(
  database: Database,
  ctx: ActorContext,
  id: string,
  t: Transition,
): Promise<ContributionBatch> {
  return database.transaction(async (tx) => {
    const batch = await loadBatch(tx, ctx.zoneId, id);
    if (!batch) {
      throw new ContributionError("not_found", "Batch not in this zone.");
    }
    if (!t.from.includes(batch.status)) {
      throw new ContributionError(
        "invalid_transition",
        `Cannot ${t.action} a batch in status '${batch.status}'.`,
      );
    }
    const now = new Date();
    const updates: Record<string, unknown> = {
      status: t.to,
      updatedAt: now,
      updatedByUserId: ctx.userId,
    };
    if (t.to === "submitted") {
      updates.submittedAt = now;
      updates.submittedByUserId = ctx.userId;
    } else if (t.to === "approved") {
      updates.approvedAt = now;
      updates.approvedByUserId = ctx.userId;
    } else if (t.to === "voided") {
      updates.voidedAt = now;
      updates.voidedByUserId = ctx.userId;
      updates.voidReason = t.voidReason;
    }
    // Conditional UPDATE filtered on the allowed source statuses so
    // two parallel transitions cannot both pass the pre-flight check
    // and both succeed (e.g. submit + void racing on a draft batch).
    // The loser sees zero affected rows and we re-classify as a typed
    // `invalid_transition`. Mirrors the postContribution race fix.
    const [row] = await tx
      .update(contributionBatches)
      .set(updates)
      .where(
        and(
          eq(contributionBatches.zoneId, ctx.zoneId),
          eq(contributionBatches.id, id),
          inArray(contributionBatches.status, t.from),
        ),
      )
      .returning();
    if (!row) {
      throw new ContributionError(
        "invalid_transition",
        `Cannot ${t.action} a batch — a parallel transition won the race.`,
      );
    }
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: `contribution_batch.${t.action}`,
      entityType: "contribution_batch",
      entityId: id,
      before: { status: batch.status },
      after: { status: t.to },
    });
    return row;
  });
}

export function submitBatch(database: Database, ctx: ActorContext, id: string) {
  return applyTransition(database, ctx, id, { from: ["draft"], to: "submitted", action: "submit" });
}

export function approveBatch(database: Database, ctx: ActorContext, id: string) {
  return applyTransition(database, ctx, id, {
    from: ["submitted"],
    to: "approved",
    action: "approve",
  });
}

export function voidBatch(
  database: Database,
  ctx: ActorContext,
  id: string,
  args: { voidReason: string },
) {
  return applyTransition(database, ctx, id, {
    from: ["draft", "submitted", "approved"],
    to: "voided",
    action: "void",
    voidReason: args.voidReason,
  });
}

/**
 * Promote an approved batch to posted. Every still-draft contribution
 * attached to the batch is posted in the same tx; mismatched-currency
 * contributions cause the whole transition to abort.
 */
export async function postBatch(
  database: Database,
  ctx: ActorContext,
  id: string,
): Promise<{ batch: ContributionBatch; postedCount: number }> {
  return database.transaction(async (tx) => {
    const batch = await loadBatch(tx, ctx.zoneId, id);
    if (!batch) {
      throw new ContributionError("not_found", "Batch not in this zone.");
    }
    if (batch.status !== "approved") {
      throw new ContributionError(
        "invalid_transition",
        `Only approved batches can be posted (status='${batch.status}').`,
      );
    }

    // Fuse the mismatch probe and the draft scan into a single round-trip:
    // both walk the same `(zoneId, batchId)` slice, and JS does the rest.
    const attached = await tx
      .select({
        id: contributions.id,
        status: contributions.status,
        currencyCode: contributions.currencyCode,
      })
      .from(contributions)
      .where(
        and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.batchId, id)),
      );
    const mismatched = attached.find((r) => r.currencyCode !== batch.currencyCode);
    if (mismatched) {
      throw new ContributionError(
        "batch_currency_mismatch",
        `Batch contains a contribution in a different currency (${mismatched.currencyCode} vs ${batch.currencyCode}).`,
      );
    }
    const draftRows = attached.filter((r) => r.status === "draft");

    const now = new Date();
    if (draftRows.length > 0) {
      await tx
        .update(contributions)
        .set({
          status: "posted",
          postedAt: now,
          postedByUserId: ctx.userId,
          updatedAt: now,
          updatedByUserId: ctx.userId,
        })
        .where(
          and(
            eq(contributions.zoneId, ctx.zoneId),
            eq(contributions.batchId, id),
            eq(contributions.status, "draft"),
          ),
        );
      // Bulk-insert one audit row per posted contribution. The previous
      // per-row loop produced N round-trips on what is meant to be the
      // one-shot Sunday-batch hot path.
      await writeAuditMany(
        tx,
        draftRows.map((row) => ({
          zoneId: ctx.zoneId,
          actorUserId: ctx.userId,
          action: "contribution.post",
          entityType: "contribution",
          entityId: row.id,
          before: { status: "draft" },
          after: { status: "posted", batchId: id },
        })),
      );
    }

    // Conditional UPDATE: `status='approved'` guards against a
    // parallel postBatch/voidBatch race. The loser sees zero affected
    // rows and surfaces a typed `invalid_transition`. Note the
    // companion `contributions` UPDATE above is *already* conditional
    // (`eq(contributions.status, "draft")`), so a partially-posted
    // race-loser would not have promoted any drafts — only the batch
    // status would have flipped under us. Catching it here keeps the
    // batch-row state consistent with the (no-op) post.
    const [updated] = await tx
      .update(contributionBatches)
      .set({
        status: "posted",
        postedAt: now,
        postedByUserId: ctx.userId,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(
        and(
          eq(contributionBatches.zoneId, ctx.zoneId),
          eq(contributionBatches.id, id),
          eq(contributionBatches.status, "approved"),
        ),
      )
      .returning();
    if (!updated) {
      throw new ContributionError(
        "invalid_transition",
        "Batch was no longer approved when post completed — a parallel transition won the race.",
      );
    }

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution_batch.post",
      entityType: "contribution_batch",
      entityId: id,
      before: { status: "approved" },
      after: { status: "posted", postedContributions: draftRows.length },
    });

    return { batch: updated, postedCount: draftRows.length };
  });
}

// Re-export so route handlers can match on the shared error class without
// introducing an import cycle when the routes module pulls both services.
export { ContributionError };
