// packages/api/src/services/dashboards/zone-dashboard.ts
// Phase 7 — zone dashboard payload (REPORTS.md §2.15).
// Aggregates zone-wide stats (chapters, members, current-month and YTD
// giving, top-5 chapters / partners, recent imports) into one payload
// for the /zone/dashboard landing surface.
// RELEVANT FILES: packages/api/src/routes/tenant-dashboard.ts, packages/api/src/services/dashboards/calendar.ts, packages/api/src/services/dashboards/queries.ts, packages/api/src/services/dashboards/ranking.ts

import Decimal from "decimal.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  chapters,
  contributionLines,
  contributions,
  importFiles,
  importJobs,
  importRows,
  IMPORT_JOB_STATUSES,
  members,
  type ImportJobStatus,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import type { AuthorizedContext } from "@stewardledger/shared";
import { monthBoundsInZone, yearBoundsInZone, type DateBounds } from "./calendar";
import {
  countMembers,
  loadZoneTimeZone,
  sumPostedByCurrency,
} from "./queries";
import { rankByCurrency } from "./ranking";
import { buildPartnershipProgressSummary, type DashboardPartnershipProgress } from "./partnership-progress";

const IMPORT_JOB_STATUS_SET = new Set<string>(IMPORT_JOB_STATUSES);

/**
 * Defensive validator: every value we send to the dashboard must be
 * on the canonical list. The SQL check constraint guarantees it at
 * insert time, but a future schema change that adds a status without
 * updating `IMPORT_JOB_STATUSES` would let an unknown string slip
 * through this service. Throwing here surfaces the drift loudly
 * rather than smuggling a wide `string` past the typed payload.
 */
function toImportJobStatus(raw: string): ImportJobStatus {
  if (!IMPORT_JOB_STATUS_SET.has(raw)) {
    throw new Error(`unexpected import_jobs.status value: ${raw}`);
  }
  return raw as ImportJobStatus;
}

export type { ImportJobStatus };

export interface CurrencyTotal {
  currencyCode: string;
  total: string; // numeric(19,4)
}

export interface DashboardPeriodTotals {
  periodStart: string; // ISO date
  periodEnd: string; // ISO date
  perCurrency: CurrencyTotal[];
}

export interface DashboardTopChapter {
  id: string;
  referenceCode: string;
  name: string;
  currencyCode: string;
  total: string;
}

export interface DashboardTopPartner {
  id: string;
  referenceCode: string;
  name: string;
  chapterReferenceCode: string | null;
  currencyCode: string;
  total: string;
}

export interface DashboardRecentImport {
  id: string;
  fileName: string;
  status: ImportJobStatus;
  createdAt: string; // ISO datetime
  postedCount: number;
  perCurrency: CurrencyTotal[];
}

export interface ZoneDashboardPayload {
  asOf: string; // ISO datetime
  timeZone: string;
  chapters: { total: number; active: number };
  members: { total: number; active: number; inactive: number };
  monthlyGiving: DashboardPeriodTotals;
  yearToDateGiving: DashboardPeriodTotals;
  topChapters: DashboardTopChapter[];
  topPartners: DashboardTopPartner[];
  recentImports: DashboardRecentImport[];
  partnershipProgress: DashboardPartnershipProgress;
}

const TOP_N = 5;
const RECENT_IMPORTS_N = 5;

/**
 * Build the zone dashboard payload. The caller must be a zone-wide
 * reader; the route handler does the gate. Money is always grouped by
 * currency — DOMAIN-MODEL §6 forbids silent FX conversion. Calendar
 * windows ("this month", "year to date") are evaluated in the zone's
 * `default_time_zone` so a tenant 12h off UTC sees their own civil
 * month rather than UTC's.
 */
