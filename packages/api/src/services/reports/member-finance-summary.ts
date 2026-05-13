// packages/api/src/services/reports/member-finance-summary.ts
// Summarises posted contribution lines by member, payment method, period, currency, and giving type.
// Exists to implement the Phase 7 member finance summary report from REPORTS.md §2.2.
// RELEVANT FILES: packages/api/src/services/reports/member-statement.ts, packages/api/src/services/reports/registry.ts, packages/api/src/services/reports/reports.test.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import type { Database } from "@stewardledger/db";
import {
  chapters,
  contributionLines,
  contributions,
  givingPeriods,
  givingTypes,
  members,
  paymentMethods,
} from "@stewardledger/db/schema";
import {
  CHAPTER_ROLES,
  uuidSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import {
  addBrandedSheet,
  escapeExcelText,
  moneyFormatForCurrency,
} from "./branding";
import {
  ReportError,
  type ReportColumn,
  type ReportFetchResult,
  type ReportSpec,
} from "./types";

export const memberFinanceSummaryFiltersSchema = z
  .object({
    chapterId: uuidSchema.optional(),
    memberId: uuidSchema.optional(),
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    paymentMethodId: uuidSchema.optional(),
    givingTypeId: uuidSchema.optional(),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type MemberFinanceSummaryFilters = z.infer<
  typeof memberFinanceSummaryFiltersSchema
>;

type MemberFinanceSummaryRow = {
  memberReferenceCode: string;
  memberName: string;
  chapterReferenceCode: string | null;
  chapterName: string | null;
  paymentMethodCode: string;
  periodLabel: string;
  currencyCode: string;
  total: string;
} & Record<string, string | null>;

interface GivingTypeColumn {
  id: string;
  key: string;
  label: string;
  shortCode: string | null;
  isActive: boolean;
}

const BASE_COLUMNS: ReportColumn[] = [
  { key: "memberReferenceCode", label: "Member ref", kind: "text" },
  { key: "memberName", label: "Member", kind: "text" },
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "paymentMethodCode", label: "Payment", kind: "text" },
  { key: "periodLabel", label: "Period", kind: "text" },
  { key: "currencyCode", label: "Currency", kind: "text" },
];

export const memberFinanceSummaryReport: ReportSpec<
  MemberFinanceSummaryFilters,
  MemberFinanceSummaryRow
> = {
  id: "member-finance-summary",
  title: "Member finance summary",
  description:
    "Per-member giving totals over a date range, pivoted by giving type.",
  filtersSchema: memberFinanceSummaryFiltersSchema,
  columns: (filters) => [
    ...BASE_COLUMNS,
    ...givingTypeColumnsFromMeta(filters).map((col) => ({
      key: col.key,
      label: col.label,
      kind: "money" as const,
    })),
    { key: "total", label: "Total", kind: "money" as const },
  ],
  accessCheck: (ctx, filters) => {
    if (isZoneRead(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    if (filters.chapterId && !ctx.chapterIds.includes(filters.chapterId)) {
      return "forbidden";
    }
    return null;
  },
  async fetch(
    database,
    ctx,
    filters,
  ): Promise<ReportFetchResult<MemberFinanceSummaryRow>> {
    if (!isZoneRead(ctx) && filters.memberId) {
      const [member] = await database
        .select({ chapterId: members.chapterId })
        .from(members)
        .where(
          and(
            eq(members.zoneId, ctx.zoneId),
            eq(members.id, filters.memberId),
            isNull(members.deletedAt),
          ),
        )
        .limit(1);
      if (!member?.chapterId || !ctx.chapterIds.includes(member.chapterId)) {
        throw new ReportError("forbidden", "Member is not in your chapter scope.");
      }
    }

    const givingTypeCols = await loadGivingTypeColumns(database, ctx.zoneId, filters);
    if (givingTypeCols.length === 0) {
      return {
        rows: [],
        columns: buildColumns([]),
        subtotals: [],
        meta: { givingTypeColumns: [] },
      };
    }

    const conditions = [
      eq(contributions.zoneId, ctx.zoneId),
      sql`${contributions.contributionDate} >= ${filters.dateFrom}`,
      sql`${contributions.contributionDate} <= ${filters.dateTo}`,
      sql`${contributions.status} in ('posted', 'reversed')`,
      isNull(members.deletedAt),
    ];
    if (filters.chapterId) {
      conditions.push(eq(contributions.chapterId, filters.chapterId));
    } else if (!isZoneRead(ctx)) {
      conditions.push(inArray(contributions.chapterId, ctx.chapterIds));
    }
    if (filters.memberId) conditions.push(eq(contributions.memberId, filters.memberId));
    if (filters.paymentMethodId) {
      conditions.push(eq(contributions.paymentMethodId, filters.paymentMethodId));
    }
    if (filters.givingTypeId) {
      conditions.push(eq(contributionLines.givingTypeId, filters.givingTypeId));
    }

    const lineRows = await database
      .select({
        memberId: members.id,
        memberReferenceCode: members.referenceCode,
        memberName: members.fullName,
        chapterReferenceCode: chapters.referenceCode,
        chapterName: chapters.name,
        paymentMethodCode: paymentMethods.code,
        periodId: givingPeriods.id,
        isoWeek: givingPeriods.isoWeek,
        isoYear: givingPeriods.isoYear,
        contributionDate: contributions.contributionDate,
        givingTypeId: contributionLines.givingTypeId,
        amount: contributionLines.amount,
        currencyCode: contributionLines.currencyCode,
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
      .leftJoin(
        paymentMethods,
        and(
          eq(paymentMethods.zoneId, contributions.zoneId),
          eq(paymentMethods.id, contributions.paymentMethodId),
        ),
      )
      .leftJoin(
        givingPeriods,
        and(
          eq(givingPeriods.zoneId, contributions.zoneId),
          eq(givingPeriods.id, contributions.givingPeriodId),
        ),
      )
      .where(and(...conditions))
      .orderBy(
        asc(members.referenceCode),
        asc(paymentMethods.code),
        asc(givingPeriods.date),
        asc(contributions.contributionDate),
      );

    const byType = new Map(givingTypeCols.map((col) => [col.id, col]));
    const grouped = new Map<string, MemberFinanceSummaryRow>();
    const rowTotals = new Map<string, Decimal>();
    const grand = new Map<string, Decimal>();

    for (const line of lineRows) {
      const typeCol = byType.get(line.givingTypeId);
      if (!typeCol) continue;
      const paymentCode = line.paymentMethodCode ?? "UNSPECIFIED";
      const periodLabel =
        line.isoYear && line.isoWeek
          ? `ISO ${line.isoYear}-W${String(line.isoWeek).padStart(2, "0")}`
          : `Unassigned (${line.contributionDate})`;
      const periodKey =
        line.isoYear && line.isoWeek
          ? `${line.isoYear}-W${String(line.isoWeek).padStart(2, "0")}`
          : `unassigned:${line.contributionDate}`;
      const key = [
        line.memberId,
        paymentCode,
        periodKey,
        line.currencyCode,
      ].join("|");
      let row = grouped.get(key);
      if (!row) {
        row = {
          memberReferenceCode: line.memberReferenceCode,
          memberName: line.memberName ?? line.memberReferenceCode,
          chapterReferenceCode: line.chapterReferenceCode,
          chapterName: line.chapterName,
          paymentMethodCode: paymentCode,
          periodLabel,
          currencyCode: line.currencyCode,
          total: "0.0000",
        };
        for (const col of givingTypeCols) {
          row[col.key] = "0.0000";
        }
        grouped.set(key, row);
      }

      const amount = new Decimal(line.amount);
      row[typeCol.key] = new Decimal(row[typeCol.key] ?? "0").plus(amount).toFixed(4);
      const currentRowTotal = rowTotals.get(key) ?? new Decimal(0);
      const nextRowTotal = currentRowTotal.plus(amount);
      rowTotals.set(key, nextRowTotal);
      row.total = nextRowTotal.toFixed(4);

      const currentGrand = grand.get(line.currencyCode) ?? new Decimal(0);
      grand.set(line.currencyCode, currentGrand.plus(amount));
    }

    const rows = Array.from(grouped.values());
    const subtotals = Array.from(grand.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, total]) => ({ currencyCode, total: total.toFixed(4) }));

    return {
      rows,
      columns: buildColumns(givingTypeCols),
      subtotals,
      meta: {
        givingTypeColumns: givingTypeCols,
      },
    };
  },
  async excel(rows, subtotals, filters, branding, extras) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const givingTypeCols = givingTypeColumnsFromMeta(
      filters,
      extras as Record<string, unknown> | undefined,
    );
    const columns = buildColumns(givingTypeCols);
    const filterParts = [
      `Period ${filters.dateFrom} -> ${filters.dateTo}`,
      filters.chapterId ? `Chapter ${filters.chapterId}` : null,
      filters.memberId ? `Member ${filters.memberId}` : null,
      filters.paymentMethodId ? `Payment ${filters.paymentMethodId}` : null,
      filters.givingTypeId ? `Giving type ${filters.givingTypeId}` : null,
    ].filter(Boolean);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Member summary",
      branding,
      reportTitle: "Member finance summary",
      filterSummary: filterParts.join("  •  "),
      columnCount: columns.length,
    });

    const headerRow = sheet.getRow(6);
    columns.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = escapeExcelText(col.label);
      cell.font = { bold: true };
      cell.alignment = { horizontal: col.kind === "money" ? "right" : "left" };
    });
    headerRow.commit();

    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      columns.forEach((col, i) => {
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

    sheet.columns = columns.map((col) => ({
      header: undefined,
      key: col.key,
      width: col.kind === "money" ? 14 : 22,
    }));
    sheet.getColumn(2).width = 30;
    sheet.getColumn(4).width = 26;

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

async function loadGivingTypeColumns(
  database: Database,
  zoneId: string,
  filters: MemberFinanceSummaryFilters,
): Promise<GivingTypeColumn[]> {
  const conditions = [eq(givingTypes.zoneId, zoneId)];
  if (filters.givingTypeId) conditions.push(eq(givingTypes.id, filters.givingTypeId));
  const rows = await database
    .select({
      id: givingTypes.id,
      name: givingTypes.name,
      shortCode: givingTypes.shortCode,
      isActive: givingTypes.isActive,
    })
    .from(givingTypes)
    .where(and(...conditions))
    .orderBy(asc(givingTypes.ordinal), asc(givingTypes.name));
  return rows.map((row) => ({
    id: row.id,
    key: givingTypeKey(row.id),
    label: [
      row.shortCode ? `${row.shortCode} - ${row.name}` : row.name,
      row.isActive ? null : "(inactive)",
    ]
      .filter(Boolean)
      .join(" "),
    shortCode: row.shortCode,
    isActive: row.isActive,
  }));
}

function givingTypeColumnsFromMeta(
  _filters: MemberFinanceSummaryFilters,
  extras?: Record<string, unknown>,
): GivingTypeColumn[] {
  const raw = extras?.givingTypeColumns;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isGivingTypeColumn);
}

function isGivingTypeColumn(value: unknown): value is GivingTypeColumn {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.key === "string" &&
    typeof record.label === "string" &&
    (typeof record.shortCode === "string" || record.shortCode === null) &&
    typeof record.isActive === "boolean"
  );
}

function givingTypeKey(id: string): string {
  return `giving_${id.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function buildColumns(givingTypeCols: GivingTypeColumn[]): ReportColumn[] {
  return [
    ...BASE_COLUMNS,
    ...givingTypeCols.map((col) => ({
      key: col.key,
      label: col.label,
      kind: "money" as const,
    })),
    { key: "total", label: "Total", kind: "money" as const },
  ];
}

function isZoneRead(ctx: AuthorizedContext): boolean {
  const chapterCodes: readonly string[] = Object.values(CHAPTER_ROLES);
  return ctx.roleCodes.some((c) => !chapterCodes.includes(c));
}
