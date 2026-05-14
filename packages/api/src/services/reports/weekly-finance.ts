// packages/api/src/services/reports/weekly-finance.ts
// Phase 7 — weekly finance report (REPORTS.md §2.3).
// One row per service event with headcount + cash/cheque + line
// totals, grouped per currency. Legacy mapping:
// ChurchEnvelope_WeeklyFinanceReport_PIVOT,
// ChurchEnvelope_WeeklyFinanceReportView,
// Chapter_WeeklyIncomeAndAttendance.
// RELEVANT FILES: packages/api/src/services/reports/general-ledger.ts, packages/api/src/services/reports/registry.ts, packages/db/src/schema/giving.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  chapters,
  contributionBatches,
  contributionLines,
  contributions,
  serviceEventAttendance,
  serviceEvents,
  serviceTypes,
} from "@stewardledger/db/schema";
import { uuidSchema } from "@stewardledger/shared";
import {
  addBrandedSheet,
  escapeExcelText,
  moneyFormatForCurrency,
} from "./branding";
import { hasAnyZoneRole } from "./access";
import type {
  CurrencySubtotal,
  ReportColumn,
  ReportFetchResult,
  ReportSpec,
} from "./types";

export const weeklyFinanceFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    chapterId: uuidSchema.optional(),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type WeeklyFinanceFilters = z.infer<typeof weeklyFinanceFiltersSchema>;

interface WeeklyFinanceRow {
  serviceEventId: string;
  serviceDate: string;
  weekInMonth: number;
  serviceTypeName: string;
  chapterReferenceCode: string | null;
  chapterName: string | null;
  men: number;
  women: number;
  teens: number;
  children: number;
  firstTimers: number;
  newConverts: number;
  totalAttendance: number;
  cashTotal: string;
  chequeTotal: string;
  lineTotal: string;
  currencyCode: string;
}

const COLUMNS: ReportColumn[] = [
  { key: "serviceDate", label: "Service date", kind: "date" },
  { key: "weekInMonth", label: "Week", kind: "number" },
  { key: "serviceTypeName", label: "Service type", kind: "text" },
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "men", label: "Men", kind: "number" },
  { key: "women", label: "Women", kind: "number" },
  { key: "teens", label: "Teens", kind: "number" },
  { key: "children", label: "Children", kind: "number" },
  { key: "firstTimers", label: "First timers", kind: "number" },
  { key: "newConverts", label: "New converts", kind: "number" },
  { key: "totalAttendance", label: "Total attendance", kind: "number" },
  { key: "cashTotal", label: "Cash", kind: "money" },
  { key: "chequeTotal", label: "Cheque", kind: "money" },
  { key: "lineTotal", label: "Line total", kind: "money" },
  { key: "currencyCode", label: "Currency", kind: "text" },
];

/**
 * Week-in-month: 1 for days 1-7, 2 for 8-14, etc. Matches the legacy
 * report's grouping. Counts strictly by day-of-month, not by ISO
 * week — a service on the 1st is always "week 1" regardless of the
 * weekday alignment.
 */
function weekInMonth(isoDate: string): number {
  const day = Number(isoDate.slice(8, 10));
  return Math.ceil(day / 7);
}

export const weeklyFinanceReport: ReportSpec<
  WeeklyFinanceFilters,
  WeeklyFinanceRow
