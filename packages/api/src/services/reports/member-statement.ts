// packages/api/src/services/reports/member-statement.ts
// Phase 7 — annual / range member statement (REPORTS.md §2.1).
//
// Pivots a member's posted contributions over a date range by line:
// one row per `contribution_line` (giving type / account / payment
// method / source). Per-currency subtotals always; reports never
// silently FX-convert (DOMAIN-MODEL.md §6).
//
// Voided + reversed parents are excluded by default. The corrective
// reversal contribution itself (negative amount, `status='posted'`,
// `reversal_of_contribution_id` set) IS included so the running total
// nets to zero — same semantics as the Phase 5 statement preview at
// `/members/[id]/statement`.

import Decimal from "decimal.js";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  contributionLines,
  contributions,
  givingTypes,
  members,
  paymentMethods,
  serviceEvents,
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
  type ReportBranding,
  type ReportColumn,
  type ReportFetchResult,
  type ReportSpec,
} from "./types";

export const memberStatementFiltersSchema = z
  .object({
    memberId: uuidSchema,
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    includeVoided: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((v) => (typeof v === "boolean" ? v : v === "true"))
      .optional()
      .default(false),
  })
  // ISO yyyy-mm-dd strings compare lexicographically the same as
  // chronologically, so a string compare is sufficient. We reject
  // rather than silently swap so the filter banner in the Excel
  // header always shows the range that actually ran.
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type MemberStatementFilters = z.infer<typeof memberStatementFiltersSchema>;

interface MemberStatementRow {
  contributionId: string;
  contributionDate: string;
  serviceEventDate: string | null;
  givingTypeName: string;
  givingTypeShortCode: string | null;
  paymentMethodCode: string | null;
  sourceType: string;
  amount: string; // signed decimal string (4dp)
  currencyCode: string;
  status: "posted" | "voided" | "reversed";
  description: string | null;
}

interface MemberStatementMeta {
  member: {
    id: string;
    referenceCode: string;
    fullName: string;
    chapterId: string | null;
  };
  dateRange: { from: string; to: string };
}

const COLUMNS: ReportColumn[] = [
  { key: "contributionDate", label: "Date", kind: "date" },
  { key: "serviceEventDate", label: "Service date", kind: "date" },
  { key: "givingTypeName", label: "Giving type", kind: "text" },
  { key: "givingTypeShortCode", label: "Code", kind: "text" },
  { key: "paymentMethodCode", label: "Payment", kind: "text" },
  { key: "sourceType", label: "Source", kind: "text" },
  { key: "amount", label: "Amount", kind: "money" },
  { key: "currencyCode", label: "Currency", kind: "text" },
  { key: "status", label: "Status", kind: "text" },
  { key: "description", label: "Description", kind: "text" },
];

export const memberStatementReport: ReportSpec<
  MemberStatementFilters,
  MemberStatementRow
