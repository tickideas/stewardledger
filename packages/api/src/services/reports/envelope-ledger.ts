// packages/api/src/services/reports/envelope-ledger.ts
// Phase 7 — envelope ledger report (REPORTS.md §2.4).
// One row per posted envelope contribution with the line breakdown
// rolled up inline; chapter / member / date range filters; per-currency
// subtotals.
// RELEVANT FILES: packages/api/src/services/reports/general-ledger.ts, packages/api/src/services/reports/registry.ts, packages/api/src/services/reports/reports.test.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  chapters,
  contributionBatches,
  contributionLines,
  contributions,
  givingTypes,
  members,
  paymentMethods,
  serviceEvents,
  serviceTypes,
} from "@stewardledger/db/schema";
import {
  uuidSchema,
} from "@stewardledger/shared";
import {
  addBrandedSheet,
  escapeExcelText,
  moneyFormatForCurrency,
} from "./branding";
import { hasAnyZoneRole } from "./access";
import {
  ReportError,
  type CurrencySubtotal,
  type ReportColumn,
  type ReportFetchResult,
  type ReportSpec,
} from "./types";

export const envelopeLedgerFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    chapterId: uuidSchema.optional(),
    memberId: uuidSchema.optional(),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type EnvelopeLedgerFilters = z.infer<typeof envelopeLedgerFiltersSchema>;

interface EnvelopeLedgerRow {
  contributionId: string;
  envelopeId: string | null;
  contributionDate: string;
  serviceDate: string | null;
  serviceTypeName: string | null;
  chapterReferenceCode: string | null;
  chapterName: string | null;
  memberReferenceCode: string | null;
  memberName: string | null;
  paymentMethodCode: string | null;
  /** "TITHE 100.0000, OFFERING 25.0000" — server-built, escapeExcelText-safe. */
  linesSummary: string;
  currencyCode: string;
  totalAmount: string;
  status: "posted" | "reversed";
}

const COLUMNS: ReportColumn[] = [
  { key: "envelopeId", label: "Envelope", kind: "text" },
  { key: "contributionDate", label: "Date", kind: "date" },
  { key: "serviceDate", label: "Service date", kind: "date" },
  { key: "serviceTypeName", label: "Service", kind: "text" },
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "memberReferenceCode", label: "Member ref", kind: "text" },
  { key: "memberName", label: "Member", kind: "text" },
  { key: "paymentMethodCode", label: "Payment", kind: "text" },
  { key: "linesSummary", label: "Lines", kind: "text" },
  { key: "currencyCode", label: "Currency", kind: "text" },
  { key: "totalAmount", label: "Total", kind: "money" },
  { key: "status", label: "Status", kind: "text" },
];

export const envelopeLedgerReport: ReportSpec<
  EnvelopeLedgerFilters,
  EnvelopeLedgerRow
