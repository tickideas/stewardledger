// packages/api/src/services/dashboards/partnership-progress.ts
// Phase 8 dashboard helper that summarizes current ministry-year target progress.
// Keeps zone/chapter dashboard cards aligned with the partnership-progress report.
// RELEVANT FILES: packages/api/src/services/dashboards/zone-dashboard.ts, packages/api/src/services/dashboards/chapter-dashboard.ts, packages/api/src/services/reports/partnership-progress.ts, packages/db/src/schema/targets.ts

import Decimal from "decimal.js";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "@stewardledger/db";
import {
  contributionLines,
  contributions,
  financialTargets,
  givingTypes,
  ministryYears,
} from "@stewardledger/db/schema";
import { partsInZone } from "./calendar";

export interface DashboardPartnershipCurrencyProgress {
  currencyCode: string;
  target: string;
  achieved: string;
  percentProgress: string;
  targetCount: number;
}

export type DashboardPartnershipProgress =
  | {
      available: false;
      reason: string;
    }
  | {
      available: true;
      ministryYearId: string;
      ministryYearLabel: string;
      periodStart: string;
      periodEnd: string;
      scope: "zone" | "chapter";
      perCurrency: DashboardPartnershipCurrencyProgress[];
    };

const PERCENT_DISPLAY_CAP = new Decimal("999.9");

/**
 * Build the compact target-progress payload shown on the zone and
 * chapter dashboards. It intentionally summarizes by currency only:
 * the full row-level breakdown remains the responsibility of the
 * partnership-progress report and `/zone/partnership-progress`.
 *
 * Zone card rule: if any zone-wide targets exist for the current
 * ministry year, use those rows only; otherwise aggregate the
 * chapter-scoped target rows. This avoids double-counting when a
 * zone mixes high-level policy targets with chapter targets.
 *
 * Chapter card rule: use only that chapter's target rows. Zone-wide
 * targets remain visible in the dedicated zone report/dashboard.
 */
export async function buildPartnershipProgressSummary(
  database: Database,
  zoneId: string,
  options: { chapterId?: string; timeZone?: string; chapterScope?: string[] } = {},
): Promise<DashboardPartnershipProgress> {
  const year = await loadCurrentMinistryYear(database, zoneId, options.timeZone);
  if (!year) {
    return { available: false, reason: "No active ministry year is configured." };
  }

  const targetRows = options.chapterId
    ? await loadChapterTargets(database, zoneId, year.id, options.chapterId)
    : await loadZoneTargets(database, zoneId, year.id);

  if (targetRows.length === 0) {
    return {
      available: false,
      reason: options.chapterId
        ? "No chapter partnership targets are configured for the current ministry year."
        : "No partnership targets are configured for the current ministry year.",
    };
  }

  const givingTypeIds = Array.from(new Set(targetRows.map((row) => row.givingTypeId)));
  const achievedConditions = [
    eq(contributions.zoneId, zoneId),
    sql`${contributions.contributionDate} >= ${year.startDate}::date`,
    sql`${contributions.contributionDate} <= ${year.endDate}::date`,
    sql`${contributions.status} in ('posted', 'reversed')`,
    inArray(contributionLines.givingTypeId, givingTypeIds),
  ];
  if (options.chapterId) achievedConditions.push(eq(contributions.chapterId, options.chapterId));
  if (options.chapterScope)
    achievedConditions.push(inArray(contributions.chapterId, options.chapterScope));

  const achievedRows = await database
    .select({
      chapterId: contributions.chapterId,
      givingTypeId: contributionLines.givingTypeId,
      currencyCode: contributionLines.currencyCode,
      amount: sql<string>`sum(${contributionLines.amount})::text`,
    })
    .from(contributionLines)
    .innerJoin(
      contributions,
      and(
        eq(contributionLines.zoneId, contributions.zoneId),
        eq(contributionLines.contributionId, contributions.id),
      ),
    )
    .where(and(...achievedConditions))
    .groupBy(
      contributions.chapterId,
      contributionLines.givingTypeId,
      contributionLines.currencyCode,
    );

  const achievedByChapterTypeCurrency = new Map<string, Decimal>();
  const achievedByTypeCurrency = new Map<string, Decimal>();
  for (const row of achievedRows) {
    if (!row.chapterId || !row.givingTypeId) continue;
    const amount = new Decimal(row.amount);
    achievedByChapterTypeCurrency.set(
      `${row.chapterId}|${row.givingTypeId}|${row.currencyCode}`,
      amount,
    );
    const zoneKey = `${row.givingTypeId}|${row.currencyCode}`;
    achievedByTypeCurrency.set(
      zoneKey,
      (achievedByTypeCurrency.get(zoneKey) ?? new Decimal(0)).plus(amount),
    );
  }

  const perCurrency = new Map<
    string,
    { target: Decimal; achieved: Decimal; targetCount: number }
  >();
  for (const target of targetRows) {
    const bucket = perCurrency.get(target.currencyCode) ?? {
      target: new Decimal(0),
      achieved: new Decimal(0),
      targetCount: 0,
    };
    bucket.target = bucket.target.plus(new Decimal(target.fullTarget));
    bucket.achieved = bucket.achieved.plus(
      target.chapterId
        ? achievedByChapterTypeCurrency.get(
            `${target.chapterId}|${target.givingTypeId}|${target.currencyCode}`,
          ) ?? new Decimal(0)
        : achievedByTypeCurrency.get(`${target.givingTypeId}|${target.currencyCode}`) ??
            new Decimal(0),
    );
    bucket.targetCount += 1;
    perCurrency.set(target.currencyCode, bucket);
  }

  return {
    available: true,
    ministryYearId: year.id,
    ministryYearLabel: year.yearLabel,
    periodStart: year.startDate,
    periodEnd: year.endDate,
    scope: options.chapterId ? "chapter" : "zone",
    perCurrency: Array.from(perCurrency.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, bucket]) => {
        const percent = bucket.target.isZero()
          ? new Decimal(0)
          : bucket.achieved.dividedBy(bucket.target).times(100);
        const capped = percent.greaterThan(PERCENT_DISPLAY_CAP)
          ? PERCENT_DISPLAY_CAP
          : percent;
        return {
          currencyCode,
          target: bucket.target.toFixed(4),
          achieved: bucket.achieved.toFixed(4),
          percentProgress: capped.toFixed(1),
          targetCount: bucket.targetCount,
        };
      }),
  };
}

