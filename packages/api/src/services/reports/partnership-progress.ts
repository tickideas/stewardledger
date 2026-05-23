// packages/api/src/services/reports/partnership-progress.ts
// Phase 8 — partnership progress report (REPORTS.md §2.10).
// One row per `financial_targets` row in scope, with target vs
// achieved totals + percent progress + weekly / monthly averages
// + projected end-of-year. Last unimplemented v1 report — closes
// REPORTS.md §2 once it ships.
// RELEVANT FILES: packages/db/src/schema/targets.ts, packages/api/src/services/reports/top-partners.ts, packages/api/src/services/reports/registry.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  chapters,
  contributionLines,
  contributions,
  financialTargets,
  givingTypes,
  ministryYears,
} from "@stewardledger/db/schema";
import { uuidSchema } from "@stewardledger/shared";
import {
  addBrandedSheet,
  escapeExcelText,
  moneyFormatForCurrency,
} from "./branding";
import { reportVisibleScope } from "./access";
import type {
  ReportColumn,
  ReportFetchResult,
  ReportSpec,
} from "./types";

export const partnershipProgressFiltersSchema = z.object({
  ministryYearId: uuidSchema,
  chapterId: uuidSchema.optional(),
  givingTypeId: uuidSchema.optional(),
});
export type PartnershipProgressFilters = z.infer<typeof partnershipProgressFiltersSchema>;

interface PartnershipProgressRow {
  targetId: string;
  chapterReferenceCode: string | null;
  chapterName: string;
  givingTypeShortCode: string | null;
  givingTypeName: string;
  ministryYearLabel: string;
  currencyCode: string;
  fullTarget: string;
  monthlyTarget: string | null;
  weeklyBreakdown: string | null;
  achieved: string;
  percentProgress: string;
  weeklyAverageActual: string;
  monthlyAverageActual: string;
  projectedFullYear: string;
  fullTargetCopies: number | null;
  numberOfPartners: number | null;
}

const COLUMNS: ReportColumn[] = [
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "givingTypeShortCode", label: "Type code", kind: "text" },
  { key: "givingTypeName", label: "Giving type", kind: "text" },
  { key: "ministryYearLabel", label: "Ministry year", kind: "text" },
  { key: "currencyCode", label: "Currency", kind: "text" },
  { key: "fullTarget", label: "Target", kind: "money" },
  { key: "monthlyTarget", label: "Monthly target", kind: "money" },
  { key: "weeklyBreakdown", label: "Weekly target", kind: "money" },
  { key: "achieved", label: "Achieved", kind: "money" },
  { key: "percentProgress", label: "% progress", kind: "text" },
  { key: "weeklyAverageActual", label: "Weekly avg", kind: "money" },
  { key: "monthlyAverageActual", label: "Monthly avg", kind: "money" },
  { key: "projectedFullYear", label: "Projected EOY", kind: "money" },
  { key: "fullTargetCopies", label: "Target copies", kind: "number" },
  { key: "numberOfPartners", label: "Partners", kind: "number" },
];

const PERCENT_DISPLAY_CAP = new Decimal("999.9");

export const partnershipProgressReport: ReportSpec<
  PartnershipProgressFilters,
  PartnershipProgressRow
