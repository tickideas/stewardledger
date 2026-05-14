// packages/api/src/services/dashboards/chapter-dashboard.ts
// Phase 7 — chapter dashboard payload (REPORTS.md §2.14).
// One-shot aggregation for a single chapter: members, weekly /
// monthly / YTD giving (per currency), top giving types, top
// partners, pending batches, and the most recent contributions.
// RELEVANT FILES: packages/api/src/routes/tenant-dashboard.ts, packages/api/src/services/dashboards/zone-dashboard.ts, packages/api/src/services/dashboards/calendar.ts, packages/api/src/services/dashboards/ranking.ts

import Decimal from "decimal.js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  chapters,
  contributionBatches,
  contributionLines,
  contributions,
  givingTypes,
  members,
  zones,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import {
  monthBoundsInZone,
  weekBoundsInZone,
  yearBoundsInZone,
  type DateBounds,
} from "./calendar";
import { rankByCurrency } from "./ranking";
import type {
  CurrencyTotal,
  DashboardPartnershipProgress,
  DashboardPeriodTotals,
} from "./zone-dashboard";

export interface ChapterDashboardChapter {
  id: string;
  referenceCode: string;
  name: string;
}

export interface ChapterDashboardTopGivingType {
  id: string;
  name: string;
  shortCode: string | null;
  currencyCode: string;
  total: string;
}

export interface ChapterDashboardTopPartner {
  id: string;
  referenceCode: string;
  name: string;
  currencyCode: string;
  total: string;
}

export interface ChapterDashboardPendingBatches {
  count: number;
  perCurrency: CurrencyTotal[];
}

export interface ChapterDashboardRecentContribution {
  id: string;
  contributionDate: string;
  memberName: string | null;
  currencyCode: string;
  amount: string;
  sourceType: string;
}

export interface ChapterDashboardPayload {
  asOf: string;
  timeZone: string;
  chapter: ChapterDashboardChapter;
  members: { total: number; active: number; inactive: number };
  weeklyGiving: DashboardPeriodTotals;
  monthlyGiving: DashboardPeriodTotals;
  yearToDateGiving: DashboardPeriodTotals;
  pendingBatches: ChapterDashboardPendingBatches;
  topGivingTypes: ChapterDashboardTopGivingType[];
  topPartners: ChapterDashboardTopPartner[];
  recentContributions: ChapterDashboardRecentContribution[];
  partnershipProgress: DashboardPartnershipProgress;
}

const TOP_N = 5;
const RECENT_CONTRIBUTIONS_N = 5;

/**
 * Build the chapter dashboard payload. Caller-side scoping (zone vs
 * chapter-bound reader) is the route handler's job; this service
 * trusts the `(zoneId, chapterId)` pair it's given and returns a
 * 404-style sentinel via the chapter loader if either misses.
 *
 * Throws an error tagged `chapter_not_found` if the chapter doesn't
 * exist in the zone — the route translates that to a 404.
 */
export async function buildChapterDashboard(
  database: Database,
  zoneId: string,
  chapterId: string,
): Promise<ChapterDashboardPayload> {
  // Resolve chapter + zone TZ first; everything else needs both.
  const [chapter, timeZone] = await Promise.all([
    loadChapter(database, zoneId, chapterId),
    loadZoneTimeZone(database, zoneId),
  ]);
  const now = new Date();
  const week = weekBoundsInZone(now, timeZone);
  const month = monthBoundsInZone(now, timeZone);
  const year = yearBoundsInZone(now, timeZone);

  const [
    memberCounts,
    weekly,
    monthly,
    ytd,
    pendingBatches,
    topGivingTypesList,
    topPartnersList,
    recentContributionsList,
  ] = await Promise.all([
    countMembers(database, zoneId, chapterId),
    sumPostedByCurrency(database, zoneId, chapterId, week),
    sumPostedByCurrency(database, zoneId, chapterId, month),
    sumPostedByCurrency(database, zoneId, chapterId, year),
    fetchPendingBatches(database, zoneId, chapterId),
    fetchTopGivingTypes(database, zoneId, chapterId, month),
    fetchTopPartners(database, zoneId, chapterId, month),
    fetchRecentContributions(database, zoneId, chapterId),
  ]);

  return {
    asOf: now.toISOString(),
    timeZone,
    chapter,
    members: memberCounts,
    weeklyGiving: { periodStart: week.start, periodEnd: week.end, perCurrency: weekly },
    monthlyGiving: { periodStart: month.start, periodEnd: month.end, perCurrency: monthly },
    yearToDateGiving: { periodStart: year.start, periodEnd: year.end, perCurrency: ytd },
    pendingBatches,
    topGivingTypes: topGivingTypesList,
    topPartners: topPartnersList,
    recentContributions: recentContributionsList,
    partnershipProgress: {
      available: false,
      reason: "Pending Phase 8 financial targets.",
    },
  };
}

