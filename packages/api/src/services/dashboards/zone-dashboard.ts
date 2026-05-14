// packages/api/src/services/dashboards/zone-dashboard.ts
// Phase 7 — zone dashboard payload (REPORTS.md §2.15).
// Aggregates zone-wide stats (chapters, members, current-month and YTD
// giving, top-5 chapters / partners, recent imports) into one payload
// for the /zone/dashboard landing surface.
// RELEVANT FILES: packages/api/src/routes/tenant-dashboard.ts, packages/api/src/services/reports/top-chapters.ts, packages/api/src/services/reports/import-reconciliation.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  chapters,
  contributionLines,
  contributions,
  importFiles,
  importJobs,
  importRows,
  members,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import type { AuthorizedContext } from "@stewardledger/shared";

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
  status: string;
  createdAt: string; // ISO datetime
  postedCount: number;
  perCurrency: CurrencyTotal[];
}

export interface ZoneDashboardPayload {
  asOf: string; // ISO datetime
  chapters: { total: number; active: number };
  members: { total: number; active: number; inactive: number };
  monthlyGiving: DashboardPeriodTotals;
  yearToDateGiving: DashboardPeriodTotals;
  topChapters: DashboardTopChapter[];
  topPartners: DashboardTopPartner[];
  recentImports: DashboardRecentImport[];
}

const TOP_N = 5;
const RECENT_IMPORTS_N = 5;

/**
 * Build the zone dashboard payload. The caller must be a zone-wide
 * reader; the route handler does the gate. Money is always grouped by
 * currency — DOMAIN-MODEL §6 forbids silent FX conversion.
 */
export async function buildZoneDashboard(
  database: Database,
  ctx: AuthorizedContext,
): Promise<ZoneDashboardPayload> {
  const now = new Date();
  const monthStart = isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const monthEndExclusive = isoDate(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  );
  const yearStart = isoDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
  const yearEndExclusive = isoDate(new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)));
  const monthEnd = isoDate(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
  );
  const yearEnd = `${now.getUTCFullYear()}-12-31`;

  // All six aggregates are independent and zone-scoped; run them in
  // parallel so the worst-case latency is a single round-trip across
  // the pool rather than a sequential chain.
  const [
    chapterCounts,
    memberCounts,
    monthlyPerCurrency,
    ytdPerCurrency,
    topChaptersList,
    topPartnersList,
    recentImportsList,
  ] = await Promise.all([
    countChapters(database, ctx.zoneId),
    countMembers(database, ctx.zoneId),
    sumPostedByCurrency(database, ctx.zoneId, monthStart, monthEndExclusive),
    sumPostedByCurrency(database, ctx.zoneId, yearStart, yearEndExclusive),
    fetchTopChapters(database, ctx.zoneId, monthStart, monthEndExclusive),
    fetchTopPartners(database, ctx.zoneId, monthStart, monthEndExclusive),
    fetchRecentImports(database, ctx.zoneId),
  ]);

  return {
    asOf: now.toISOString(),
    chapters: chapterCounts,
    members: memberCounts,
    monthlyGiving: {
      periodStart: monthStart,
      periodEnd: monthEnd,
      perCurrency: monthlyPerCurrency,
    },
    yearToDateGiving: {
      periodStart: yearStart,
      periodEnd: yearEnd,
      perCurrency: ytdPerCurrency,
    },
    topChapters: topChaptersList,
    topPartners: topPartnersList,
    recentImports: recentImportsList,
  };
}

async function countChapters(
  database: Database,
  zoneId: string,
): Promise<{ total: number; active: number }> {
  const [row] = await database
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${chapters.deletedAt} is null)::int`,
    })
    .from(chapters)
    .where(eq(chapters.zoneId, zoneId));
  return { total: row?.total ?? 0, active: row?.active ?? 0 };
}

async function countMembers(
  database: Database,
  zoneId: string,
): Promise<{ total: number; active: number; inactive: number }> {
  const [row] = await database
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${members.isActive} = true)::int`,
    })
    .from(members)
    .where(and(eq(members.zoneId, zoneId), isNull(members.deletedAt)));
  const total = row?.total ?? 0;
  const active = row?.active ?? 0;
  return { total, active, inactive: total - active };
}

