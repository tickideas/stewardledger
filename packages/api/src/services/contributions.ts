// packages/api/src/services/contributions.ts
// Phase 5 — contribution write paths. All financial mutations live here so
// the route layer is a thin adapter and the cross-tenant + sign-convention
// invariants are enforced in one place.
//
// Sign convention (see DOMAIN-MODEL.md §6 and AGENTS hard rule #1):
//   • positive amounts are inflows (gifts);
//   • negative amounts are reversals.
// Only `reverseContribution` is allowed to emit negative amounts; the
// public create/update paths reject non-positive line amounts so a
// privileged caller cannot manufacture a posted negative contribution
// outside the reversal flow. `reverseContribution` itself constructs the
// reversal lines by negating the original's, so |reversal| == |original|
// holds by construction.

import Decimal from "decimal.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
import { writeAudit, writeAuditMany } from "./audit";
import { deriveGivingPeriodForDate } from "./period-seed";
import { assertAllExistInZone } from "./_zone-scope";

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

/**
 * Reject non-positive line amounts on non-reversal write paths. The DB
 * dropped its `amount >= 0` CHECKs to allow reversal lines; the service
 * is now responsible for confining negative amounts to `reverseContribution`.
 */
function assertLinesPositive(lines: ContributionLineCreateInput[]): void {
  for (const l of lines) {
    const d = new Decimal(l.amount);
    if (!d.isFinite() || d.lte(0)) {
      throw new ContributionError(
        "non_positive_amount",
        `Line amount must be positive (got ${l.amount}). Use the reverse endpoint to emit corrective entries.`,
      );
    }
  }
}

async function loadZoneDefaults(
  database: Db,
  zoneId: string,
): Promise<{ defaultCurrencyCode: string; defaultTimeZone: string }> {
  const [zone] = await database
    .select({
      defaultCurrencyCode: zones.defaultCurrencyCode,
      defaultTimeZone: zones.defaultTimeZone,
    })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!zone) {
    throw new ContributionError("zone_default_currency_missing", "Zone is missing.");
  }
  return zone;
}

async function chapterRegionId(
  database: Db,
  zoneId: string,
  chapterId: string,
): Promise<string | null> {
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

/**
 * Bulk-resolve every zone-scoped FK on a contribution write in one
 * round-trip per table (5 tables, regardless of line/member count).
 *
 * `chapterIdMustMatch`, when supplied, is the contribution's own chapter:
 *   • the referenced batch's `chapter_id` must equal it (single-chapter
 *     batches);
 *   • a referenced service event's `chapter_id`, if not null, must equal
 *     it (service events are zone-wide-or-chapter-scoped).
 */
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
  opts: { chapterIdMustMatch?: string | null } = {},
): Promise<void> {
  // Collect distinct ids per table, then run one query per table. The
  // five table-checks are independent so they go in `Promise.all`.
  const memberIds = new Set<string>();
  if (input.memberId) memberIds.add(input.memberId);
  for (const m of input.members ?? []) memberIds.add(m.memberId);

  const givingTypeIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const line of input.lines ?? []) {
    givingTypeIds.add(line.givingTypeId);
    if (line.accountId) accountIds.add(line.accountId);
  }

  await Promise.all([
    input.chapterId
      ? assertAllExistInZone(database, chapters, zoneId, [input.chapterId], () =>
          new ContributionError("chapter_not_found", "Chapter not in this zone."),
        )
      : Promise.resolve(),
    assertAllExistInZone(database, members, zoneId, [...memberIds], () =>
      new ContributionError("member_not_found", "Member not in this zone."),
    ),
    input.paymentMethodId
      ? assertAllExistInZone(
          database,
          paymentMethods,
          zoneId,
          [input.paymentMethodId],
          () => new ContributionError("payment_method_not_found", "Payment method not in this zone."),
        )
      : Promise.resolve(),
    assertAllExistInZone(database, givingTypes, zoneId, [...givingTypeIds], () =>
      new ContributionError("giving_type_not_found", "Giving type not in this zone."),
    ),
    assertAllExistInZone(database, accounts, zoneId, [...accountIds], () =>
      new ContributionError("account_not_found", "Account not in this zone."),
    ),
  ]);

  // batchId and serviceEventId need their own row to verify chapter match,
  // so we resolve them with a richer SELECT instead of an existence diff.
  if (input.batchId) {
    const [batch] = await database
      .select({ id: contributionBatches.id, chapterId: contributionBatches.chapterId })
      .from(contributionBatches)
      .where(
        and(
          eq(contributionBatches.zoneId, zoneId),
          eq(contributionBatches.id, input.batchId),
        ),
      )
      .limit(1);
    if (!batch) {
      throw new ContributionError("batch_not_found", "Batch not in this zone.");
    }
    if (
      opts.chapterIdMustMatch !== undefined &&
      opts.chapterIdMustMatch !== null &&
      batch.chapterId !== opts.chapterIdMustMatch
    ) {
      throw new ContributionError(
        "batch_chapter_mismatch",
        "Batch belongs to a different chapter than the contribution.",
      );
    }
  }
  if (input.serviceEventId) {
    const [evt] = await database
      .select({ id: serviceEvents.id, chapterId: serviceEvents.chapterId })
      .from(serviceEvents)
      .where(
        and(eq(serviceEvents.zoneId, zoneId), eq(serviceEvents.id, input.serviceEventId)),
      )
      .limit(1);
    if (!evt) {
      throw new ContributionError("service_event_not_found", "Service event not in this zone.");
    }
    if (
      opts.chapterIdMustMatch !== undefined &&
      opts.chapterIdMustMatch !== null &&
      evt.chapterId !== null &&
      evt.chapterId !== opts.chapterIdMustMatch
    ) {
      throw new ContributionError(
        "service_event_chapter_mismatch",
        "Service event belongs to a different chapter than the contribution.",
      );
    }
  }
}

