// packages/api/src/services/reports/giving-by-chapter.ts
// Phase 7 — chapter-pivot report (REPORTS.md §2.7).
// Aggregates posted contribution lines by chapter × currency, pivoting
// columns by giving type, giving category, or month.
// RELEVANT FILES: packages/api/src/services/reports/member-finance-summary.ts, packages/api/src/services/reports/registry.ts, packages/api/src/services/reports/reports.test.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import type { Database } from "@stewardledger/db";
import {
  chapters,
  contributionLines,
  contributions,
  givingCategories,
  givingTypes,
  members,
  ministryYears,
  partnershipYears,
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
  type CurrencySubtotal,
  type ReportColumn,
  type ReportFetchResult,
  type ReportSpec,
} from "./types";

export const givingByChapterFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    pivotBy: z.enum(["givingType", "category", "month"]),
    chapterId: uuidSchema.optional(),
    ministryYearId: uuidSchema.optional(),
    partnershipYearId: uuidSchema.optional(),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type GivingByChapterFilters = z.infer<typeof givingByChapterFiltersSchema>;

// One pivot column resolved against the dataset.
interface PivotColumn {
  // Server-side aggregation key. Stable per dimension value.
  id: string;
  // Output column key on each row (`pivot_<id>` after sanitising).
  key: string;
  // Header label as shown to users.
  label: string;
  // Sort key for deterministic ordering across runs.
  sort: string;
}

interface GivingByChapterRow {
  chapterReferenceCode: string | null;
  chapterName: string | null;
  currencyCode: string;
  total: string;
  // Dynamic pivot columns are stamped on as `pivot_<id>: string` (4dp).
  [extraKey: string]: string | null;
}

const BASE_COLUMNS: ReportColumn[] = [
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "currencyCode", label: "Currency", kind: "text" },
];

export const givingByChapterReport: ReportSpec<
  GivingByChapterFilters,
  GivingByChapterRow
