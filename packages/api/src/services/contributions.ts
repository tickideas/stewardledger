// packages/api/src/services/contributions.ts
// Phase 5 — contribution write paths. All financial mutations live here so
// the route layer is a thin adapter and the cross-tenant + sign-convention
// invariants are enforced in one place.
//
// Sign convention (see DOMAIN-MODEL.md §6): positive amounts are inflows
// (gifts); negative amounts are reversals. `reverseContribution` emits a
// corrective contribution whose lines are the exact negation of the
// original's, then flips the original to status='reversed'. Reports sum
// signed amounts so original + reversal net to zero.

import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  chapters,
  contributionBatches,
  contributionLines,
  contributionMembers,
  contributions,
  givingTypes,
  members,
  paymentMethods,
  serviceEvents,
  zones,
  type Contribution,
  type ContributionLine,
} from "@stewardledger/db/schema";
import type { Database, Db } from "@stewardledger/db";
import type {
  ContributionCreateInput,
  ContributionLineCreateInput,
  ContributionListQuery,
  ContributionMemberCreateInput,
  ContributionUpdateInput,
} from "@stewardledger/shared";
import { writeAudit } from "./audit";
import { deriveGivingPeriodForDate } from "./period-seed";

export class ContributionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ActorContext {
  zoneId: string;
  userId: string;
}

const MONEY_DP = 4;

function toMoneyString(d: Decimal): string {
  return d.toFixed(MONEY_DP);
}

function sumLines(lines: ContributionLineCreateInput[]): Decimal {
  return lines.reduce((acc, l) => acc.plus(new Decimal(l.amount)), new Decimal(0));
}

async function zoneDefaultCurrency(database: Db, zoneId: string): Promise<string> {
  const [zone] = await database
    .select({ defaultCurrencyCode: zones.defaultCurrencyCode })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!zone) {
    throw new ContributionError("zone_default_currency_missing", "Zone is missing.");
  }
  return zone.defaultCurrencyCode;
}