export async function buildZoneDashboard(
  database: Database,
  ctx: AuthorizedContext,
  options: { chapterScope?: string[] } = {},
): Promise<ZoneDashboardPayload> {
  const chapterScope = options.chapterScope;
  // Resolve the zone's timezone first. Every subsequent query / bound
  // computation depends on it, so doing this one round-trip ahead of
  // the parallel fan-out is the right cost.
  const timeZone = await loadZoneTimeZone(database, ctx.zoneId);
  const now = new Date();
  const month = monthBoundsInZone(now, timeZone);
  const year = yearBoundsInZone(now, timeZone);

  // Six remaining aggregates are independent and zone-scoped; run
  // them in parallel so the worst-case latency is a single round-trip
  // across the pool rather than a sequential chain.
  //
  // NOTE on top-chapters / top-partners: ranking and N-truncation
  // happen in app code via `rankByCurrency`, not in SQL. Both surfaces
  // are bounded by chapter/member counts (typically <10k rows) and
  // the existing `top-chapters.ts` / `top-partners.ts` reports use
  // the same pattern. Pushing into a SQL window function would be
  // worth doing once but as a single sweep across all four call
  // sites — tracked as a follow-up rather than in this PR.
  const [
    chapterCounts,
    memberCounts,
    monthlyPerCurrency,
    ytdPerCurrency,
    topChaptersList,
    topPartnersList,
    recentImportsList,
    partnershipProgress,
  ] = await Promise.all([
    countChapters(database, ctx.zoneId, chapterScope),
    countMembers(database, ctx.zoneId, { chapterIds: chapterScope }),
    sumPostedByCurrency(database, ctx.zoneId, month, { chapterIds: chapterScope }),
    sumPostedByCurrency(database, ctx.zoneId, year, { chapterIds: chapterScope }),
    fetchTopChapters(database, ctx.zoneId, month, chapterScope),
    fetchTopPartners(database, ctx.zoneId, month, chapterScope),
    fetchRecentImports(database, ctx.zoneId, chapterScope),
    buildPartnershipProgressSummary(database, ctx.zoneId, { timeZone, chapterScope }),
  ]);

  return {
    asOf: now.toISOString(),
    timeZone,
    chapters: chapterCounts,
    members: memberCounts,
    monthlyGiving: {
      periodStart: month.start,
      periodEnd: month.end,
      perCurrency: monthlyPerCurrency,
    },
    yearToDateGiving: {
      periodStart: year.start,
      periodEnd: year.end,
      perCurrency: ytdPerCurrency,
    },
    topChapters: topChaptersList,
    topPartners: topPartnersList,
    recentImports: recentImportsList,
    partnershipProgress,
  };
}