async function loadCurrentMinistryYear(
  database: Database,
  zoneId: string,
  timeZone = "UTC",
) {
  const now = new Date();
  const local = partsInZone(now, timeZone);
  const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const [active] = await database
    .select({
      id: ministryYears.id,
      yearLabel: ministryYears.yearLabel,
      startDate: ministryYears.startDate,
      endDate: ministryYears.endDate,
    })
    .from(ministryYears)
    .where(
      and(
        eq(ministryYears.zoneId, zoneId),
        sql`${ministryYears.startDate} <= ${today}::date`,
        sql`${ministryYears.endDate} >= ${today}::date`,
      ),
    )
    .orderBy(sql`${ministryYears.startDate} desc`)
    .limit(1);
  return active ?? null;
}

type TargetRow = {
  chapterId: string | null;
  givingTypeId: string;
  currencyCode: string;
  fullTarget: string;
};

function targetTupleKey(target: TargetRow): string {
  return `${target.givingTypeId}|${target.currencyCode}`;
}

async function loadZoneTargets(
  database: Database,
  zoneId: string,
  ministryYearId: string,
): Promise<TargetRow[]> {
  const targetRows = await selectTargets(database, [
    eq(financialTargets.zoneId, zoneId),
    eq(financialTargets.ministryYearId, ministryYearId),
    eq(givingTypes.hasPartnershipTarget, true),
  ]);
  const zoneWideKeys = new Set(
    targetRows
      .filter((target) => target.chapterId === null)
      .map(targetTupleKey),
  );
  if (zoneWideKeys.size === 0) return targetRows;
  return targetRows.filter(
    (target) => target.chapterId === null || !zoneWideKeys.has(targetTupleKey(target)),
  );
}

async function loadChapterTargets(
  database: Database,
  zoneId: string,
  ministryYearId: string,
  chapterId: string,
): Promise<TargetRow[]> {
  return selectTargets(database, [
    eq(financialTargets.zoneId, zoneId),
    eq(financialTargets.ministryYearId, ministryYearId),
    eq(financialTargets.chapterId, chapterId),
    eq(givingTypes.hasPartnershipTarget, true),
  ]);
}

async function selectTargets(
  database: Database,
  conditions: SQL[],
): Promise<TargetRow[]> {
  return database
    .select({
      chapterId: financialTargets.chapterId,
      givingTypeId: financialTargets.givingTypeId,
      currencyCode: financialTargets.currencyCode,
      fullTarget: financialTargets.fullTarget,
    })
    .from(financialTargets)
    .innerJoin(
      givingTypes,
      and(
        eq(givingTypes.zoneId, financialTargets.zoneId),
        eq(givingTypes.id, financialTargets.givingTypeId),
      ),
    )
    .where(and(...conditions));
}