async function chapterRegionId(database: Db, zoneId: string, chapterId: string): Promise<string | null> {
  const [chapter] = await database
    .select({ regionId: chapters.regionId })
    .from(chapters)
    .where(and(eq(chapters.zoneId, zoneId), eq(chapters.id, chapterId)))
    .limit(1);
  if (!chapter) {
    throw new ContributionError("chapter_not_found", "Chapter not in this zone.");
  }
  return chapter.regionId ?? null;
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

async function assertReferencesInZone(
  database: Db,
  zoneId: string,
  input: {
    chapterId?: string | null;
    memberId?: string | null;
    batchId?: string | null;
    paymentMethodId?: string | null;
    serviceEventId?: string | null;
    lines?: { givingTypeId: string; accountId?: string | null }[];
    members?: { memberId: string }[];
  },
): Promise<void> {
  if (input.chapterId && !(await existsInZone(database, chapters, zoneId, input.chapterId))) {
    throw new ContributionError("chapter_not_found", "Chapter not in this zone.");
  }
  if (input.memberId && !(await existsInZone(database, members, zoneId, input.memberId))) {
    throw new ContributionError("member_not_found", "Member not in this zone.");
  }
  if (input.batchId && !(await existsInZone(database, contributionBatches, zoneId, input.batchId))) {
    throw new ContributionError("batch_not_found", "Batch not in this zone.");
  }
  if (
    input.paymentMethodId &&
    !(await existsInZone(database, paymentMethods, zoneId, input.paymentMethodId))
  ) {
    throw new ContributionError("payment_method_not_found", "Payment method not in this zone.");
  }
  if (
    input.serviceEventId &&
    !(await existsInZone(database, serviceEvents, zoneId, input.serviceEventId))
  ) {
    throw new ContributionError("service_event_not_found", "Service event not in this zone.");
  }
  for (const line of input.lines ?? []) {
    if (!(await existsInZone(database, givingTypes, zoneId, line.givingTypeId))) {
      throw new ContributionError("giving_type_not_found", "Giving type not in this zone.");
    }
    if (line.accountId && !(await existsInZone(database, accounts, zoneId, line.accountId))) {
      throw new ContributionError("account_not_found", "Account not in this zone.");
    }
  }
  for (const m of input.members ?? []) {
    if (!(await existsInZone(database, members, zoneId, m.memberId))) {
      throw new ContributionError("member_not_found", "Member (allocation) not in this zone.");
    }
  }
}

async function batchCurrency(database: Db, zoneId: string, batchId: string): Promise<string | null> {
  const [batch] = await database
    .select({
      currencyCode: contributionBatches.currencyCode,
      status: contributionBatches.status,
    })
    .from(contributionBatches)
    .where(and(eq(contributionBatches.zoneId, zoneId), eq(contributionBatches.id, batchId)))
    .limit(1);
  if (!batch) return null;
  if (batch.status === "voided" || batch.status === "posted") {
    throw new ContributionError(
      "batch_not_writable",
      `Cannot attach a draft contribution to a batch in status '${batch.status}'.`,
    );
  }
  return batch.currencyCode;
}

interface ContributionDetail {
  contribution: Contribution;
  lines: ContributionLine[];
  members: { id: string; memberId: string; allocationPercent: string | null }[];
}

async function loadDetail(
  database: Db,
  zoneId: string,
  id: string,
): Promise<ContributionDetail | null> {
  const [contribution] = await database
    .select()
    .from(contributions)
    .where(and(eq(contributions.zoneId, zoneId), eq(contributions.id, id)))
    .limit(1);
  if (!contribution) return null;
  const lines = await database
    .select()
    .from(contributionLines)
    .where(
      and(eq(contributionLines.zoneId, zoneId), eq(contributionLines.contributionId, id)),
    )
    .orderBy(asc(contributionLines.createdAt));
  const memberRows = await database
    .select({
      id: contributionMembers.id,
      memberId: contributionMembers.memberId,
      allocationPercent: contributionMembers.allocationPercent,
    })
    .from(contributionMembers)
    .where(
      and(eq(contributionMembers.zoneId, zoneId), eq(contributionMembers.contributionId, id)),
    );
  return { contribution, lines, members: memberRows };
}

export async function getContribution(
  database: Database,
  zoneId: string,
  id: string,
): Promise<ContributionDetail | null> {
  return loadDetail(database, zoneId, id);
}

export async function listContributions(
  database: Database,
  zoneId: string,
  query: ContributionListQuery,
  scope: { chapterIds?: string[] } = {},
): Promise<{ items: Contribution[]; total: number }> {
  const conditions = [eq(contributions.zoneId, zoneId)];
  if (query.chapterId) conditions.push(eq(contributions.chapterId, query.chapterId));
  if (query.memberId) conditions.push(eq(contributions.memberId, query.memberId));
  if (query.batchId) conditions.push(eq(contributions.batchId, query.batchId));
  if (query.status) conditions.push(eq(contributions.status, query.status));
  if (query.dateFrom) conditions.push(sql`${contributions.contributionDate} >= ${query.dateFrom}`);
  if (query.dateTo) conditions.push(sql`${contributions.contributionDate} <= ${query.dateTo}`);
  if (scope.chapterIds && scope.chapterIds.length > 0) {
    conditions.push(inArray(contributions.chapterId, scope.chapterIds));
  } else if (scope.chapterIds) {
    // Empty allow-list = no chapters in scope = no rows.
    return { items: [], total: 0 };
  }
  const where = and(...conditions);
  const items = await database
    .select()
    .from(contributions)
    .where(where)
    .orderBy(desc(contributions.contributionDate), desc(contributions.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [{ total }] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(contributions)
    .where(where);
  return { items, total };
}

/**
 * Insert a draft contribution + its lines + its member allocations atomically.
 * Currency defaults to the zone's default; the per-line currency-cohesion
 * trigger guarantees lines and parent agree.
 */
export async function createContribution(
  database: Database,
  ctx: ActorContext,
  input: ContributionCreateInput,
): Promise<ContributionDetail> {
  if (input.lines.length === 0) {
    throw new ContributionError("lines_required", "At least one line is required.");
  }

  return database.transaction(async (tx) => {
    const currency =
      input.currencyCode ?? (await zoneDefaultCurrency(tx, ctx.zoneId));

    await assertReferencesInZone(tx, ctx.zoneId, {
      chapterId: input.chapterId,
      memberId: input.memberId,
      batchId: input.batchId,
      paymentMethodId: input.paymentMethodId,
      serviceEventId: input.serviceEventId,
      lines: input.lines,
      members: input.members,
    });

    if (input.batchId) {
      const batchCcy = await batchCurrency(tx, ctx.zoneId, input.batchId);
      if (batchCcy && batchCcy !== currency) {
        throw new ContributionError(
          "batch_currency_mismatch",
          `Contribution currency (${currency}) does not match batch currency (${batchCcy}).`,
        );
      }
    }

    const computedTotal = sumLines(input.lines);
    if (input.totalAmount !== undefined) {
      const supplied = new Decimal(input.totalAmount);
      if (!supplied.equals(computedTotal)) {
        throw new ContributionError(
          "total_mismatch",
          `totalAmount (${supplied.toFixed(MONEY_DP)}) must equal the sum of line amounts (${computedTotal.toFixed(MONEY_DP)}).`,
        );
      }
    }

    let givingPeriodId: string | null = input.givingPeriodId ?? null;
    if (!givingPeriodId) {
      const period = await deriveGivingPeriodForDate(tx, ctx.zoneId, input.contributionDate);
      givingPeriodId = period?.id ?? null;
    }

    const regionId = input.chapterId
      ? await chapterRegionId(tx, ctx.zoneId, input.chapterId)
      : null;

    const [contribution] = await tx
      .insert(contributions)
      .values({
        zoneId: ctx.zoneId,
        regionId,
        batchId: input.batchId ?? null,
        chapterId: input.chapterId,
        memberId: input.memberId ?? null,
        sourceType: input.sourceType,
        paymentMethodId: input.paymentMethodId ?? null,
        serviceEventId: input.serviceEventId ?? null,
        givingPeriodId,
        contributionDate: input.contributionDate,
        totalAmount: toMoneyString(computedTotal),
        currencyCode: currency,
        externalTransactionId: input.externalTransactionId ?? null,
        description: input.description ?? null,
        status: "draft",
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();

    const insertedLines = await tx
      .insert(contributionLines)
      .values(
        input.lines.map((l) => ({
          zoneId: ctx.zoneId,
          contributionId: contribution.id,
          givingTypeId: l.givingTypeId,
          accountId: l.accountId ?? null,
          amount: toMoneyString(new Decimal(l.amount)),
          currencyCode: currency,
          note: l.note ?? null,
        })),
      )
      .returning();

    const memberRows = input.members?.length
      ? await tx
          .insert(contributionMembers)
          .values(
            input.members.map((m) => ({
              zoneId: ctx.zoneId,
              contributionId: contribution.id,
              memberId: m.memberId,
              allocationPercent: m.allocationPercent ?? null,
            })),
          )
          .returning({
            id: contributionMembers.id,
            memberId: contributionMembers.memberId,
            allocationPercent: contributionMembers.allocationPercent,
          })
      : [];

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution.create",
      entityType: "contribution",
      entityId: contribution.id,
      after: {
        status: contribution.status,
        chapterId: contribution.chapterId,
        memberId: contribution.memberId,
        totalAmount: contribution.totalAmount,
        currencyCode: contribution.currencyCode,
        lineCount: insertedLines.length,
      },
    });

    return { contribution, lines: insertedLines, members: memberRows };
  });
}

/**
 * Patch a draft contribution. Lines and members, when provided, REPLACE
 * the existing rows. Recomputes `total_amount` whenever lines change.
 */
export async function updateDraftContribution(
  database: Database,
  ctx: ActorContext,
  id: string,
  patch: ContributionUpdateInput,
): Promise<ContributionDetail> {
  return database.transaction(async (tx) => {
    const detail = await loadDetail(tx, ctx.zoneId, id);
    if (!detail) {
      throw new ContributionError("not_found", "Contribution not in this zone.");
    }
    if (detail.contribution.status !== "draft") {
      throw new ContributionError("not_draft", "Only draft contributions can be edited.");
    }

    await assertReferencesInZone(tx, ctx.zoneId, {
      memberId: patch.memberId ?? null,
      batchId: patch.batchId ?? null,
      paymentMethodId: patch.paymentMethodId ?? null,
      serviceEventId: patch.serviceEventId ?? null,
      lines: patch.lines,
      members: patch.members,
    });

    const nextCurrency = patch.currencyCode ?? detail.contribution.currencyCode;

    if (patch.batchId !== undefined) {
      if (patch.batchId !== null) {
        const batchCcy = await batchCurrency(tx, ctx.zoneId, patch.batchId);
        if (batchCcy && batchCcy !== nextCurrency) {
          throw new ContributionError(
            "batch_currency_mismatch",
            `Contribution currency (${nextCurrency}) does not match batch currency (${batchCcy}).`,
          );
        }
      }
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedByUserId: ctx.userId,
    };
    if (patch.memberId !== undefined) updates.memberId = patch.memberId;
    if (patch.batchId !== undefined) updates.batchId = patch.batchId;
    if (patch.paymentMethodId !== undefined) updates.paymentMethodId = patch.paymentMethodId;
    if (patch.serviceEventId !== undefined) updates.serviceEventId = patch.serviceEventId;
    if (patch.givingPeriodId !== undefined) updates.givingPeriodId = patch.givingPeriodId;
    if (patch.contributionDate !== undefined) updates.contributionDate = patch.contributionDate;
    if (patch.currencyCode !== undefined) updates.currencyCode = patch.currencyCode;
    if (patch.externalTransactionId !== undefined)
      updates.externalTransactionId = patch.externalTransactionId;
    if (patch.description !== undefined) updates.description = patch.description;

    if (patch.lines) {
      const computed = sumLines(patch.lines);
      if (patch.totalAmount !== undefined) {
        const supplied = new Decimal(patch.totalAmount);
        if (!supplied.equals(computed)) {
          throw new ContributionError(
            "total_mismatch",
            `totalAmount (${supplied.toFixed(MONEY_DP)}) must equal the sum of line amounts (${computed.toFixed(MONEY_DP)}).`,
          );
        }
      }
      updates.totalAmount = toMoneyString(computed);
    } else if (patch.totalAmount !== undefined) {
      // Updating totalAmount alone is a noop unless lines change; ignore to
      // keep the invariant total = sum(lines).
    }

    if (patch.contributionDate && patch.givingPeriodId === undefined) {
      const period = await deriveGivingPeriodForDate(tx, ctx.zoneId, patch.contributionDate);
      updates.givingPeriodId = period?.id ?? null;
    }

    await tx
      .update(contributions)
      .set(updates)
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, id)));

    if (patch.lines) {
      await tx
        .delete(contributionLines)
        .where(
          and(
            eq(contributionLines.zoneId, ctx.zoneId),
            eq(contributionLines.contributionId, id),
          ),
        );
      await tx.insert(contributionLines).values(
        patch.lines.map((l) => ({
          zoneId: ctx.zoneId,
          contributionId: id,
          givingTypeId: l.givingTypeId,
          accountId: l.accountId ?? null,
          amount: toMoneyString(new Decimal(l.amount)),
          currencyCode: nextCurrency,
          note: l.note ?? null,
        })),
      );
    }

    if (patch.members) {
      await tx
        .delete(contributionMembers)
        .where(
          and(
            eq(contributionMembers.zoneId, ctx.zoneId),
            eq(contributionMembers.contributionId, id),
          ),
        );
      if (patch.members.length > 0) {
        await tx.insert(contributionMembers).values(
          patch.members.map((m) => ({
            zoneId: ctx.zoneId,
            contributionId: id,
            memberId: m.memberId,
            allocationPercent: m.allocationPercent ?? null,
          })),
        );
      }
    }

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution.update",
      entityType: "contribution",
      entityId: id,
      before: {
        status: detail.contribution.status,
        totalAmount: detail.contribution.totalAmount,
      },
      after: { totalAmount: updates.totalAmount ?? detail.contribution.totalAmount },
    });

    const next = await loadDetail(tx, ctx.zoneId, id);
    if (!next) throw new ContributionError("not_found", "Contribution gone after update.");
    return next;
  });
}