> = {
  id: "member-statement",
  title: "Member statement",
  description:
    "All posted contributions for one member, grouped by line and totalled per currency.",
  filtersSchema: memberStatementFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx, _filters) => {
    // Zone-wide readers can pull a statement for any member; chapter
    // readers must own at least one chapter binding (the per-member
    // home-chapter check happens in `fetch`, where we have a DB
    // handle). Without bindings there is no scope to evaluate.
    if (isZoneRead(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<MemberStatementRow>> {
    // dateFrom <= dateTo is asserted by the schema's refine().
    const [member] = await database
      .select({
        id: members.id,
        referenceCode: members.referenceCode,
        fullName: members.fullName,
        chapterId: members.chapterId,
      })
      .from(members)
      .where(
        and(
          eq(members.zoneId, ctx.zoneId),
          eq(members.id, filters.memberId),
          isNull(members.deletedAt),
        ),
      )
      .limit(1);
    if (!member) {
      return { rows: [], subtotals: [], meta: undefined };
    }
    // Chapter-scoped users: deny if the member's home chapter isn't
    // in their bindings. Returning empty would still leak existence
    // ("this id resolves to a member, just one I can't see"); throw a
    // ReportError("forbidden") so the route maps it to a 403 with the
    // same envelope the member-list path uses.
    if (!isZoneRead(ctx) && (!member.chapterId || !ctx.chapterIds.includes(member.chapterId))) {
      throw new ReportError("forbidden", "Member is not in your chapter scope.");
    }

    const statusFilter = filters.includeVoided
      ? sql`${contributions.status} in ('posted', 'voided', 'reversed')`
      : sql`${contributions.status} in ('posted', 'reversed')`;
    const rows = await database
      .select({
        contributionId: contributions.id,
        contributionDate: contributions.contributionDate,
        serviceEventDate: serviceEvents.serviceDate,
        givingTypeName: givingTypes.name,
        givingTypeShortCode: givingTypes.shortCode,
        paymentMethodCode: paymentMethods.code,
        sourceType: contributions.sourceType,
        amount: contributionLines.amount,
        currencyCode: contributionLines.currencyCode,
        status: contributions.status,
        description: contributions.description,
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
        paymentMethods,
        and(
          eq(paymentMethods.zoneId, contributions.zoneId),
          eq(paymentMethods.id, contributions.paymentMethodId),
        ),
      )
      .leftJoin(
        serviceEvents,
        and(
          eq(serviceEvents.zoneId, contributions.zoneId),
          eq(serviceEvents.id, contributions.serviceEventId),
        ),
      )
      .where(
        and(
          eq(contributions.zoneId, ctx.zoneId),
          eq(contributions.memberId, filters.memberId),
          sql`${contributions.contributionDate} >= ${filters.dateFrom}`,
          sql`${contributions.contributionDate} <= ${filters.dateTo}`,
          statusFilter,
        ),
      )
      .orderBy(asc(contributions.contributionDate), asc(contributions.createdAt));

    const subtotals = summarisePerCurrency(rows.map((r) => ({
      amount: r.amount,
      currencyCode: r.currencyCode,
    })));

    const meta: MemberStatementMeta = {
      member: {
        id: member.id,
        referenceCode: member.referenceCode,
        fullName: member.fullName ?? `${member.referenceCode}`,
        chapterId: member.chapterId,
      },
      dateRange: { from: filters.dateFrom, to: filters.dateTo },
    };

    return {
      rows: rows.map((r) => ({
        contributionId: r.contributionId,
        contributionDate: r.contributionDate,
        serviceEventDate: r.serviceEventDate,
        givingTypeName: r.givingTypeName,
        givingTypeShortCode: r.givingTypeShortCode,
        paymentMethodCode: r.paymentMethodCode,
        sourceType: r.sourceType,
        amount: r.amount,
        currencyCode: r.currencyCode,
        status: r.status as MemberStatementRow["status"],
        description: r.description,
      })),
      subtotals,
      meta: meta as unknown as Record<string, unknown>,
    };
  },
  async excel(rows, subtotals, filters, branding, extras) {
    const meta = extras as unknown as MemberStatementMeta | undefined;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = `StewardLedger — ${branding.zoneName}`;
    workbook.created = new Date();

    const filterSummary = [
      `Member: ${meta?.member.fullName ?? filters.memberId}`,
      `Period: ${filters.dateFrom} → ${filters.dateTo}`,
      filters.includeVoided ? "Includes voided" : "Excludes voided",
    ].join("  •  ");

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Statement",
      branding,
      reportTitle: "Member statement",
      filterSummary,
      columnCount: COLUMNS.length,
    });

    // Column headers on row 6.
    const headerRow = sheet.getRow(6);
    COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true };
      cell.alignment = { horizontal: col.kind === "money" ? "right" : "left" };
    });
    headerRow.commit();

    // Data rows start at row 7. Every text-cell write goes through
    // `escapeExcelText` so a contribution `description` like
    // `=HYPERLINK("https://attacker/x","click me")` lands as literal
    // text instead of an active formula when opened in Excel.
    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      COLUMNS.forEach((col, i) => {
        const cell = dataRow.getCell(i + 1);
        const value = (row as unknown as Record<string, unknown>)[col.key];
        if (col.kind === "money" && typeof value === "string") {
          cell.value = Number(new Decimal(value).toFixed(4));
          cell.numFmt = moneyFormatForCurrency(row.currencyCode);
        } else if (col.kind === "date" && typeof value === "string") {
          // ISO date strings (yyyy-mm-dd) can't start with =/+/-/@, so
          // they're never formula-poisoned, but route through the
          // helper anyway for uniformity.
          cell.value = escapeExcelText(value);
        } else if (typeof value === "string") {
          cell.value = escapeExcelText(value);
        } else {
          cell.value = (value as ExcelJS.CellValue) ?? null;
        }
      });
      dataRow.commit();
      r += 1;
    }

    // Per-currency subtotals.
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

    // Reasonable column widths so the workbook is readable on open.
    sheet.columns = COLUMNS.map((col) => ({
      header: undefined,
      key: col.key,
      width: col.kind === "text" ? 22 : 14,
    }));
    // Stretch the description column.
    const descIdx = COLUMNS.findIndex((c) => c.key === "description") + 1;
    if (descIdx > 0) sheet.getColumn(descIdx).width = 40;

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function isZoneRead(ctx: AuthorizedContext): boolean {
  // Anything not chapter-scoped is zone-wide for read purposes; access.ts
  // owns the canonical role list. We re-derive here to avoid a cycle.
  const chapterCodes: readonly string[] = Object.values(CHAPTER_ROLES);
  // If the user holds ANY non-chapter role, they're zone-wide.
  return ctx.roleCodes.some((c) => !chapterCodes.includes(c));
}

/**
 * Aggregate signed amounts per currency. Reversals carry negative
 * amounts so the running total nets to zero when the original + its
 * reversal both fall inside the date range.
 */
function summarisePerCurrency(
  rows: Array<{ amount: string; currencyCode: string }>,
): CurrencySubtotal[] {
  const totals = new Map<string, Decimal>();
  for (const row of rows) {
    const current = totals.get(row.currencyCode) ?? new Decimal(0);
    totals.set(row.currencyCode, current.plus(new Decimal(row.amount)));
  }
  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, total]) => ({
      currencyCode,
      total: total.toFixed(4),
    }));
}

// Re-export for tests that want to assert on branding shape.
export type { ReportBranding };
