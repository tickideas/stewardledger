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
import {
  assertReferenceCodeInRange,
  PayingInBookError,
} from "./paying-in-books/validate";
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
    // Paying-in book validation: when a treasurer attaches a
    // reference code, confirm it falls within an active book for
    // the chapter on the batch's date. "Batch date" is the
    // attached service event's date when present, otherwise today
    // UTC — the same calendar a treasurer would use to look up
    // an active pad.
    if (input.referenceCode) {
      const onDate = await resolveBatchValidationDate(
        tx,
        ctx.zoneId,
        input.serviceEventId ?? null,
      );
      try {
        await assertReferenceCodeInRange(tx, {
          zoneId: ctx.zoneId,
          chapterId: input.chapterId,
          referenceCode: input.referenceCode,
          onDate,
        });
      } catch (err) {
        if (err instanceof PayingInBookError) {
          throw new ContributionError(err.code, err.message);
        }
        throw err;
      }
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
    // Re-validate the paying-in-book reference code on update. We
    // only fire when the patch SETS a non-null code; clearing the
    // code (\`null\`) is always allowed. The lookup date follows
    // the patch's service event when set, otherwise the existing
    // batch's service event, otherwise today.
    if (patch.referenceCode) {
      const onDate = await resolveBatchValidationDate(
        tx,
        ctx.zoneId,
        patch.serviceEventId ?? existing.serviceEventId,
      );
      try {
        await assertReferenceCodeInRange(tx, {
          zoneId: ctx.zoneId,
          chapterId: existing.chapterId,
          referenceCode: patch.referenceCode,
          onDate,
        });
      } catch (err) {
        if (err instanceof PayingInBookError) {
          throw new ContributionError(err.code, err.message);
        }
        throw err;
      }
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
    // Row-lock the batch for the duration of the tx so a parallel
    // transition (whether same-target like submit+submit, or
    // different-target like submit+void on a draft) blocks until we
    // commit. Without the lock, READ COMMITTED lets a parallel `void`
    // re-evaluate its UPDATE WHERE clause against the row's new
    // post-submit status and — because void's `from` includes
    // 'submitted' — succeed on top of our submit. With the lock the
    // second tx waits, then re-reads the row at the new committed
    // version, sees the status change, and surfaces a typed
    // `invalid_transition` via the conditional UPDATE below.
    const [batch] = await tx
      .select()
      .from(contributionBatches)
      .where(
        and(
          eq(contributionBatches.zoneId, ctx.zoneId),
          eq(contributionBatches.id, id),
        ),
      )
      .for("update")
      .limit(1);
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
    // Conditional UPDATE on top of the row lock above. The lock
    // serialises across transitions; the WHERE clause filter on
    // source statuses serialises within a single transition path
    // (defence-in-depth) and gives us a clean zero-rows signal if a
    // future maintainer drops the FOR UPDATE.
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
    // Use `.returning()` and audit only the rows that ACTUALLY
    // flipped, not the pre-flight count. A parallel `postContribution`
    // could have posted some of these drafts between our scan and the
    // UPDATE; the conditional WHERE filters them out, so we must
    // mirror that in the audit log. (Pre-fix: the loser wrote false
    // `contribution.post` events that only the tx rollback hid;
    // splitting the writes across two transactions later would silently
    // leak the false audits.)
    let postedIds: string[] = [];
    if (draftRows.length > 0) {
      const flipped = await tx
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
        )
        .returning({ id: contributions.id });
      postedIds = flipped.map((r) => r.id);
      if (postedIds.length > 0) {
        await writeAuditMany(
          tx,
          postedIds.map((cid) => ({
            zoneId: ctx.zoneId,
            actorUserId: ctx.userId,
            action: "contribution.post",
            entityType: "contribution",
            entityId: cid,
            before: { status: "draft" },
            after: { status: "posted", batchId: id },
          })),
        );
      }
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
      after: { status: "posted", postedContributions: postedIds.length },
    });

    return { batch: updated, postedCount: postedIds.length };
  });
}

// Re-export so route handlers can match on the shared error class without
// introducing an import cycle when the routes module pulls both services.
export { ContributionError };

/**
 * Resolve the calendar date the paying-in-book validator should
 * check against. Service event date wins when set (that's the
 * treasurer's intent — "this is the pad I used at Sunday
 * service"); otherwise today UTC. We don't try a zone-tz
 * lookup here because the validation surface is a date range,
 * not a wall-clock instant; the day-grain mismatch a TZ shift
 * would introduce is harmless at this scale (a pad open for
 * "2025-01-01..2025-12-31" still resolves the same code
 * regardless of which civil day a treasurer is on at the
 * UTC ↔ local boundary).
 */
async function resolveBatchValidationDate(
  database: Db,
  zoneId: string,
  serviceEventId: string | null,
): Promise<string> {
  if (serviceEventId) {
    const [evt] = await database
      .select({ serviceDate: serviceEvents.serviceDate })
      .from(serviceEvents)
      .where(
        and(eq(serviceEvents.zoneId, zoneId), eq(serviceEvents.id, serviceEventId)),
      )
      .limit(1);
    if (evt?.serviceDate) return evt.serviceDate;
  }
  return new Date().toISOString().slice(0, 10);
}