async function batchCurrency(
  database: Db,
  zoneId: string,
  batchId: string,
): Promise<string | null> {
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
  const [lines, memberRows] = await Promise.all([
    database
      .select()
      .from(contributionLines)
      .where(
        and(eq(contributionLines.zoneId, zoneId), eq(contributionLines.contributionId, id)),
      ),
    database
      .select({
        id: contributionMembers.id,
        memberId: contributionMembers.memberId,
        allocationPercent: contributionMembers.allocationPercent,
      })
      .from(contributionMembers)
      .where(
        and(
          eq(contributionMembers.zoneId, zoneId),
          eq(contributionMembers.contributionId, id),
        ),
      ),
  ]);
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
  // Sign-convention: only `reverseContribution` may emit non-positive
  // amounts. Reject early so the bulk reference resolution below isn't
  // even attempted on a malformed payload.
  assertLinesPositive(input.lines);

  return database.transaction(async (tx) => {
    const currency =
      input.currencyCode ?? (await loadZoneDefaults(tx, ctx.zoneId)).defaultCurrencyCode;

    await assertReferencesInZone(
      tx,
      ctx.zoneId,
      {
        chapterId: input.chapterId,
        memberId: input.memberId,
        batchId: input.batchId,
        paymentMethodId: input.paymentMethodId,
        serviceEventId: input.serviceEventId,
        lines: input.lines,
        members: input.members,
      },
      { chapterIdMustMatch: input.chapterId },
    );

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

// ─── updateDraftContribution helpers ────────────────────────────────

// Allow-list of writable columns. Adding a column to
// `contributionUpdateSchema` without listing it here is a deliberate "you
// must opt this in" gesture; the alternative — a blind `Object.entries`
// copy — silently widens the SQL update surface every time the schema
// grows.
const UPDATE_DIRECT_COLUMNS = [
  "memberId",
  "batchId",
  "paymentMethodId",
  "serviceEventId",
  "givingPeriodId",
  "contributionDate",
  "currencyCode",
  "externalTransactionId",
  "description",
] as const;
type UpdateDirectColumn = (typeof UPDATE_DIRECT_COLUMNS)[number];

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
  // Sign convention: any new lines on the update path must be positive
  // for the same reasons as `createContribution` above.
  if (patch.lines) assertLinesPositive(patch.lines);

  return database.transaction(async (tx) => {
    const detail = await loadDetail(tx, ctx.zoneId, id);
    if (!detail) {
      throw new ContributionError("not_found", "Contribution not in this zone.");
    }
    if (detail.contribution.status !== "draft") {
      throw new ContributionError("not_draft", "Only draft contributions can be edited.");
    }

    await assertReferencesInZone(
      tx,
      ctx.zoneId,
      {
        memberId: patch.memberId ?? null,
        batchId: patch.batchId ?? null,
        paymentMethodId: patch.paymentMethodId ?? null,
        serviceEventId: patch.serviceEventId ?? null,
        lines: patch.lines,
        members: patch.members,
      },
      { chapterIdMustMatch: detail.contribution.chapterId },
    );

    const nextCurrency = patch.currencyCode ?? detail.contribution.currencyCode;

    // Re-check batch currency cohesion whenever EITHER the batch link OR
    // the contribution currency is changing. Previously the check only
    // fired on `batchId` changes, allowing currency-only patches to drift.
    const nextBatchId =
      patch.batchId !== undefined ? patch.batchId : detail.contribution.batchId;
    const batchPatchTouches =
      patch.batchId !== undefined || patch.currencyCode !== undefined;
    if (batchPatchTouches && nextBatchId) {
      const batchCcy = await batchCurrency(tx, ctx.zoneId, nextBatchId);
      if (batchCcy && batchCcy !== nextCurrency) {
        throw new ContributionError(
          "batch_currency_mismatch",
          `Contribution currency (${nextCurrency}) does not match batch currency (${batchCcy}).`,
        );
      }
    }

    if (patch.totalAmount !== undefined && !patch.lines) {
      throw new ContributionError(
        "total_without_lines",
        "totalAmount cannot be changed without supplying the new lines it summarises.",
      );
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedByUserId: ctx.userId,
    };
    for (const k of UPDATE_DIRECT_COLUMNS) {
      const v = (patch as Partial<Record<UpdateDirectColumn, unknown>>)[k];
      if (v !== undefined) updates[k] = v;
    }

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
    }

    if (patch.contributionDate && patch.givingPeriodId === undefined) {
      const period = await deriveGivingPeriodForDate(tx, ctx.zoneId, patch.contributionDate);
      updates.givingPeriodId = period?.id ?? null;
    }

    const [updated] = await tx
      .update(contributions)
      .set(updates)
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, id)))
      .returning();

    let nextLines = detail.lines;
    if (patch.lines) {
      await tx
        .delete(contributionLines)
        .where(
          and(
            eq(contributionLines.zoneId, ctx.zoneId),
            eq(contributionLines.contributionId, id),
          ),
        );
      nextLines = await tx
        .insert(contributionLines)
        .values(
          patch.lines.map((l) => ({
            zoneId: ctx.zoneId,
            contributionId: id,
            givingTypeId: l.givingTypeId,
            accountId: l.accountId ?? null,
            amount: toMoneyString(new Decimal(l.amount)),
            currencyCode: nextCurrency,
            note: l.note ?? null,
          })),
        )
        .returning();
    }

    let nextMembers = detail.members;
    if (patch.members) {
      await tx
        .delete(contributionMembers)
        .where(
          and(
            eq(contributionMembers.zoneId, ctx.zoneId),
            eq(contributionMembers.contributionId, id),
          ),
        );
      nextMembers =
        patch.members.length > 0
          ? await tx
              .insert(contributionMembers)
              .values(
                patch.members.map((m) => ({
                  zoneId: ctx.zoneId,
                  contributionId: id,
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
      after: { totalAmount: updated.totalAmount },
    });

    return { contribution: updated, lines: nextLines, members: nextMembers };
  });
}

/**
 * Promote a draft contribution to posted. Two parallel callers cannot
 * both succeed: the conditional UPDATE filters `status='draft'`, so
 * the loser's UPDATE affects zero rows and we re-classify the failure
 * as `not_draft` (or `not_found`) by reading the row's current state.
 * Without the conditional UPDATE both txs would race past the
 * pre-flight status check under READ COMMITTED — the trigger would
 * catch the second writer but the error would be a raw Postgres
 * exception instead of a typed `ContributionError`.
 *
 * The trigger `contributions_posted_guard` still enforces immutability
 * for downstream edits; the conditional UPDATE is the service-layer
 * mirror of that invariant on the draft→posted boundary.
 */
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
      .where(
        and(
          eq(contributions.zoneId, ctx.zoneId),
          eq(contributions.id, id),
          eq(contributions.status, "draft"),
        ),
      )
      .returning();
    if (!posted) {
      // A parallel caller raced ahead and posted first. The row exists
      // (loadDetail saw it) so the only reason an UPDATE affected zero
      // rows is the status changed under us. Surface the same typed
      // error a serial caller would have seen.
      throw new ContributionError(
        "not_draft",
        "Only draft contributions can be posted.",
      );
    }
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
 * Compute today's calendar date in a zone's IANA time zone. Used to
 * default the reversal date so reversals don't drift into the wrong day
 * for non-UTC zones.
 */
function todayInZone(timeZone: string): string {
  // en-CA gives us YYYY-MM-DD natively; the formatter respects timeZone.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Reverse a posted contribution. Inserts a corrective contribution with
 * negated line amounts (and total) and `reversal_of_contribution_id` set
 * to the original; flips the original to `status='reversed'`. Returns
 * the new contribution. The trigger blocks subsequent edits to the
 * original.
 *
 * Implementation note: the reversal is inserted with `status='draft'`
 * first because `contribution_lines_posted_guard` blocks line inserts on
 * a parent already in `status='posted'`; once lines + members are in we
 * promote the parent to `posted` in the same tx. The original is flipped
 * to `reversed` last so an audit reader sees the cause-then-effect order.
 *
 * Reversals deliberately bypass `assertReferencesInZone` for the copied
 * `accountId` / `paymentMethodId` / `serviceEventId`: the original was
 * valid when posted, and a deactivated lookup row should never block a
 * correction. Audit captures actor + reason for every reversal.
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
    const zone = await loadZoneDefaults(tx, ctx.zoneId);
    const reversalDate = args.contributionDate ?? todayInZone(zone.defaultTimeZone);
    const period = await deriveGivingPeriodForDate(tx, ctx.zoneId, reversalDate);
    const negatedTotal = new Decimal(original.totalAmount).negated();

    const [reversal] = await tx
      .insert(contributions)
      .values({
        zoneId: ctx.zoneId,
        regionId: original.regionId,
        batchId: null, // reversals are emitted standalone, never inside the original batch
        chapterId: original.chapterId,
        memberId: original.memberId,
        // `parent_contribution_id` records the lineage of any
        // contribution-derived-from-another (in v1 only reversals); the
        // canonical reversal-of-contribution link lives on
        // `reversal_of_contribution_id` and the reports / RLS layers key
        // off that. Keep the `parent_*` link populated as well so a
        // future "show me everything that ever attached to X" query on
        // either column is correct.
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

    const reversalLines: ContributionLine[] = detail.lines.length
      ? await tx
          .insert(contributionLines)
          .values(
            detail.lines.map((l) => ({
              zoneId: ctx.zoneId,
              contributionId: reversal.id,
              givingTypeId: l.givingTypeId,
              accountId: l.accountId,
              amount: toMoneyString(new Decimal(l.amount).negated()),
              currencyCode: l.currencyCode,
              note: `Reversal of line ${l.id}`,
            })),
          )
          .returning()
      : [];

    const reversalMembers = detail.members.length
      ? await tx
          .insert(contributionMembers)
          .values(
            detail.members.map((m) => ({
              zoneId: ctx.zoneId,
              contributionId: reversal.id,
              memberId: m.memberId,
              allocationPercent: m.allocationPercent,
            })),
          )
          .returning({
            id: contributionMembers.id,
            memberId: contributionMembers.memberId,
            allocationPercent: contributionMembers.allocationPercent,
          })
      : [];

    // Promote the reversal to posted now that its lines exist.
    const [postedReversal] = await tx
      .update(contributions)
      .set({
        status: "posted",
        postedAt: now,
        postedByUserId: ctx.userId,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, reversal.id)))
      .returning();

    await tx
      .update(contributions)
      .set({
        status: "reversed",
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(and(eq(contributions.zoneId, ctx.zoneId), eq(contributions.id, id)));

    // Capture the entire causal chain in audit: cause on the original, a
    // self-contained create+post pair on the reversal row.
    await writeAuditMany(tx, [
      {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "contribution.reverse",
        entityType: "contribution",
        entityId: id,
        before: { status: "posted" },
        after: { status: "reversed", reversalId: reversal.id, reason: args.reason },
      },
      {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "contribution.create",
        entityType: "contribution",
        entityId: reversal.id,
        after: {
          status: "draft",
          reversalOfContributionId: id,
          totalAmount: postedReversal.totalAmount,
          currencyCode: postedReversal.currencyCode,
          lineCount: reversalLines.length,
        },
      },
      {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "contribution.post",
        entityType: "contribution",
        entityId: reversal.id,
        before: { status: "draft" },
        after: { status: "posted", postedAt: now.toISOString() },
      },
    ]);

    return {
      contribution: postedReversal,
      lines: reversalLines,
      members: reversalMembers,
    };
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

export type { ContributionDetail, ContributionMemberCreateInput };

// `errorStatusFor` is colocated with `ContributionError` so the route
// layer doesn't need to keep a parallel HTTP-status table that drifts
// every time a new error code is added. Routes import it via
// `tenant-contributions.ts`.
export const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  chapter_not_found: 404,
  member_not_found: 404,
  batch_not_found: 404,
  payment_method_not_found: 404,
  service_event_not_found: 404,
  giving_type_not_found: 404,
  account_not_found: 404,
  zone_default_currency_missing: 500,
  not_draft: 409,
  not_posted: 409,
  invalid_transition: 409,
  batch_not_writable: 409,
  batch_currency_mismatch: 409,
  batch_chapter_mismatch: 409,
  service_event_chapter_mismatch: 409,
  total_mismatch: 422,
  total_without_lines: 422,
  lines_required: 422,
  non_positive_amount: 422,
};

export function errorStatusFor(code: string): number {
  return ERROR_STATUS[code] ?? 400;
}