/** Promote a draft contribution to posted. Trigger enforces immutability afterwards. */
export async function postContribution(
  database: Database,
  ctx: ActorContext,
  id: string,
): Promise<Contribution> {
  return database.transaction(async (tx) => {
    const detail = await loadDetail(tx, ctx.zoneId, id);
    if (!detail) {
      throw new ContributionError("not_found", "Contribution not in this zone.");
    }
    if (detail.contribution.status !== "draft") {
      throw new ContributionError("not_draft", "Only draft contributions can be posted.");
    }
    const now = new Date();
    const [posted] = await tx
      .update(contributions)
      .set({
        status: "posted",
        postedAt: now,
        postedByUserId: ctx.userId,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, id)))
      .returning();
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution.post",
      entityType: "contribution",
      entityId: id,
      before: { status: "draft" },
      after: { status: "posted", postedAt: now.toISOString() },
    });
    return posted;
  });
}

/** Void a posted contribution; populates `void_reason` and `voided_at`. */
export async function voidContribution(
  database: Database,
  ctx: ActorContext,
  id: string,
  args: { voidReason: string },
): Promise<Contribution> {
  return database.transaction(async (tx) => {
    const detail = await loadDetail(tx, ctx.zoneId, id);
    if (!detail) {
      throw new ContributionError("not_found", "Contribution not in this zone.");
    }
    if (detail.contribution.status !== "posted") {
      throw new ContributionError(
        "not_posted",
        `Only posted contributions can be voided (status='${detail.contribution.status}').`,
      );
    }
    const now = new Date();
    const [voided] = await tx
      .update(contributions)
      .set({
        status: "voided",
        voidedAt: now,
        voidedByUserId: ctx.userId,
        voidReason: args.voidReason,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, id)))
      .returning();
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution.void",
      entityType: "contribution",
      entityId: id,
      before: { status: "posted" },
      after: { status: "voided", voidReason: args.voidReason },
    });
    return voided;
  });
}