> = {
  id: "giving-by-chapter",
  title: "Giving by chapter",
  description:
    "Posted giving aggregated per chapter, pivoted by giving type, category, or month.",
  filtersSchema: givingByChapterFiltersSchema,
  // Static `columns()` is the safe fallback when the route layer
  // can't resolve dynamic pivot columns (no DB handle). `fetch`
  // returns `columns` on `ReportFetchResult` so the UI / Excel see
  // the resolved set. This mirrors `member-finance-summary.ts`.
  columns: () => [
    ...BASE_COLUMNS,
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
  async fetch(database, ctx, filters): Promise<ReportFetchResult<GivingByChapterRow>> {
    // Resolve optional ministry / partnership year windows. Either
    // can narrow `[dateFrom, dateTo]`. We clamp on the server so the
    // UI doesn't need to compute year boundaries.
    const [ministryWindow, partnershipWindow] = await Promise.all([
      filters.ministryYearId
        ? loadYearWindow(database, ctx.zoneId, "ministry", filters.ministryYearId)
        : Promise.resolve(null),
      filters.partnershipYearId
        ? loadYearWindow(database, ctx.zoneId, "partnership", filters.partnershipYearId)
        : Promise.resolve(null),
    ]);
    if (filters.ministryYearId && !ministryWindow) {
      throw new ReportError("not_found", "Ministry year not found.");
    }
    if (filters.partnershipYearId && !partnershipWindow) {
      throw new ReportError("not_found", "Partnership year not found.");
    }
    const dateFrom = maxDate([filters.dateFrom, ministryWindow?.startDate, partnershipWindow?.startDate]);
    const dateTo = minDate([filters.dateTo, ministryWindow?.endDate, partnershipWindow?.endDate]);
    if (dateFrom > dateTo) {
      // The intersection is empty — return an empty result rather
      // than an error; this is a legitimate "no rows in window" case.
      return {
        rows: [],
        columns: [...BASE_COLUMNS, { key: "total", label: "Total", kind: "money" }],
        subtotals: [],
        meta: { pivotColumns: [] },
      };
    }

    const conditions = [
      eq(contributions.zoneId, ctx.zoneId),
      sql`${contributions.contributionDate} >= ${dateFrom}`,
      sql`${contributions.contributionDate} <= ${dateTo}`,
      sql`${contributions.status} in ('posted', 'reversed')`,
      // Posted contributions that have lost their member (orphan)
      // still belong to a chapter, so we don't filter by member
      // existence here.
    ];
    if (filters.chapterId) {
      conditions.push(eq(contributions.chapterId, filters.chapterId));
    } else if (!isZoneRead(ctx)) {
      conditions.push(inArray(contributions.chapterId, ctx.chapterIds));
    }


    // Pull only what we need to bucket. `givingTypeId`, `categoryId`,
    // and `contributionDate` cover the three pivot modes; we resolve
    // labels in a second query so the dataset query stays narrow.
    const lineRows = await database
      .select({
        chapterId: contributions.chapterId,
        contributionDate: contributions.contributionDate,
        givingTypeId: contributionLines.givingTypeId,
        categoryId: givingTypes.categoryId,
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
        givingTypes,
        and(
          eq(givingTypes.zoneId, contributionLines.zoneId),
          eq(givingTypes.id, contributionLines.givingTypeId),
        ),
      )
      // The member join is intentionally a leftJoin guard so anonymous
      // / unallocated contributions still aggregate by chapter. We
      // skip soft-deleted members entirely though (matches the rest
      // of the report suite — see member-finance-summary.ts).
      .leftJoin(
        members,
        and(eq(members.zoneId, contributions.zoneId), eq(members.id, contributions.memberId)),
      )
      .where(
        and(
          ...conditions,
          // Drop rows whose member was soft-deleted; preserves the
          // "deleted members don't appear in reports" rule from
          // ROADMAP.md Phase 3. The disjunction must be parenthesised
          // so its `or` doesn't escape the surrounding AND-chain;
          // wrap the raw sql in explicit parens.
          sql`(${members.id} is null or ${members.deletedAt} is null)`,
        ),
      );

    // Resolve chapter labels in scope.
    const chapterIds = unique(lineRows.map((r) => r.chapterId));
    const chapterMap = chapterIds.length === 0
      ? new Map<string, { ref: string | null; name: string | null }>()
      : new Map(
          (
            await database
              .select({
                id: chapters.id,
                referenceCode: chapters.referenceCode,
                name: chapters.name,
              })
              .from(chapters)
              .where(
                and(
                  eq(chapters.zoneId, ctx.zoneId),
                  inArray(chapters.id, chapterIds),
                ),
              )
          ).map((c) => [c.id, { ref: c.referenceCode, name: c.name }] as const),
        );

    // Resolve the dynamic pivot column set against the dataset.
    const pivotCols = await resolvePivotColumns(database, ctx.zoneId, filters.pivotBy, lineRows);
    const pivotIdByLine = (r: (typeof lineRows)[number]): string =>
      filters.pivotBy === "givingType"
        ? r.givingTypeId
        : filters.pivotBy === "category"
          ? r.categoryId
          : monthKey(r.contributionDate);
    const pivotKeyById = new Map(pivotCols.map((p) => [p.id, p.key] as const));

    // Aggregate into `(chapterId, currency)` rows × pivot columns.
    const rowKey = (chapterId: string, currencyCode: string) =>
      `${chapterId}|${currencyCode}`;
    const rows = new Map<string, GivingByChapterRow & { _chapterId: string }>();
    const grand = new Map<string, Decimal>();

    for (const line of lineRows) {
      const pivotId = pivotIdByLine(line);
      const pivotKey = pivotKeyById.get(pivotId);
      // A line whose pivot dimension doesn't appear in the resolved
      // columns shouldn't happen — `resolvePivotColumns` derives the
      // set from `lineRows` itself — but skip defensively rather than
      // crash on a future schema change.
      if (!pivotKey) continue;

      const key = rowKey(line.chapterId, line.currencyCode);
      let row = rows.get(key);
      if (!row) {
        const labels = chapterMap.get(line.chapterId) ?? { ref: null, name: null };
        row = {
          _chapterId: line.chapterId,
          chapterReferenceCode: labels.ref,
          chapterName: labels.name,
          currencyCode: line.currencyCode,
          total: "0.0000",
        };
        for (const col of pivotCols) row[col.key] = "0.0000";
        rows.set(key, row);
      }

      const amount = new Decimal(line.amount);
      row[pivotKey] = new Decimal(row[pivotKey] ?? "0").plus(amount).toFixed(4);
      row.total = new Decimal(row.total).plus(amount).toFixed(4);

      const cur = grand.get(line.currencyCode) ?? new Decimal(0);
      grand.set(line.currencyCode, cur.plus(amount));
    }

    const orderedRows = Array.from(rows.values()).sort((a, b) => {
      const refA = a.chapterReferenceCode ?? "";
      const refB = b.chapterReferenceCode ?? "";
      if (refA !== refB) return refA.localeCompare(refB);
      return a.currencyCode.localeCompare(b.currencyCode);
    });
    // Drop the private chapterId before handing rows out.
    for (const r of orderedRows) {
      delete (r as Record<string, unknown>)._chapterId;
    }

    const subtotals: CurrencySubtotal[] = Array.from(grand.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, total]) => ({ currencyCode, total: total.toFixed(4) }));

    return {
      rows: orderedRows,
      columns: buildColumns(pivotCols),
      subtotals,
      meta: {
        pivotBy: filters.pivotBy,
        pivotColumns: pivotCols,
      },
    };
  },
  async excel(rows, subtotals, filters, branding, extras) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const pivotCols = pivotColumnsFromMeta(extras as Record<string, unknown> | undefined);
    const columns = buildColumns(pivotCols);

    const filterParts: string[] = [
      `Period ${filters.dateFrom} -> ${filters.dateTo}`,
      `Pivot by ${filters.pivotBy}`,
    ];
    if (filters.chapterId) filterParts.push(`Chapter ${filters.chapterId}`);
    if (filters.ministryYearId) filterParts.push(`Ministry year ${filters.ministryYearId}`);
    if (filters.partnershipYearId)
      filterParts.push(`Partnership year ${filters.partnershipYearId}`);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Giving by chapter",
      branding,
      reportTitle: "Giving by chapter",
      filterSummary: filterParts.join("  •  "),
      columnCount: columns.length,
    });

    const headerRow = sheet.getRow(6);
    columns.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      // Pivot labels are user-derived (chapter / category / giving
      // type names; month labels are server-built so safe but
      // routed through the helper for uniformity).
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
    sheet.getColumn(2).width = 26; // chapter name

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function buildColumns(pivotCols: PivotColumn[]): ReportColumn[] {
  return [
    ...BASE_COLUMNS,
    ...pivotCols.map((c) => ({
      key: c.key,
      label: c.label,
      kind: "money" as const,
    })),
    { key: "total", label: "Total", kind: "money" as const },
  ];
}