> = {
  id: "weekly-finance",
  title: "Weekly finance",
  description:
    "Per-service-event headcount and giving totals, grouped per currency.",
  filtersSchema: weeklyFinanceFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx, filters) => {
    if (hasAnyZoneRole(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    if (filters.chapterId && !ctx.chapterIds.includes(filters.chapterId)) {
      return "forbidden";
    }
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<WeeklyFinanceRow>> {
    // Service events in window, scoped to (zone, chapter). Chapter-
    // scoped readers without an explicit filter see only events
    // bound to one of their chapters.
    const eventConditions = [
      eq(serviceEvents.zoneId, ctx.zoneId),
      sql`${serviceEvents.serviceDate} >= ${filters.dateFrom}::date`,
      sql`${serviceEvents.serviceDate} <= ${filters.dateTo}::date`,
    ];
    if (filters.chapterId) {
      eventConditions.push(eq(serviceEvents.chapterId, filters.chapterId));
    } else if (!hasAnyZoneRole(ctx)) {
      eventConditions.push(inArray(serviceEvents.chapterId, ctx.chapterIds));
    }

    const eventRows = await database
      .select({
        id: serviceEvents.id,
        serviceDate: serviceEvents.serviceDate,
        chapterId: serviceEvents.chapterId,
        chapterReferenceCode: chapters.referenceCode,
        chapterName: chapters.name,
        serviceTypeName: serviceTypes.name,
        men: serviceEventAttendance.men,
        women: serviceEventAttendance.women,
        teens: serviceEventAttendance.teens,
        children: serviceEventAttendance.children,
        firstTimers: serviceEventAttendance.firstTimers,
        newConverts: serviceEventAttendance.newConverts,
      })
      .from(serviceEvents)
      .innerJoin(
        serviceTypes,
        and(
          eq(serviceTypes.zoneId, serviceEvents.zoneId),
          eq(serviceTypes.id, serviceEvents.serviceTypeId),
        ),
      )
      .leftJoin(
        chapters,
        and(
          eq(chapters.zoneId, serviceEvents.zoneId),
          eq(chapters.id, serviceEvents.chapterId),
        ),
      )
      // Attendance is optional — a chapter that hasn't recorded
      // headcount still appears in the report with zero counts.
      .leftJoin(
        serviceEventAttendance,
        and(
          eq(serviceEventAttendance.zoneId, serviceEvents.zoneId),
          eq(serviceEventAttendance.serviceEventId, serviceEvents.id),
        ),
      )
      .where(and(...eventConditions))
      .orderBy(
        sql`${chapters.referenceCode} asc nulls last`,
        asc(serviceEvents.serviceDate),
        asc(serviceTypes.name),
      );

    if (eventRows.length === 0) {
      return { rows: [], subtotals: [] };
    }

    const eventIds = eventRows.map((e) => e.id);

    // Batch totals attributed to each event: sum cash + cheque per
    // (event, currency). The (zone_id, service_event_id) join scopes
    // to in-window events; status filter excludes voided batches.
    const batchTotals = await database
      .select({
        serviceEventId: contributionBatches.serviceEventId,
        currencyCode: contributionBatches.currencyCode,
        cashTotal: sql<string>`coalesce(sum(${contributionBatches.cashTotal}), 0)::text`,
        chequeTotal: sql<string>`coalesce(sum(${contributionBatches.chequeTotal}), 0)::text`,
      })
      .from(contributionBatches)
      .where(
        and(
          eq(contributionBatches.zoneId, ctx.zoneId),
          inArray(contributionBatches.serviceEventId, eventIds),
          sql`${contributionBatches.status} <> 'voided'`,
        ),
      )
      .groupBy(contributionBatches.serviceEventId, contributionBatches.currencyCode);

    // Line totals attributed to each event. A contribution may carry
    // `service_event_id` directly OR inherit it from its batch. We
    // join both paths and filter with an OR so neither dimension is
    // missed; the GROUP BY then coalesces in app code below.
    const lineRows = await database
      .select({
        contributionEventId: contributions.serviceEventId,
        batchEventId: contributionBatches.serviceEventId,
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
      .leftJoin(
        contributionBatches,
        and(
          eq(contributionBatches.zoneId, contributions.zoneId),
          eq(contributionBatches.id, contributions.batchId),
        ),
      )
      .where(
        and(
          eq(contributions.zoneId, ctx.zoneId),
          sql`${contributions.status} in ('posted', 'reversed')`,
          or(
            inArray(contributions.serviceEventId, eventIds),
            inArray(contributionBatches.serviceEventId, eventIds),
          )!,
        ),
      )
      .groupBy(
        contributions.serviceEventId,
        contributionBatches.serviceEventId,
        contributionLines.currencyCode,
      );

    // Build (eventId, currency) → totals map. We emit one row per
    // (event, currency) so a single event with mixed-currency batches
    // (rare but legal) yields multiple rows.
    interface Bucket {
      cashTotal: Decimal;
      chequeTotal: Decimal;
      lineTotal: Decimal;
    }
    const byKey = new Map<string, Bucket>();
    const key = (eventId: string, currencyCode: string) => `${eventId}|${currencyCode}`;
    for (const t of batchTotals) {
      if (!t.serviceEventId) continue;
      const k = key(t.serviceEventId, t.currencyCode);
      const b = byKey.get(k) ?? {
        cashTotal: new Decimal(0),
        chequeTotal: new Decimal(0),
        lineTotal: new Decimal(0),
      };
      b.cashTotal = b.cashTotal.plus(new Decimal(t.cashTotal));
      b.chequeTotal = b.chequeTotal.plus(new Decimal(t.chequeTotal));
      byKey.set(k, b);
    }
    for (const l of lineRows) {
      // Effective event id: contribution-level wins, batch is the
      // fallback. Mirrors the legacy report's allocation rule.
      const effective = l.contributionEventId ?? l.batchEventId;
      if (!effective) continue;
      const k = key(effective, l.currencyCode);
      const b = byKey.get(k) ?? {
        cashTotal: new Decimal(0),
        chequeTotal: new Decimal(0),
        lineTotal: new Decimal(0),
      };
      b.lineTotal = b.lineTotal.plus(new Decimal(l.total));
      byKey.set(k, b);
    }

    const rows: WeeklyFinanceRow[] = [];
    const grand = new Map<string, Decimal>();
    for (const e of eventRows) {
      const men = e.men ?? 0;
      const women = e.women ?? 0;
      const teens = e.teens ?? 0;
      const children = e.children ?? 0;
      const firstTimers = e.firstTimers ?? 0;
      const newConverts = e.newConverts ?? 0;
      // Find every (event, currency) bucket for this event. If none
      // exist (event with no batch + no contributions), emit a single
      // row in the zone's behaviour-irrelevant placeholder currency
      // so the headcount still surfaces. Cleaner: skip the row;
      // simpler for ops: leave it visible with zeros.
      const bucketKeys = Array.from(byKey.keys()).filter((k) => k.startsWith(`${e.id}|`));
      if (bucketKeys.length === 0) {
        rows.push({
          serviceEventId: e.id,
          serviceDate: e.serviceDate,
          weekInMonth: weekInMonth(e.serviceDate),
          serviceTypeName: e.serviceTypeName,
          chapterReferenceCode: e.chapterReferenceCode,
          chapterName: e.chapterName,
          men,
          women,
          teens,
          children,
          firstTimers,
          newConverts,
          totalAttendance: men + women + teens + children + firstTimers + newConverts,
          cashTotal: "0.0000",
          chequeTotal: "0.0000",
          lineTotal: "0.0000",
          currencyCode: "",
        });
        continue;
      }
      for (const k of bucketKeys) {
        const currencyCode = k.split("|")[1];
        const b = byKey.get(k)!;
        rows.push({
          serviceEventId: e.id,
          serviceDate: e.serviceDate,
          weekInMonth: weekInMonth(e.serviceDate),
          serviceTypeName: e.serviceTypeName,
          chapterReferenceCode: e.chapterReferenceCode,
          chapterName: e.chapterName,
          men,
          women,
          teens,
          children,
          firstTimers,
          newConverts,
          totalAttendance: men + women + teens + children + firstTimers + newConverts,
          cashTotal: b.cashTotal.toFixed(4),
          chequeTotal: b.chequeTotal.toFixed(4),
          lineTotal: b.lineTotal.toFixed(4),
          currencyCode,
        });
        // Per-currency grand total uses the line total (the
        // contribution-line truth) rather than cash+cheque, mirroring
        // the legacy report.
        const cur = grand.get(currencyCode) ?? new Decimal(0);
        grand.set(currencyCode, cur.plus(b.lineTotal));
      }
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

    const filterParts: string[] = [`Period ${filters.dateFrom} -> ${filters.dateTo}`];
    if (filters.chapterId) filterParts.push(`Chapter ${filters.chapterId}`);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Weekly finance",
      branding,
      reportTitle: "Weekly finance",
      filterSummary: filterParts.join("  •  "),
      columnCount: COLUMNS.length,
    });

    const headerRow = sheet.getRow(6);
    COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true };
      cell.alignment = {
        horizontal: col.kind === "money" || col.kind === "number" ? "right" : "left",
      };
    });
    headerRow.commit();

    // Every text column (service type, chapter name) is user-
    // controlled; route through `escapeExcelText` to neutralise
    // formula-injection prefixes.
    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      COLUMNS.forEach((col, i) => {
        const cell = dataRow.getCell(i + 1);
        const value = (row as unknown as Record<string, unknown>)[col.key];
        if (col.kind === "money" && typeof value === "string") {
          cell.value = Number(new Decimal(value).toFixed(4));
          if (row.currencyCode) cell.numFmt = moneyFormatForCurrency(row.currencyCode);
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
      head.getCell(1).value = "Totals per currency (line total)";
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
      width: col.kind === "money" ? 14 : col.kind === "number" ? 12 : 18,
    }));
    setWidthByKey(sheet, "serviceTypeName", 22);
    setWidthByKey(sheet, "chapterName", 24);
    setWidthByKey(sheet, "totalAttendance", 16);

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function setWidthByKey(sheet: ExcelJS.Worksheet, key: string, width: number): void {
  const idx = COLUMNS.findIndex((c) => c.key === key) + 1;
  if (idx > 0) sheet.getColumn(idx).width = width;
}