async function countChapters(
  database: Database,
  zoneId: string,
  chapterScope: string[] | undefined,
): Promise<{ total: number; active: number }> {
  const conditions = [eq(chapters.zoneId, zoneId)];
  if (chapterScope) conditions.push(inArray(chapters.id, chapterScope));
  const [row] = await database
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${chapters.deletedAt} is null)::int`,
    })
    .from(chapters)
    .where(and(...conditions));
  return { total: row?.total ?? 0, active: row?.active ?? 0 };
}

async function fetchTopChapters(
  database: Database,
  zoneId: string,
  bounds: DateBounds,
  chapterScope: string[] | undefined,
): Promise<DashboardTopChapter[]> {
  const rows = await database
    .select({
      id: chapters.id,
      referenceCode: chapters.referenceCode,
      name: chapters.name,
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
      chapters,
      and(eq(chapters.zoneId, contributions.zoneId), eq(chapters.id, contributions.chapterId)),
    )
    .where(
      and(
        eq(contributions.zoneId, zoneId),
        sql`${contributions.contributionDate} >= ${bounds.start}::date`,
        sql`${contributions.contributionDate} < ${bounds.endExclusive}::date`,
        sql`${contributions.status} in ('posted', 'reversed')`,
        ...(chapterScope ? [inArray(contributions.chapterId, chapterScope)] : []),
      ),
    )
    .groupBy(chapters.id, chapters.referenceCode, chapters.name, contributionLines.currencyCode);
  return rankByCurrency<DashboardTopChapter>(
    rows.map((r) => ({
      id: r.id,
      referenceCode: r.referenceCode,
      name: r.name,
      currencyCode: r.currencyCode,
      total: new Decimal(r.total).toFixed(4),
    })),
    TOP_N,
  );
}

async function fetchTopPartners(
  database: Database,
  zoneId: string,
  bounds: DateBounds,
  chapterScope: string[] | undefined,
): Promise<DashboardTopPartner[]> {
  const rows = await database
    .select({
      memberId: members.id,
      referenceCode: members.referenceCode,
      fullName: members.fullName,
      firstName: members.firstName,
      lastName: members.lastName,
      chapterReferenceCode: chapters.referenceCode,
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
    .leftJoin(
      chapters,
      and(eq(chapters.zoneId, contributions.zoneId), eq(chapters.id, contributions.chapterId)),
    )
    .where(
      and(
        eq(contributions.zoneId, zoneId),
        isNull(members.deletedAt),
        sql`${contributions.contributionDate} >= ${bounds.start}::date`,
        sql`${contributions.contributionDate} < ${bounds.endExclusive}::date`,
        sql`${contributions.status} in ('posted', 'reversed')`,
        sql`${contributions.memberId} is not null`,
        ...(chapterScope ? [inArray(contributions.chapterId, chapterScope)] : []),
      ),
    )
    .groupBy(
      members.id,
      members.referenceCode,
      members.fullName,
      members.firstName,
      members.lastName,
      chapters.referenceCode,
      contributionLines.currencyCode,
    );
  return rankByCurrency<DashboardTopPartner>(
    rows.map((r) => ({
      id: r.memberId,
      referenceCode: r.referenceCode,
      name:
        r.fullName ??
        (r.firstName || r.lastName
          ? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()
          : r.referenceCode),
      chapterReferenceCode: r.chapterReferenceCode,
      currencyCode: r.currencyCode,
      total: new Decimal(r.total).toFixed(4),
    })),
    TOP_N,
  );
}

async function fetchRecentImports(
  database: Database,
  zoneId: string,
  chapterScope: string[] | undefined,
): Promise<DashboardRecentImport[]> {
  const jobs = await database
    .select({
      id: importJobs.id,
      status: importJobs.status,
      createdAt: importJobs.createdAt,
      fileName: importFiles.originalFileName,
    })
    .from(importJobs)
    .innerJoin(
      importFiles,
      and(
        eq(importFiles.zoneId, importJobs.zoneId),
        eq(importFiles.id, importJobs.importFileId),
      ),
    )
    .where(
      and(
        eq(importJobs.zoneId, zoneId),
        ...(chapterScope ? [inArray(importFiles.chapterId, chapterScope)] : []),
      ),
    )
    .orderBy(desc(importJobs.createdAt))
    .limit(RECENT_IMPORTS_N);

  if (jobs.length === 0) return [];

  // Per-job: distinct posted contribution count + per-currency line
  // total. Same shape as import-reconciliation.ts; we keep it inlined
  // because the dashboard only ever asks for the most recent N jobs.
  const jobIds = jobs.map((j) => j.id);
  const postedRows = await database
    .select({
      importJobId: importRows.importJobId,
      contributionId: contributions.id,
      amount: contributionLines.amount,
      currencyCode: contributionLines.currencyCode,
    })
    .from(importRows)
    .innerJoin(
      contributions,
      and(
        eq(contributions.zoneId, importRows.zoneId),
        eq(contributions.id, importRows.contributionId),
      ),
    )
    .innerJoin(
      contributionLines,
      and(
        eq(contributionLines.zoneId, contributions.zoneId),
        eq(contributionLines.contributionId, contributions.id),
      ),
    )
    .where(
      and(
        eq(importRows.zoneId, zoneId),
        sql`${importRows.contributionId} is not null`,
        eq(contributions.status, "posted"),
        inArray(importRows.importJobId, jobIds),
      ),
    );

  const totalsByJob = new Map<string, Map<string, Decimal>>();
  const postedIdsByJob = new Map<string, Set<string>>();
  for (const row of postedRows) {
    if (!row.importJobId) continue;
    const ids = postedIdsByJob.get(row.importJobId) ?? new Set<string>();
    ids.add(row.contributionId);
    postedIdsByJob.set(row.importJobId, ids);
    const byCur = totalsByJob.get(row.importJobId) ?? new Map<string, Decimal>();
    const cur = byCur.get(row.currencyCode) ?? new Decimal(0);
    byCur.set(row.currencyCode, cur.plus(new Decimal(row.amount)));
    totalsByJob.set(row.importJobId, byCur);
  }

  return jobs.map((j) => {
    const byCur = totalsByJob.get(j.id);
    const perCurrency: CurrencyTotal[] = byCur
      ? Array.from(byCur.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currencyCode, total]) => ({ currencyCode, total: total.toFixed(4) }))
      : [];
    return {
      id: j.id,
      fileName: j.fileName,
      status: toImportJobStatus(j.status),
      createdAt: j.createdAt.toISOString(),
      postedCount: postedIdsByJob.get(j.id)?.size ?? 0,
      perCurrency,
    };
  });
}