async function sumPostedByCurrency(
  database: Database,
  zoneId: string,
  startInclusive: string,
  endExclusive: string,
): Promise<CurrencyTotal[]> {
  // Sum every line on a posted/reversed contribution in the window.
  // Reversal lines carry negative amounts (canonical invariant from
  // DOMAIN-MODEL §6), so a `posted + reversed` SUM nets to zero for
  // a fully-reversed pair without any client-side bookkeeping.
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
        sql`${contributions.contributionDate} >= ${startInclusive}::date`,
        sql`${contributions.contributionDate} < ${endExclusive}::date`,
        sql`${contributions.status} in ('posted', 'reversed')`,
      ),
    )
    .groupBy(contributionLines.currencyCode);
  return rows
    .map((r) => ({ currencyCode: r.currencyCode, total: new Decimal(r.total).toFixed(4) }))
    .filter((r) => !new Decimal(r.total).isZero())
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

async function fetchTopChapters(
  database: Database,
  zoneId: string,
  startInclusive: string,
  endExclusive: string,
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
        sql`${contributions.contributionDate} >= ${startInclusive}::date`,
        sql`${contributions.contributionDate} < ${endExclusive}::date`,
        sql`${contributions.status} in ('posted', 'reversed')`,
      ),
    )
    .groupBy(chapters.id, chapters.referenceCode, chapters.name, contributionLines.currencyCode);

  // Rank per currency, take top N per currency. A multi-currency zone
  // therefore sees parallel lists; the UI renders them in currency-
  // sorted order so the layout is deterministic.
  const byCurrency = new Map<string, DashboardTopChapter[]>();
  for (const r of rows) {
    const total = new Decimal(r.total);
    if (total.isZero()) continue;
    const entry: DashboardTopChapter = {
      id: r.id,
      referenceCode: r.referenceCode,
      name: r.name,
      currencyCode: r.currencyCode,
      total: total.toFixed(4),
    };
    const list = byCurrency.get(r.currencyCode) ?? [];
    list.push(entry);
    byCurrency.set(r.currencyCode, list);
  }
  const out: DashboardTopChapter[] = [];
  for (const currencyCode of Array.from(byCurrency.keys()).sort()) {
    const list = byCurrency.get(currencyCode)!;
    list.sort((a, b) => new Decimal(b.total).comparedTo(new Decimal(a.total)));
    out.push(...list.slice(0, TOP_N));
  }
  return out;
}

async function fetchTopPartners(
  database: Database,
  zoneId: string,
  startInclusive: string,
  endExclusive: string,
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
        sql`${contributions.contributionDate} >= ${startInclusive}::date`,
        sql`${contributions.contributionDate} < ${endExclusive}::date`,
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
      chapters.referenceCode,
      contributionLines.currencyCode,
    );

  const byCurrency = new Map<string, DashboardTopPartner[]>();
  for (const r of rows) {
    const total = new Decimal(r.total);
    if (total.isZero()) continue;
    const name =
      r.fullName ??
      (r.firstName || r.lastName
        ? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()
        : r.referenceCode);
    const entry: DashboardTopPartner = {
      id: r.memberId,
      referenceCode: r.referenceCode,
      name,
      chapterReferenceCode: r.chapterReferenceCode,
      currencyCode: r.currencyCode,
      total: total.toFixed(4),
    };
    const list = byCurrency.get(r.currencyCode) ?? [];
    list.push(entry);
    byCurrency.set(r.currencyCode, list);
  }
  const out: DashboardTopPartner[] = [];
  for (const currencyCode of Array.from(byCurrency.keys()).sort()) {
    const list = byCurrency.get(currencyCode)!;
    list.sort((a, b) => new Decimal(b.total).comparedTo(new Decimal(a.total)));
    out.push(...list.slice(0, TOP_N));
  }
  return out;
}

async function fetchRecentImports(
  database: Database,
  zoneId: string,
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
    .where(eq(importJobs.zoneId, zoneId))
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
      status: j.status,
      createdAt: j.createdAt.toISOString(),
      postedCount: postedIdsByJob.get(j.id)?.size ?? 0,
      perCurrency,
    };
  });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
