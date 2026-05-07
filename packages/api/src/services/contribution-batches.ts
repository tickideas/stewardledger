// packages/api/src/services/contribution-batches.ts
// Phase 5 — contribution batch lifecycle (draft → submitted → approved →
// posted; or → voided from any non-posted state). Posting a batch flips
// every still-draft contribution attached to it to posted in the same tx.
//
// Single-currency invariant: every contribution attached to a batch must
// share the batch's currencyCode. The contribution write paths
// (services/contributions.ts) reject mismatched-currency attaches; this
// module re-checks at post time as defense-in-depth.

import { and, asc, desc, eq, sql } from "drizzle-orm";
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
import { writeAudit } from "./audit";
import { ContributionError } from "./contributions";

interface ActorContext {
  zoneId: string;
  userId: string;
}

async function existsInZone<T extends { id: any; zoneId: any }>(
  database: Db,
  table: T,
  zoneId: string,
  id: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: table.id })
    .from(table as never)
    .where(and(eq(table.zoneId as never, zoneId), eq(table.id as never, id)))
    .limit(1);
  return rows.length > 0;
}

async function loadBatch(database: Db, zoneId: string, id: string): Promise<ContributionBatch | null> {
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
    conditions.push(sql`${contributionBatches.chapterId} in ${scope.chapterIds}`);
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
    if (
      input.serviceEventId &&
      !(await existsInZone(tx, serviceEvents, ctx.zoneId, input.serviceEventId))
    ) {
      throw new ContributionError("service_event_not_found", "Service event not in this zone.");
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
    if (
      patch.serviceEventId &&
      !(await existsInZone(tx, serviceEvents, ctx.zoneId, patch.serviceEventId))
    ) {
      throw new ContributionError("service_event_not_found", "Service event not in this zone.");
    }
    if (
      patch.paymentMethodId &&
      !(await existsInZone(tx, paymentMethods, ctx.zoneId, patch.paymentMethodId))
    ) {
      throw new ContributionError("payment_method_not_found", "Payment method not in this zone.");
    }
    const updates: Record<string, unknown> = { updatedAt: new Date(), updatedByUserId: ctx.userId };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) updates[k] = v;
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
    const [row] = await tx
      .update(contributionBatches)
      .set(updates)
      .where(and(eq(contributionBatches.zoneId, ctx.zoneId), eq(contributionBatches.id, id)))
      .returning();
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

    // Defense-in-depth: every contribution attached to the batch must share
    // its currency. The contribution write paths already reject mismatches
    // when attaching, but a manual SQL update could have slipped one in.
    const mismatched = await tx
      .select({ id: contributions.id, currencyCode: contributions.currencyCode })
      .from(contributions)
      .where(
        and(
          eq(contributions.zoneId, ctx.zoneId),
          eq(contributions.batchId, id),
          sql`${contributions.currencyCode} <> ${batch.currencyCode}`,
        ),
      )
      .limit(1);
    if (mismatched.length > 0) {
      throw new ContributionError(
        "batch_currency_mismatch",
        `Batch contains a contribution in a different currency (${mismatched[0].currencyCode} vs ${batch.currencyCode}).`,
      );
    }

    const now = new Date();
    const draftRows = await tx
      .select({ id: contributions.id })
      .from(contributions)
      .where(
        and(
          eq(contributions.zoneId, ctx.zoneId),
          eq(contributions.batchId, id),
          eq(contributions.status, "draft"),
        ),
      );
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
      for (const row of draftRows) {
        await writeAudit(tx, {
          zoneId: ctx.zoneId,
          actorUserId: ctx.userId,
          action: "contribution.post",
          entityType: "contribution",
          entityId: row.id,
          before: { status: "draft" },
          after: { status: "posted", batchId: id },
        });
      }
    }

    const [updated] = await tx
      .update(contributionBatches)
      .set({
        status: "posted",
        postedAt: now,
        postedByUserId: ctx.userId,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(and(eq(contributionBatches.zoneId, ctx.zoneId), eq(contributionBatches.id, id)))
      .returning();

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

// Avoid an unused-import warning for `asc` if we never sort ascending —
// keep it for future filters where it's natural.
export const _internal = { asc };