> = {
  id: "envelope-ledger",
  title: "Envelope ledger",
  description:
    "One row per posted envelope contribution with the line breakdown rolled up inline.",
  filtersSchema: envelopeLedgerFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx, filters) => {
    if (hasAnyZoneRole(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    if (filters.chapterId && !ctx.chapterIds.includes(filters.chapterId)) {
      return "forbidden";
    }
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<EnvelopeLedgerRow>> {
    // Existence-oracle guard for chapter-scoped callers: if a memberId
    // filter is passed, verify the member exists in one of the
    // caller's bound chapters before running the main query.
    // Otherwise a chapter-scoped caller could probe uuids and learn
    // "this is a real member elsewhere in the zone" by the empty
    // 200 vs error split. Mirrors `member-statement.ts`.
    if (!hasAnyZoneRole(ctx) && filters.memberId) {
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

    const conditions = [
      eq(contributions.zoneId, ctx.zoneId),
      eq(contributions.sourceType, "envelope"),
      sql`${contributions.contributionDate} >= ${filters.dateFrom}`,
      sql`${contributions.contributionDate} <= ${filters.dateTo}`,
      sql`${contributions.status} in ('posted', 'reversed')`,
      // Soft-deleted members vanish; anonymous contributions remain
      // (left-join miss leaves deletedAt NULL too).
      isNull(members.deletedAt),
    ];
    if (filters.chapterId) {
      conditions.push(eq(contributions.chapterId, filters.chapterId));
    } else if (!hasAnyZoneRole(ctx)) {
      conditions.push(inArray(contributions.chapterId, ctx.chapterIds));
    }
    if (filters.memberId) {
      conditions.push(eq(contributions.memberId, filters.memberId));
    }

    // Envelope rows first. The lines query below joins on these ids.
    const envelopeRows = await database
      .select({
        contributionId: contributions.id,
        envelopeReferenceCode: contributions.externalTransactionId,
        batchReferenceCode: contributionBatches.referenceCode,
        contributionDate: contributions.contributionDate,
        serviceDate: serviceEvents.serviceDate,
        serviceTypeName: serviceTypes.name,
        chapterReferenceCode: chapters.referenceCode,
        chapterName: chapters.name,
        memberReferenceCode: members.referenceCode,
        memberFullName: members.fullName,
        memberFirstName: members.firstName,
        memberLastName: members.lastName,
        paymentMethodCode: paymentMethods.code,
        currencyCode: contributions.currencyCode,
        totalAmount: contributions.totalAmount,
        status: contributions.status,
      })
      .from(contributions)
      .leftJoin(
        chapters,
        and(eq(chapters.zoneId, contributions.zoneId), eq(chapters.id, contributions.chapterId)),
      )
      .leftJoin(
        members,
        and(eq(members.zoneId, contributions.zoneId), eq(members.id, contributions.memberId)),
      )
      .leftJoin(
        paymentMethods,
        and(
          eq(paymentMethods.zoneId, contributions.zoneId),
          eq(paymentMethods.id, contributions.paymentMethodId),
        ),
      )
      .leftJoin(
        contributionBatches,
        and(
          eq(contributionBatches.zoneId, contributions.zoneId),
          eq(contributionBatches.id, contributions.batchId),
        ),
      )
      .leftJoin(
        serviceEvents,
        and(
          eq(serviceEvents.zoneId, contributions.zoneId),
          eq(serviceEvents.id, contributions.serviceEventId),
        ),
      )
      .leftJoin(
        serviceTypes,
        and(
          eq(serviceTypes.zoneId, contributions.zoneId),
          eq(serviceTypes.id, serviceEvents.serviceTypeId),
        ),
      )
      .where(and(...conditions))
      .orderBy(
        asc(contributions.contributionDate),
        asc(contributions.id),
      );

    if (envelopeRows.length === 0) {
      return { rows: [], subtotals: [] };
    }

    // Line summaries — one round trip for every envelope id in scope.
    const contributionIds = envelopeRows.map((r) => r.contributionId);
    const lineRows = await database
      .select({
        contributionId: contributionLines.contributionId,
        amount: contributionLines.amount,
        givingTypeShortCode: givingTypes.shortCode,
        givingTypeName: givingTypes.name,
        givingTypeOrdinal: givingTypes.ordinal,
      })
      .from(contributionLines)
      .innerJoin(
        givingTypes,
        and(
          eq(givingTypes.zoneId, contributionLines.zoneId),
          eq(givingTypes.id, contributionLines.givingTypeId),
        ),
      )
      .where(
        and(
          eq(contributionLines.zoneId, ctx.zoneId),
          inArray(contributionLines.contributionId, contributionIds),
        ),
      )
      .orderBy(asc(givingTypes.ordinal), asc(givingTypes.name));

    const linesByContribution = new Map<string, string[]>();
    for (const line of lineRows) {
      const label = `${line.givingTypeShortCode ?? line.givingTypeName} ${new Decimal(line.amount).toFixed(4)}`;
      const bucket = linesByContribution.get(line.contributionId) ?? [];
      bucket.push(label);
      linesByContribution.set(line.contributionId, bucket);
    }

    const grand = new Map<string, Decimal>();
    const mapped: EnvelopeLedgerRow[] = envelopeRows.map((r) => {
      const memberName =
        r.memberFullName ??
        (r.memberFirstName || r.memberLastName
          ? `${r.memberFirstName ?? ""} ${r.memberLastName ?? ""}`.trim()
          : null);
      // Envelope id falls back to the parent batch's reference_code
      // when the contribution itself doesn't carry one. Legacy
      // envelope-batch flows stamp the envelope id on the batch.
      const envelopeId = r.envelopeReferenceCode ?? r.batchReferenceCode ?? null;
      const cur = grand.get(r.currencyCode) ?? new Decimal(0);
      grand.set(r.currencyCode, cur.plus(new Decimal(r.totalAmount)));
      return {
        contributionId: r.contributionId,
        envelopeId,
        contributionDate: r.contributionDate,
        serviceDate: r.serviceDate,
        serviceTypeName: r.serviceTypeName,
        chapterReferenceCode: r.chapterReferenceCode,
        chapterName: r.chapterName,
        memberReferenceCode: r.memberReferenceCode,
        memberName,
        paymentMethodCode: r.paymentMethodCode,
        linesSummary: (linesByContribution.get(r.contributionId) ?? []).join(", "),
        currencyCode: r.currencyCode,
        totalAmount: r.totalAmount,
        status: r.status as EnvelopeLedgerRow["status"],
      };
    });

    const subtotals: CurrencySubtotal[] = Array.from(grand.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, total]) => ({ currencyCode, total: total.toFixed(4) }));

    return { rows: mapped, subtotals };
  },
  async excel(rows, subtotals, filters, branding) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const filterParts: string[] = [`Period ${filters.dateFrom} -> ${filters.dateTo}`];
    if (filters.chapterId) filterParts.push(`Chapter ${filters.chapterId}`);
    if (filters.memberId) filterParts.push(`Member ${filters.memberId}`);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Envelope ledger",
      branding,
      reportTitle: "Envelope ledger",
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

    // Every text cell carries user-controlled data (envelope id,
    // member name, chapter name, lines summary built from short
    // codes). `escapeExcelText` is the single canonical sink.
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
    setWidthByKey(sheet, "memberName", 28);
    setWidthByKey(sheet, "chapterName", 24);
    setWidthByKey(sheet, "linesSummary", 40);

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function setWidthByKey(sheet: ExcelJS.Worksheet, key: string, width: number): void {
  const idx = COLUMNS.findIndex((c) => c.key === key) + 1;
  if (idx > 0) sheet.getColumn(idx).width = width;
}
