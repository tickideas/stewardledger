// packages/api/src/services/reports/top-family.ts
// Phase 10 / GA — Top Family report (REPORTS.md §2.16).
// Mirrors top-partners.ts but groups by household (`families` joined
// through `family_members.left_at is null`). Ranks per currency, with
// the same `partnershipOnly` toggle that covers the legacy
// `Top Family Report`.
// RELEVANT FILES: packages/api/src/services/reports/top-partners.ts, packages/api/src/services/reports/registry.ts, packages/db/src/schema/families.ts, docs/CHURCHPLUS-PORT-NOTES.md

import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  chapters,
  contributionLines,
  contributions,
  families,
  familyMembers,
  givingTypes,
} from "@stewardledger/db/schema";
import { uuidSchema } from "@stewardledger/shared";
import {
  addBrandedSheet,
  escapeExcelText,
  moneyFormatForCurrency,
} from "./branding";
import { reportVisibleScope } from "./access";
import type {
  CurrencySubtotal,
  ReportColumn,
  ReportFetchResult,
  ReportSpec,
} from "./types";

export const topFamilyFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    chapterId: uuidSchema.optional(),
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
export type TopFamilyFilters = z.infer<typeof topFamilyFiltersSchema>;

interface TopFamilyRow {
  rank: number;
  familyReferenceCode: string;
  familyName: string;
  chapterReferenceCode: string | null;
  chapterName: string | null;
  memberCount: number;
  currencyCode: string;
  total: string;
}

const COLUMNS: ReportColumn[] = [
  { key: "rank", label: "Rank", kind: "number" },
  { key: "familyReferenceCode", label: "Family ref", kind: "text" },
  { key: "familyName", label: "Family", kind: "text" },
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "memberCount", label: "Members", kind: "number" },
  { key: "currencyCode", label: "Currency", kind: "text" },
  { key: "total", label: "Total", kind: "money" },
];

export const topFamilyReport: ReportSpec<TopFamilyFilters, TopFamilyRow> = {
  id: "top-family",
  title: "Top families",
  description:
    "Households ranked by total posted giving over a date range. Optional partnership-only mode.",
  filtersSchema: topFamilyFiltersSchema,
  columns: () => COLUMNS,
  async accessCheck(ctx, filters) {
    const scope = await reportVisibleScope(ctx);
    if (scope.kind === "all") return null;
    if (scope.ids.length === 0) return "forbidden";
    if (filters.chapterId && !scope.ids.includes(filters.chapterId)) {
      return "forbidden";
    }
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<TopFamilyRow>> {
    const conditions = [
      eq(contributions.zoneId, ctx.zoneId),
      sql`${contributions.contributionDate} >= ${filters.dateFrom}`,
      sql`${contributions.contributionDate} <= ${filters.dateTo}`,
      sql`${contributions.status} in ('posted', 'reversed')`,
      sql`${contributions.memberId} is not null`,
      isNull(families.deletedAt),
    ];
    const scope = await reportVisibleScope(ctx);
    if (filters.chapterId) {
      conditions.push(eq(families.chapterId, filters.chapterId));
    } else if (scope.kind === "list") {
      conditions.push(inArray(families.chapterId, scope.ids));
    }
    if (filters.partnershipOnly) {
      conditions.push(eq(givingTypes.hasPartnershipTarget, true));
    }

    const lineRows = await database
      .select({
        familyId: families.id,
        familyReferenceCode: families.referenceCode,
        familyName: families.name,
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
      .innerJoin(
        familyMembers,
        and(
          eq(familyMembers.zoneId, contributions.zoneId),
          eq(familyMembers.memberId, contributions.memberId),
          isNull(familyMembers.leftAt),
        ),
      )
      .innerJoin(
        families,
        and(
          eq(families.zoneId, familyMembers.zoneId),
          eq(families.id, familyMembers.familyId),
        ),
      )
      .leftJoin(
        chapters,
        and(
          eq(chapters.zoneId, families.zoneId),
          eq(chapters.id, families.chapterId),
        ),
      )
      .where(and(...conditions));

    interface Bucket {
      familyId: string;
      familyReferenceCode: string;
      familyName: string;
      chapterReferenceCode: string | null;
      chapterName: string | null;
      currencyCode: string;
      total: Decimal;
    }
    const buckets = new Map<string, Bucket>();
    for (const row of lineRows) {
      const key = `${row.familyId}|${row.currencyCode}`;
      const bucket = buckets.get(key);
      const amount = new Decimal(row.amount);
      if (bucket) {
        bucket.total = bucket.total.plus(amount);
      } else {
        buckets.set(key, {
          familyId: row.familyId,
          familyReferenceCode: row.familyReferenceCode,
          familyName: row.familyName,
          chapterReferenceCode: row.chapterReferenceCode,
          chapterName: row.chapterName,
          currencyCode: row.currencyCode,
          total: amount,
        });
      }
    }

    // Headcount per family (one row per family; not multiplied by
    // currency). Read independently so the count is stable when a
    // household gives in two currencies.
    const familyIds = Array.from(new Set(Array.from(buckets.values()).map((b) => b.familyId)));
    const counts = new Map<string, number>();
    if (familyIds.length > 0) {
      const countRows = await database
        .select({
          familyId: familyMembers.familyId,
          count: sql<number>`count(*)::int`,
        })
        .from(familyMembers)
        .where(
          and(
            eq(familyMembers.zoneId, ctx.zoneId),
            inArray(familyMembers.familyId, familyIds),
            isNull(familyMembers.leftAt),
          ),
        )
        .groupBy(familyMembers.familyId);
      for (const row of countRows) counts.set(row.familyId, row.count);
    }

    const byCurrency = new Map<string, Bucket[]>();
    for (const bucket of buckets.values()) {
      if (bucket.total.isZero()) continue;
      const list = byCurrency.get(bucket.currencyCode) ?? [];
      list.push(bucket);
      byCurrency.set(bucket.currencyCode, list);
    }

    const rows: TopFamilyRow[] = [];
    const grand = new Map<string, Decimal>();
    for (const currencyCode of Array.from(byCurrency.keys()).sort()) {
      const list = byCurrency.get(currencyCode)!;
      list.sort((a, b) => b.total.comparedTo(a.total));
      const top = list.slice(0, filters.topN);
      top.forEach((b, i) => {
        rows.push({
          rank: i + 1,
          familyReferenceCode: b.familyReferenceCode,
          familyName: b.familyName,
          chapterReferenceCode: b.chapterReferenceCode,
          chapterName: b.chapterName,
          memberCount: counts.get(b.familyId) ?? 0,
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
  filterSummary(filters) {
    const parts: string[] = [
      `Period ${filters.dateFrom} -> ${filters.dateTo}`,
      `Top ${filters.topN}`,
    ];
    if (filters.chapterId) parts.push(`Chapter ${filters.chapterId}`);
    if (filters.partnershipOnly) parts.push("Partnership only");
    return parts.join("  •  ");
  },
  async excel(rows, subtotals, filters, branding) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Top families",
      branding,
      reportTitle: "Top families",
      filterSummary: this.filterSummary?.(filters) ?? "",
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
    setWidthByKey(sheet, "familyName", 28);
    setWidthByKey(sheet, "chapterName", 24);
    setWidthByKey(sheet, "rank", 8);
    setWidthByKey(sheet, "memberCount", 10);

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function setWidthByKey(sheet: ExcelJS.Worksheet, key: string, width: number): void {
  const idx = COLUMNS.findIndex((c) => c.key === key) + 1;
  if (idx > 0) sheet.getColumn(idx).width = width;
}