function pivotColumnsFromMeta(extras?: Record<string, unknown>): PivotColumn[] {
  const raw = extras?.pivotColumns;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPivotColumn);
}

function isPivotColumn(value: unknown): value is PivotColumn {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.key === "string" &&
    typeof r.label === "string" &&
    typeof r.sort === "string"
  );
}

function pivotKey(prefix: string, id: string): string {
  return `${prefix}_${id.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7); // YYYY-MM
}

async function resolvePivotColumns(
  database: Database,
  zoneId: string,
  pivotBy: GivingByChapterFilters["pivotBy"],
  lineRows: Array<{
    givingTypeId: string;
    categoryId: string;
    contributionDate: string;
  }>,
): Promise<PivotColumn[]> {
  if (pivotBy === "month") {
    const months = unique(lineRows.map((r) => monthKey(r.contributionDate)));
    return months
      .sort()
      .map((m) => ({
        id: m,
        key: pivotKey("month", m),
        label: m,
        sort: m,
      }));
  }
  if (pivotBy === "givingType") {
    const ids = unique(lineRows.map((r) => r.givingTypeId));
    if (ids.length === 0) return [];
    const rows = await database
      .select({
        id: givingTypes.id,
        name: givingTypes.name,
        shortCode: givingTypes.shortCode,
        isActive: givingTypes.isActive,
        ordinal: givingTypes.ordinal,
      })
      .from(givingTypes)
      .where(
        and(eq(givingTypes.zoneId, zoneId), inArray(givingTypes.id, ids)),
      )
      .orderBy(asc(givingTypes.ordinal), asc(givingTypes.name));
    return rows.map((row) => ({
      id: row.id,
      key: pivotKey("gt", row.id),
      label: formatGivingTypeLabel(row),
      sort: `${String(row.ordinal).padStart(6, "0")}:${row.name}`,
    }));
  }
  // category
  const ids = unique(lineRows.map((r) => r.categoryId));
  if (ids.length === 0) return [];
  const rows = await database
    .select({
      id: givingCategories.id,
      name: givingCategories.name,
      shortCode: givingCategories.shortCode,
      ordinal: givingCategories.ordinal,
    })
    .from(givingCategories)
    .where(
      and(eq(givingCategories.zoneId, zoneId), inArray(givingCategories.id, ids)),
    )
    .orderBy(asc(givingCategories.ordinal), asc(givingCategories.name));
  return rows.map((row) => ({
    id: row.id,
    key: pivotKey("cat", row.id),
    label: row.shortCode ? `${row.shortCode} - ${row.name}` : row.name,
    sort: `${String(row.ordinal).padStart(6, "0")}:${row.name}`,
  }));
}

function formatGivingTypeLabel(row: {
  name: string;
  shortCode: string | null;
  isActive: boolean;
}): string {
  const base = row.shortCode ? `${row.shortCode} - ${row.name}` : row.name;
  return row.isActive ? base : `${base} (inactive)`;
}

async function loadYearWindow(
  database: Database,
  zoneId: string,
  kind: "ministry" | "partnership",
  yearId: string,
): Promise<{ startDate: string; endDate: string } | null> {
  if (kind === "ministry") {
    const [row] = await database
      .select({ startDate: ministryYears.startDate, endDate: ministryYears.endDate })
      .from(ministryYears)
      .where(and(eq(ministryYears.zoneId, zoneId), eq(ministryYears.id, yearId)))
      .limit(1);
    return row ?? null;
  }
  const [row] = await database
    .select({ startDate: partnershipYears.startDate, endDate: partnershipYears.endDate })
    .from(partnershipYears)
    .where(and(eq(partnershipYears.zoneId, zoneId), eq(partnershipYears.id, yearId)))
    .limit(1);
  return row ?? null;
}

function maxDate(candidates: Array<string | null | undefined>): string {
  let m: string | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (m === null || c > m) m = c;
  }
  // At least `filters.dateFrom` is always present, so `m` is never null.
  return m as string;
}

function minDate(candidates: Array<string | null | undefined>): string {
  let m: string | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (m === null || c < m) m = c;
  }
  return m as string;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function isZoneRead(ctx: AuthorizedContext): boolean {
  const chapterCodes: readonly string[] = Object.values(CHAPTER_ROLES);
  return ctx.roleCodes.some((c) => !chapterCodes.includes(c));
}