/**
 * Reverse a posted contribution. Inserts a corrective contribution with
 * negated line amounts (and total) and `reversal_of_contribution_id` set to
 * the original; flips the original to `status='reversed'`. Returns the new
 * contribution. The trigger blocks subsequent edits to the original.
 */
export async function reverseContribution(
  database: Database,
  ctx: ActorContext,
  id: string,
  args: { reason: string; contributionDate?: string },
): Promise<ContributionDetail> {
  return database.transaction(async (tx) => {
    const detail = await loadDetail(tx, ctx.zoneId, id);
    if (!detail) {
      throw new ContributionError("not_found", "Contribution not in this zone.");
    }
    const original = detail.contribution;
    if (original.status !== "posted") {
      throw new ContributionError(
        "not_posted",
        `Only posted contributions can be reversed (status='${original.status}').`,
      );
    }

    const now = new Date();
    const reversalDate = args.contributionDate ?? new Date().toISOString().slice(0, 10);
    const period = await deriveGivingPeriodForDate(tx, ctx.zoneId, reversalDate);
    const negatedTotal = new Decimal(original.totalAmount).negated();

    // Insert the reversal as a draft first so the lines/members triggers
    // accept the inserts, then promote it to posted in the same tx. The
    // contribution_lines_posted_guard refuses inserts onto a parent already
    // in status='posted' — going draft→posted on the parent is allowed.
    const [reversal] = await tx
      .insert(contributions)
      .values({
        zoneId: ctx.zoneId,
        regionId: original.regionId,
        batchId: null, // reversals are emitted standalone, never inside the original batch
        chapterId: original.chapterId,
        memberId: original.memberId,
        parentContributionId: original.id,
        sourceType: original.sourceType,
        paymentMethodId: original.paymentMethodId,
        serviceEventId: original.serviceEventId,
        givingPeriodId: period?.id ?? null,
        contributionDate: reversalDate,
        totalAmount: toMoneyString(negatedTotal),
        currencyCode: original.currencyCode,
        externalTransactionId: original.externalTransactionId,
        description: `Reversal of ${original.id}: ${args.reason}`,
        status: "draft",
        reversalOfContributionId: original.id,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();

    if (detail.lines.length > 0) {
      await tx.insert(contributionLines).values(
        detail.lines.map((l) => ({
          zoneId: ctx.zoneId,
          contributionId: reversal.id,
          givingTypeId: l.givingTypeId,
          accountId: l.accountId,
          amount: toMoneyString(new Decimal(l.amount).negated()),
          currencyCode: l.currencyCode,
          note: `Reversal of line ${l.id}`,
        })),
      );
    }

    if (detail.members.length > 0) {
      await tx.insert(contributionMembers).values(
        detail.members.map((m) => ({
          zoneId: ctx.zoneId,
          contributionId: reversal.id,
          memberId: m.memberId,
          allocationPercent: m.allocationPercent,
        })),
      );
    }

    // Promote the reversal to posted now that its lines exist.
    await tx
      .update(contributions)
      .set({
        status: "posted",
        postedAt: now,
        postedByUserId: ctx.userId,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, reversal.id)));

    await tx
      .update(contributions)
      .set({
        status: "reversed",
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, id)));

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution.reverse",
      entityType: "contribution",
      entityId: id,
      before: { status: "posted" },
      after: { status: "reversed", reversalId: reversal.id, reason: args.reason },
    });

    const detailNew = await loadDetail(tx, ctx.zoneId, reversal.id);
    if (!detailNew) throw new ContributionError("not_found", "Reversal disappeared.");
    return detailNew;
  });
}

/** Delete a draft contribution (cascades to lines/members). Forbidden once posted. */
export async function deleteDraftContribution(
  database: Database,
  ctx: ActorContext,
  id: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    const detail = await loadDetail(tx, ctx.zoneId, id);
    if (!detail) {
      throw new ContributionError("not_found", "Contribution not in this zone.");
    }
    if (detail.contribution.status !== "draft") {
      throw new ContributionError(
        "not_draft",
        `Only draft contributions can be deleted (status='${detail.contribution.status}').`,
      );
    }
    await tx
      .delete(contributions)
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, id)));
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "contribution.delete",
      entityType: "contribution",
      entityId: id,
      before: { status: "draft" },
    });
  });
}

export type { ContributionDetail };

// `ContributionMemberCreateInput` is referenced by external callers via the
// service signature; re-export to keep the contract self-contained.
export type { ContributionMemberCreateInput };