> = {
  id: "partnership-progress",
  title: "Partnership progress",
  description:
    "Per-target progress against goal for partnership giving types over a ministry year.",
  filtersSchema: partnershipProgressFiltersSchema,
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
  async fetch(
    database,
    ctx,
    filters,
  ): Promise<ReportFetchResult<PartnershipProgressRow>> {
    // Resolve the ministry year up front so we can use its date
    // range to clamp achieved-side contributions and to compute
    // elapsed-week / elapsed-month divisors for the average +
    // projection columns.
    const [year] = await database
      .select({
        id: ministryYears.id,
        yearLabel: ministryYears.yearLabel,
        startDate: ministryYears.startDate,
        endDate: ministryYears.endDate,
      })
      .from(ministryYears)
      .where(
        and(
          eq(ministryYears.zoneId, ctx.zoneId),
          eq(ministryYears.id, filters.ministryYearId),
        ),
      )
      .limit(1);
    if (!year) {
      return { rows: [], subtotals: [] };
    }

    // Eligible targets: rows in `financial_targets` for this
    // ministry year whose giving type carries the partnership
    // tag. Both chapter-scoped and zone-wide rows are eligible;
    // a chapter-scoped reader filters out other chapters' rows
    // app-side (the SQL clamp would also need the access-check's
    // chapter list, which is simpler to enforce post-fetch given
    // zone-wide rows must remain visible to chapter readers).
    const targetConditions = [
      eq(financialTargets.zoneId, ctx.zoneId),
      eq(financialTargets.ministryYearId, filters.ministryYearId),
      eq(givingTypes.hasPartnershipTarget, true),
    ];
    if (filters.givingTypeId) {
      targetConditions.push(eq(financialTargets.givingTypeId, filters.givingTypeId));
    }
    if (filters.chapterId) {
      // When a chapter is filtered explicitly we include that
      // chapter's targets and the zone-wide rows (which apply to
      // every chapter, including this one). Without the OR we'd
      // hide zone-wide policy from the chapter view.
      targetConditions.push(
        sql`(${financialTargets.chapterId} = ${filters.chapterId} or ${financialTargets.chapterId} is null)`,
      );
    } else {
      const scope = await reportVisibleScope(ctx);
      if (scope.kind === "list" && scope.ids.length > 0) {
        // Chapter/group-scoped reader without an explicit chapter filter:
        // their bound chapters' targets + zone-wide rows.
        targetConditions.push(
          sql`(${financialTargets.chapterId} = any(array[${sql.join(
            scope.ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[]) or ${financialTargets.chapterId} is null)`,
        );
      }
    }

    const targetRows = await database
      .select({
        id: financialTargets.id,
        chapterId: financialTargets.chapterId,
        givingTypeId: financialTargets.givingTypeId,
        currencyCode: financialTargets.currencyCode,
        fullTarget: financialTargets.fullTarget,
        monthlyTarget: financialTargets.monthlyTarget,
        weeklyBreakdown: financialTargets.weeklyBreakdown,
        fullTargetCopies: financialTargets.fullTargetCopies,
        numberOfPartners: financialTargets.numberOfPartners,
        chapterReferenceCode: chapters.referenceCode,
        chapterName: chapters.name,
        givingTypeShortCode: givingTypes.shortCode,
        givingTypeName: givingTypes.name,
      })
      .from(financialTargets)
      .innerJoin(
        givingTypes,
        and(
          eq(givingTypes.zoneId, financialTargets.zoneId),
          eq(givingTypes.id, financialTargets.givingTypeId),
        ),
      )
      .leftJoin(
        chapters,
        and(
          eq(chapters.zoneId, financialTargets.zoneId),
          eq(chapters.id, financialTargets.chapterId),
        ),
      )
      .where(and(...targetConditions))
      .orderBy(
        sql`${chapters.referenceCode} asc nulls first`,
        asc(givingTypes.name),
      );

    if (targetRows.length === 0) {
      return { rows: [], subtotals: [] };
    }

    // Achieved totals: sum posted + reversed contribution lines
    // in the ministry-year window, grouped per
    // (chapter_id, giving_type_id, currency_code). One scan
    // serves every target row; the build loop matches each
    // target to its bucket.
    const givingTypeIds = Array.from(new Set(targetRows.map((t) => t.givingTypeId)));
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
      .where(
        and(
          eq(contributions.zoneId, ctx.zoneId),
          sql`${contributions.contributionDate} >= ${year.startDate}::date`,
          sql`${contributions.contributionDate} <= ${year.endDate}::date`,
          sql`${contributions.status} in ('posted', 'reversed')`,
          inArray(contributionLines.givingTypeId, givingTypeIds),
        ),
      )
      .groupBy(
        contributions.chapterId,
        contributionLines.givingTypeId,
        contributionLines.currencyCode,
      );

    // Bucket per (chapter|null, givingType, currency). Chapter-
    // scoped targets read their chapter's bucket; zone-wide
    // targets aggregate every chapter's bucket for the same
    // giving type + currency.
    interface Bucket {
      total: Decimal;
    }
    const byKey = new Map<string, Bucket>();
    const zoneTotalByKey = new Map<string, Bucket>();
    for (const r of achievedRows) {
      if (!r.chapterId || !r.givingTypeId) continue;
      const amount = new Decimal(r.amount);
      const chapterKey = `${r.chapterId}|${r.givingTypeId}|${r.currencyCode}`;
      byKey.set(chapterKey, { total: amount });
      const zoneKey = `${r.givingTypeId}|${r.currencyCode}`;
      const existing = zoneTotalByKey.get(zoneKey)?.total ?? new Decimal(0);
      zoneTotalByKey.set(zoneKey, { total: existing.plus(amount) });
    }

    // Date-math helpers for the average + projection columns.
    // Elapsed-units are clamped to [1, total] so a brand-new
    // ministry year (week 1) doesn't divide by zero, and a
    // year-end run doesn't claim "projected = achieved × 1".
    const totalDays = daysBetween(year.startDate, year.endDate) + 1; // inclusive
    const totalWeeks = totalDays / 7;
    const totalMonths = monthsBetween(year.startDate, year.endDate);
    const today = isoDateToday();
    const cappedEnd = today <= year.endDate ? today : year.endDate;
    const elapsedDays = Math.max(1, daysBetween(year.startDate, cappedEnd) + 1);
    const elapsedWeeks = Math.max(1, elapsedDays / 7);
    const elapsedMonths = Math.max(1, monthsBetween(year.startDate, cappedEnd));

    // Subtotal note: this report intentionally does NOT emit a
    // per-currency "sum of achieved" footer the way the ledger
    // reports do. Zone-wide and chapter-scoped targets can overlap
    // (a zone-wide TITHE target's achieved already includes every
    // chapter's TITHE), so summing achieved across rows would
    // double-count the contributions visible to multiple targets.
    // The per-row achieved figure is the canonical answer.
    const rows: PartnershipProgressRow[] = [];
    for (const t of targetRows) {
      const isZoneWide = t.chapterId === null;
      const achievedDec = isZoneWide
        ? zoneTotalByKey.get(`${t.givingTypeId}|${t.currencyCode}`)?.total ??
          new Decimal(0)
        : byKey.get(`${t.chapterId}|${t.givingTypeId}|${t.currencyCode}`)?.total ??
          new Decimal(0);
      const targetDec = new Decimal(t.fullTarget);

      const percentDec = targetDec.isZero()
        ? new Decimal(0)
        : achievedDec.dividedBy(targetDec).times(100);
      const percentDisplay = percentDec.greaterThan(PERCENT_DISPLAY_CAP)
        ? PERCENT_DISPLAY_CAP
        : percentDec;

      const weeklyAvg = achievedDec.dividedBy(elapsedWeeks);
      const monthlyAvg = achievedDec.dividedBy(elapsedMonths);
      const projected = weeklyAvg.times(totalWeeks);

      rows.push({
        targetId: t.id,
        chapterReferenceCode: t.chapterReferenceCode,
        chapterName: isZoneWide ? "All chapters" : t.chapterName ?? "—",
        givingTypeShortCode: t.givingTypeShortCode,
        givingTypeName: t.givingTypeName,
        ministryYearLabel: year.yearLabel,
        currencyCode: t.currencyCode,
        fullTarget: targetDec.toFixed(4),
        monthlyTarget: t.monthlyTarget,
        weeklyBreakdown: t.weeklyBreakdown,
        achieved: achievedDec.toFixed(4),
        percentProgress: `${percentDisplay.toFixed(1)}%`,
        weeklyAverageActual: weeklyAvg.toFixed(4),
        monthlyAverageActual: monthlyAvg.toFixed(4),
        projectedFullYear: projected.toFixed(4),
        fullTargetCopies: t.fullTargetCopies,
        numberOfPartners: t.numberOfPartners,
      });
    }

    void totalMonths;
    return { rows, subtotals: [] };
  },
  async excel(rows, subtotals, filters, branding) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const filterParts: string[] = [`Ministry year ${filters.ministryYearId}`];
    if (filters.chapterId) filterParts.push(`Chapter ${filters.chapterId}`);
    if (filters.givingTypeId) filterParts.push(`Giving type ${filters.givingTypeId}`);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Partnership progress",
      branding,
      reportTitle: "Partnership progress",
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

    // Every text column (chapter name, giving type name) is user-
    // controlled; route through `escapeExcelText` so a poisoned
    // label can't smuggle a formula into the workbook.
    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      COLUMNS.forEach((col, i) => {
        const cell = dataRow.getCell(i + 1);
        const value = (row as unknown as Record<string, unknown>)[col.key];
        if (col.kind === "money" && typeof value === "string") {
          cell.value = Number(new Decimal(value).toFixed(4));
          cell.numFmt = moneyFormatForCurrency(row.currencyCode);
        } else if (col.kind === "money" && value === null) {
          cell.value = null;
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
      head.getCell(1).value = "Achieved totals per currency";
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
    setWidthByKey(sheet, "chapterName", 22);
    setWidthByKey(sheet, "givingTypeName", 22);

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function setWidthByKey(sheet: ExcelJS.Worksheet, key: string, width: number): void {
  const idx = COLUMNS.findIndex((c) => c.key === key) + 1;
  if (idx > 0) sheet.getColumn(idx).width = width;
}

/** Inclusive day count between two ISO dates. */
function daysBetween(startIso: string, endIso: string): number {
  const start = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(endIso.slice(0, 4)),
    Number(endIso.slice(5, 7)) - 1,
    Number(endIso.slice(8, 10)),
  );
  return Math.round((end - start) / 86_400_000);
}

/** Month count between two ISO dates (calendar-aware, 1-based inclusive). */
function monthsBetween(startIso: string, endIso: string): number {
  const sy = Number(startIso.slice(0, 4));
  const sm = Number(startIso.slice(5, 7));
  const ey = Number(endIso.slice(0, 4));
  const em = Number(endIso.slice(5, 7));
  return (ey - sy) * 12 + (em - sm) + 1;
}

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}