/** Tagged error so the route layer can map "chapter not in zone" → 404. */
export class ChapterDashboardError extends Error {
  constructor(
    readonly code: "chapter_not_found",
    message: string,
  ) {
    super(message);
  }
}

async function loadChapter(
  database: Database,
  zoneId: string,
  chapterId: string,
): Promise<ChapterDashboardChapter> {
  const [row] = await database
    .select({
      id: chapters.id,
      referenceCode: chapters.referenceCode,
      name: chapters.name,
    })
    .from(chapters)
    .where(
      and(
        eq(chapters.zoneId, zoneId),
        eq(chapters.id, chapterId),
        isNull(chapters.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ChapterDashboardError("chapter_not_found", `chapter ${chapterId} not found`);
  }
  return row;
}

async function loadZoneTimeZone(database: Database, zoneId: string): Promise<string> {
  const [row] = await database
    .select({ defaultTimeZone: zones.defaultTimeZone })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!row) {
    throw new Error(`zone ${zoneId} not found while loading dashboard`);
  }
  return row.defaultTimeZone;
}

async function countMembers(
  database: Database,
  zoneId: string,
  chapterId: string,
): Promise<{ total: number; active: number; inactive: number }> {
  const [row] = await database
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${members.isActive} = true)::int`,
    })
    .from(members)
    .where(
      and(
        eq(members.zoneId, zoneId),
        eq(members.chapterId, chapterId),
        isNull(members.deletedAt),
      ),
    );
  const total = row?.total ?? 0;
  const active = row?.active ?? 0;
  return { total, active, inactive: total - active };
}

async function sumPostedByCurrency(
  database: Database,
  zoneId: string,
  chapterId: string,
  bounds: DateBounds,
): Promise<CurrencyTotal[]> {
  // Same sign-convention as the zone dashboard: posted + reversed
  // lines, summed per currency. A fully-reversed pair nets to zero.
  const rows = await database
    .select({
      currencyCode: contributionLines.currencyCode,
      total: sql<string>`sum(${contributionLines.amount})::text`,
    })
    .from(contributionLines)
    .innerJoin(
      contributions,
      and(
        eq(contributionLines.zoneId, contributions.zoneId),
        eq(contributionLines.contributionId, contributions.id),
      ),
    )
    .where(
      and(
        eq(contributions.zoneId, zoneId),
        eq(contributions.chapterId, chapterId),
        sql`${contributions.contributionDate} >= ${bounds.start}::date`,
        sql`${contributions.contributionDate} < ${bounds.endExclusive}::date`,
        sql`${contributions.status} in ('posted', 'reversed')`,
      ),
    )
    .groupBy(contributionLines.currencyCode);
  return rows
    .map((r) => ({ currencyCode: r.currencyCode, total: new Decimal(r.total).toFixed(4) }))
    .filter((r) => !new Decimal(r.total).isZero())
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

async function fetchPendingBatches(
  database: Database,
  zoneId: string,
  chapterId: string,
): Promise<ChapterDashboardPendingBatches> {
  // Pending = anything pre-posting. Posted/voided are excluded; the
  // count is what a treasurer needs to clear before close-of-day.
  const rows = await database
    .select({
      currencyCode: contributionBatches.currencyCode,
      cashTotal: contributionBatches.cashTotal,
      chequeTotal: contributionBatches.chequeTotal,
    })
    .from(contributionBatches)
    .where(
      and(
        eq(contributionBatches.zoneId, zoneId),
        eq(contributionBatches.chapterId, chapterId),
        sql`${contributionBatches.status} in ('draft', 'submitted', 'approved')`,
      ),
    );

  const totals = new Map<string, Decimal>();
  for (const r of rows) {
    const cur = totals.get(r.currencyCode) ?? new Decimal(0);
    const cash = r.cashTotal ? new Decimal(r.cashTotal) : new Decimal(0);
    const cheque = r.chequeTotal ? new Decimal(r.chequeTotal) : new Decimal(0);
    totals.set(r.currencyCode, cur.plus(cash).plus(cheque));
  }
  const perCurrency: CurrencyTotal[] = Array.from(totals.entries())
    .filter(([, total]) => !total.isZero())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, total]) => ({ currencyCode, total: total.toFixed(4) }));
  return { count: rows.length, perCurrency };
}

async function fetchTopGivingTypes(
  database: Database,
  zoneId: string,
  chapterId: string,
  bounds: DateBounds,
): Promise<ChapterDashboardTopGivingType[]> {
  const rows = await database
    .select({
      id: givingTypes.id,
      name: givingTypes.name,
      shortCode: givingTypes.shortCode,
      currencyCode: contributionLines.currencyCode,
      total: sql<string>`sum(${contributionLines.amount})::text`,
    })
    .from(contributionLines)
    .innerJoin(
      contributions,
      and(
        eq(contributionLines.zoneId, contributions.zoneId),
        eq(contributionLines.contributionId, contributions.id),
      ),
    )
    .innerJoin(
      givingTypes,
      and(
        eq(givingTypes.zoneId, contributionLines.zoneId),
        eq(givingTypes.id, contributionLines.givingTypeId),
      ),
    )
    .where(
      and(
        eq(contributions.zoneId, zoneId),
        eq(contributions.chapterId, chapterId),
        sql`${contributions.contributionDate} >= ${bounds.start}::date`,
        sql`${contributions.contributionDate} < ${bounds.endExclusive}::date`,
        sql`${contributions.status} in ('posted', 'reversed')`,
      ),
    )
    .groupBy(
      givingTypes.id,
      givingTypes.name,
      givingTypes.shortCode,
      contributionLines.currencyCode,
    );
  return rankByCurrency<ChapterDashboardTopGivingType>(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      shortCode: r.shortCode,
      currencyCode: r.currencyCode,
      total: new Decimal(r.total).toFixed(4),
    })),
    TOP_N,
  );
}

async function fetchTopPartners(
  database: Database,
  zoneId: string,
  chapterId: string,
  bounds: DateBounds,
): Promise<ChapterDashboardTopPartner[]> {
  const rows = await database
    .select({
      memberId: members.id,
      referenceCode: members.referenceCode,
      fullName: members.fullName,
      firstName: members.firstName,
      lastName: members.lastName,
      currencyCode: contributionLines.currencyCode,
      total: sql<string>`sum(${contributionLines.amount})::text`,
    })
    .from(contributionLines)
    .innerJoin(
      contributions,
      and(
        eq(contributionLines.zoneId, contributions.zoneId),
        eq(contributionLines.contributionId, contributions.id),
      ),
    )
    .innerJoin(
      members,
      and(eq(members.zoneId, contributions.zoneId), eq(members.id, contributions.memberId)),
    )
    .where(
      and(
        eq(contributions.zoneId, zoneId),
        eq(contributions.chapterId, chapterId),
        isNull(members.deletedAt),
        sql`${contributions.contributionDate} >= ${bounds.start}::date`,
        sql`${contributions.contributionDate} < ${bounds.endExclusive}::date`,
        sql`${contributions.status} in ('posted', 'reversed')`,
        sql`${contributions.memberId} is not null`,
      ),
    )
    .groupBy(
      members.id,
      members.referenceCode,
      members.fullName,
      members.firstName,
      members.lastName,
      contributionLines.currencyCode,
    );
  return rankByCurrency<ChapterDashboardTopPartner>(
    rows.map((r) => ({
      id: r.memberId,
      referenceCode: r.referenceCode,
      name:
        r.fullName ??
        (r.firstName || r.lastName
          ? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()
          : r.referenceCode),
      currencyCode: r.currencyCode,
      total: new Decimal(r.total).toFixed(4),
    })),
    TOP_N,
  );
}

async function fetchRecentContributions(
  database: Database,
  zoneId: string,
  chapterId: string,
): Promise<ChapterDashboardRecentContribution[]> {
  // 5 most recent posted contributions, newest first. Reversal
  // contributions are excluded (they carry a non-null
  // `reversalOfContributionId`) because the dashboard reader wants
  // "what just came in" rather than the audit trail (the general-
  // ledger report surfaces reversals separately).
  const rows = await database
    .select({
      id: contributions.id,
      contributionDate: contributions.contributionDate,
      currencyCode: contributions.currencyCode,
      totalAmount: contributions.totalAmount,
      sourceType: contributions.sourceType,
      memberFullName: members.fullName,
      memberFirstName: members.firstName,
      memberLastName: members.lastName,
      memberReferenceCode: members.referenceCode,
    })
    .from(contributions)
    .leftJoin(
      members,
      and(eq(members.zoneId, contributions.zoneId), eq(members.id, contributions.memberId)),
    )
    .where(
      and(
        eq(contributions.zoneId, zoneId),
        eq(contributions.chapterId, chapterId),
        eq(contributions.status, "posted"),
        isNull(contributions.reversalOfContributionId),
      ),
    )
    .orderBy(desc(contributions.contributionDate), desc(contributions.id))
    .limit(RECENT_CONTRIBUTIONS_N);

  return rows.map((r) => ({
    id: r.id,
    contributionDate: r.contributionDate,
    memberName:
      r.memberFullName ??
      (r.memberFirstName || r.memberLastName
        ? `${r.memberFirstName ?? ""} ${r.memberLastName ?? ""}`.trim()
        : r.memberReferenceCode),
    currencyCode: r.currencyCode,
    amount: new Decimal(r.totalAmount).toFixed(4),
    sourceType: r.sourceType,
  }));
}
