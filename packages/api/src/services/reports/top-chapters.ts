// packages/api/src/services/reports/top-chapters.ts
// Phase 7 — top chapters report (REPORTS.md §2.9).
// Ranks chapters by total posted giving over a date range. Optional
// `partnershipOnly` filter restricts the sum to giving types whose
// `has_partnership_target = true` (covers the legacy
// `Givings_Partnership_TopChapter` variant).
// RELEVANT FILES: packages/api/src/services/reports/top-partners.ts, packages/api/src/services/reports/registry.ts, packages/api/src/services/reports/reports.test.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  chapters,
  contributionLines,
  contributions,
  givingTypes,
  members,
} from "@stewardledger/db/schema";
import {
  CHAPTER_ROLES,
  type AuthorizedContext,
} from "@stewardledger/shared";
import {
  addBrandedSheet,
  escapeExcelText,
  moneyFormatForCurrency,
} from "./branding";
import type {
  CurrencySubtotal,
  ReportColumn,
  ReportFetchResult,
  ReportSpec,
} from "./types";

export const topChaptersFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    topN: z.coerce.number().int().min(1).max(200).default(20),
    partnershipOnly: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((v) => (typeof v === "boolean" ? v : v === "true"))
      .optional()
      .default(false),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type TopChaptersFilters = z.infer<typeof topChaptersFiltersSchema>;

interface TopChaptersRow {
  rank: number;
  chapterReferenceCode: string | null;
  chapterName: string | null;
  currencyCode: string;
  total: string;
}

const COLUMNS: ReportColumn[] = [
  { key: "rank", label: "Rank", kind: "number" },
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "currencyCode", label: "Currency", kind: "text" },
  { key: "total", label: "Total", kind: "money" },
];

export const topChaptersReport: ReportSpec<TopChaptersFilters, TopChaptersRow> = {
  id: "top-chapters",
  title: "Top chapters",
  description:
    "Chapters ranked by total posted giving over a date range. Optional partnership-only mode.",
  filtersSchema: topChaptersFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx, _filters) => {
    // Top chapters has no chapter filter (filtering by one chapter
    // and ranking chapters would always yield one row). Chapter-
    // scoped readers see only their bound chapters via the `fetch`
    // clamp; they need at least one binding to call this.
    if (isZoneRead(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<TopChaptersRow>> {
    const conditions = [
      eq(contributions.zoneId, ctx.zoneId),
      sql`${contributions.contributionDate} >= ${filters.dateFrom}`,
      sql`${contributions.contributionDate} <= ${filters.dateTo}`,
      sql`${contributions.status} in ('posted', 'reversed')`,
      isNull(members.deletedAt),
    ];
    if (!isZoneRead(ctx)) {
      conditions.push(inArray(contributions.chapterId, ctx.chapterIds));
    }
    if (filters.partnershipOnly) {
      conditions.push(eq(givingTypes.hasPartnershipTarget, true));
    }

    const lineRows = await database
      .select({
        chapterId: contributions.chapterId,
        chapterReferenceCode: chapters.referenceCode,
        chapterName: chapters.name,
        currencyCode: contributionLines.currencyCode,
        amount: contributionLines.amount,
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
      .leftJoin(
        members,
        and(eq(members.zoneId, contributions.zoneId), eq(members.id, contributions.memberId)),
      )
      .leftJoin(
        chapters,
        and(eq(chapters.zoneId, contributions.zoneId), eq(chapters.id, contributions.chapterId)),
      )
      .where(and(...conditions));

    interface Bucket {
      chapterId: string;
      chapterReferenceCode: string | null;
      chapterName: string | null;
      currencyCode: string;
      total: Decimal;
    }
    const buckets = new Map<string, Bucket>();
    for (const row of lineRows) {
      const key = `${row.chapterId}|${row.currencyCode}`;
      const bucket = buckets.get(key);
      const amount = new Decimal(row.amount);
      if (bucket) {
        bucket.total = bucket.total.plus(amount);
      } else {
        buckets.set(key, {
          chapterId: row.chapterId,
          chapterReferenceCode: row.chapterReferenceCode,
          chapterName: row.chapterName,
          currencyCode: row.currencyCode,
          total: amount,
        });
      }
    }

    const byCurrency = new Map<string, Bucket[]>();
    for (const bucket of buckets.values()) {
      if (bucket.total.isZero()) continue;
      const list = byCurrency.get(bucket.currencyCode) ?? [];
      list.push(bucket);
      byCurrency.set(bucket.currencyCode, list);
    }

    const rows: TopChaptersRow[] = [];
    const grand = new Map<string, Decimal>();
    for (const currencyCode of Array.from(byCurrency.keys()).sort()) {
      const list = byCurrency.get(currencyCode)!;
      list.sort((a, b) => b.total.comparedTo(a.total));
      const top = list.slice(0, filters.topN);
      top.forEach((b, i) => {
        rows.push({
          rank: i + 1,
          chapterReferenceCode: b.chapterReferenceCode,
          chapterName: b.chapterName,
          currencyCode: b.currencyCode,
          total: b.total.toFixed(4),
        });
        const cur = grand.get(b.currencyCode) ?? new Decimal(0);
        grand.set(b.currencyCode, cur.plus(b.total));
      });
    }

    const subtotals: CurrencySubtotal[] = Array.from(grand.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, total]) => ({ currencyCode, total: total.toFixed(4) }));

    return { rows, subtotals };
  },
  async excel(rows, subtotals, filters, branding) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const filterParts: string[] = [
      `Period ${filters.dateFrom} -> ${filters.dateTo}`,
      `Top ${filters.topN}`,
    ];
    if (filters.partnershipOnly) filterParts.push("Partnership only");

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Top chapters",
      branding,
      reportTitle: "Top chapters",
      filterSummary: filterParts.join("  •  "),
      columnCount: COLUMNS.length,
    });

    const headerRow = sheet.getRow(6);
    COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true };
      cell.alignment = { horizontal: col.kind === "money" ? "right" : "left" };
    });
    headerRow.commit();

    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      COLUMNS.forEach((col, i) => {
        const cell = dataRow.getCell(i + 1);
        const value = (row as unknown as Record<string, unknown>)[col.key];
        if (col.kind === "money" && typeof value === "string") {
          cell.value = Number(new Decimal(value).toFixed(4));
          cell.numFmt = moneyFormatForCurrency(row.currencyCode);
        } else if (typeof value === "string") {
          cell.value = escapeExcelText(value);
        } else {
          cell.value = (value as ExcelJS.CellValue) ?? null;
        }
      });
      dataRow.commit();
      r += 1;
    }

    if (subtotals && subtotals.length > 0) {
      r += 1;
      const head = sheet.getRow(r);
      head.getCell(1).value = "Totals per currency";
      head.getCell(1).font = { bold: true };
      head.commit();
      r += 1;
      for (const sub of subtotals) {
        const subRow = sheet.getRow(r);
        subRow.getCell(1).value = sub.currencyCode;
        subRow.getCell(1).font = { bold: true };
        const amountCell = subRow.getCell(2);
        amountCell.value = Number(new Decimal(sub.total).toFixed(4));
        amountCell.numFmt = moneyFormatForCurrency(sub.currencyCode);
        amountCell.font = { bold: true };
        subRow.commit();
        r += 1;
      }
    }

    sheet.columns = COLUMNS.map((col) => ({
      header: undefined,
      key: col.key,
      width: col.kind === "money" ? 14 : 20,
    }));
    setWidthByKey(sheet, "chapterName", 28);
    setWidthByKey(sheet, "rank", 8);

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function setWidthByKey(sheet: ExcelJS.Worksheet, key: string, width: number): void {
  const idx = COLUMNS.findIndex((c) => c.key === key) + 1;
  if (idx > 0) sheet.getColumn(idx).width = width;
}

function isZoneRead(ctx: AuthorizedContext): boolean {
  const chapterCodes: readonly string[] = Object.values(CHAPTER_ROLES);
  return ctx.roleCodes.some((c) => !chapterCodes.includes(c));
}
