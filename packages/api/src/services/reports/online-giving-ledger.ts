// packages/api/src/services/reports/online-giving-ledger.ts
// Phase 7 — online giving ledger (REPORTS.md §2.5).
// Line-level ledger of every online / bank-import contribution.
// Effectively a general-ledger preset hard-clamped to
// `source_type in ('online','bank_import')` with a transaction-id
// column surfaced for reconciliation.
// RELEVANT FILES: packages/api/src/services/reports/general-ledger.ts, packages/api/src/services/reports/registry.ts, packages/api/src/services/reports/reports.test.ts, docs/REPORTS.md

import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  accounts,
  chapters,
  contributionLines,
  contributions,
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
import type {
  CurrencySubtotal,
  ReportColumn,
  ReportFetchResult,
  ReportSpec,
} from "./types";

/**
 * Online giving spans two source types: `online` (a payment-processor
 * webhook) and `bank_import` (a bank statement reconciliation row).
 * The legacy report grouped both under the same "online ledger" so
 * keep them together — the optional `sourceType` filter discriminates
 * for callers who need only one.
 */
const ONLINE_SOURCE_TYPES = ["online", "bank_import"] as const;

export const onlineGivingLedgerFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    chapterId: uuidSchema.optional(),
    paymentMethodId: uuidSchema.optional(),
    givingTypeId: uuidSchema.optional(),
    accountId: uuidSchema.optional(),
    sourceType: z.enum(ONLINE_SOURCE_TYPES).optional(),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type OnlineGivingLedgerFilters = z.infer<
  typeof onlineGivingLedgerFiltersSchema
>;

interface OnlineGivingLedgerRow {
  contributionId: string;
  contributionDate: string;
  chapterReferenceCode: string | null;
  chapterName: string | null;
  memberReferenceCode: string | null;
  memberName: string | null;
  givingTypeShortCode: string | null;
  givingTypeName: string;
  accountName: string | null;
  paymentMethodCode: string | null;
  sourceType: string;
  transactionId: string | null;
  currencyCode: string;
  amount: string;
  status: "posted" | "reversed";
}

const COLUMNS: ReportColumn[] = [
  { key: "contributionDate", label: "Date", kind: "date" },
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "memberReferenceCode", label: "Member ref", kind: "text" },
  { key: "memberName", label: "Member", kind: "text" },
  { key: "givingTypeShortCode", label: "Type code", kind: "text" },
  { key: "givingTypeName", label: "Giving type", kind: "text" },
  { key: "accountName", label: "Account", kind: "text" },
  { key: "paymentMethodCode", label: "Payment", kind: "text" },
  { key: "sourceType", label: "Source", kind: "text" },
  { key: "transactionId", label: "Transaction id", kind: "text" },
  { key: "currencyCode", label: "Currency", kind: "text" },
  { key: "amount", label: "Amount", kind: "money" },
  { key: "status", label: "Status", kind: "text" },
];

export const onlineGivingLedgerReport: ReportSpec<
  OnlineGivingLedgerFilters,
  OnlineGivingLedgerRow
> = {
  id: "online-giving-ledger",
  title: "Online giving ledger",
  description:
    "Line-level ledger of every online / bank-import contribution with transaction ids.",
  filtersSchema: onlineGivingLedgerFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx, filters) => {
    if (isZoneRead(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    if (filters.chapterId && !ctx.chapterIds.includes(filters.chapterId)) {
      return "forbidden";
    }
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<OnlineGivingLedgerRow>> {
    const conditions = [
      eq(contributions.zoneId, ctx.zoneId),
      sql`${contributions.contributionDate} >= ${filters.dateFrom}`,
      sql`${contributions.contributionDate} <= ${filters.dateTo}`,
      sql`${contributions.status} in ('posted', 'reversed')`,
      // Hard preset: the report only ever surfaces online + bank-import
      // contributions. The `sourceType` filter below narrows further.
      filters.sourceType
        ? eq(contributions.sourceType, filters.sourceType)
        : inArray(contributions.sourceType, [...ONLINE_SOURCE_TYPES]),
      isNull(members.deletedAt),
    ];
    if (filters.chapterId) {
      conditions.push(eq(contributions.chapterId, filters.chapterId));
    } else if (!isZoneRead(ctx)) {
      conditions.push(inArray(contributions.chapterId, ctx.chapterIds));
    }
    if (filters.givingTypeId) {
      conditions.push(eq(contributionLines.givingTypeId, filters.givingTypeId));
    }
    if (filters.paymentMethodId) {
      conditions.push(eq(contributions.paymentMethodId, filters.paymentMethodId));
    }
    if (filters.accountId) {
      // Effective account = line override > giving-type default.
      // Same coalesce trick as `general-ledger.ts`.
      conditions.push(
        sql`coalesce(${contributionLines.accountId}, ${givingTypes.accountId}) = ${filters.accountId}`,
      );
    }

    const rows = await database
      .select({
        contributionId: contributions.id,
        contributionDate: contributions.contributionDate,
        chapterReferenceCode: chapters.referenceCode,
        chapterName: chapters.name,
        memberReferenceCode: members.referenceCode,
        memberFullName: members.fullName,
        memberFirstName: members.firstName,
        memberLastName: members.lastName,
        givingTypeShortCode: givingTypes.shortCode,
        givingTypeName: givingTypes.name,
        accountName: accounts.name,
        paymentMethodCode: paymentMethods.code,
        sourceType: contributions.sourceType,
        transactionId: contributions.externalTransactionId,
        currencyCode: contributionLines.currencyCode,
        amount: contributionLines.amount,
        status: contributions.status,
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
        accounts,
        and(
          eq(accounts.zoneId, contributionLines.zoneId),
          sql`${accounts.id} = coalesce(${contributionLines.accountId}, ${givingTypes.accountId})`,
        ),
      )
      .where(and(...conditions))
      .orderBy(
        sql`${accounts.name} asc nulls last`,
        asc(contributions.contributionDate),
        asc(contributions.id),
      );

    const grand = new Map<string, Decimal>();
    const mapped: OnlineGivingLedgerRow[] = rows.map((r) => {
      const memberName =
        r.memberFullName ??
        (r.memberFirstName || r.memberLastName
          ? `${r.memberFirstName ?? ""} ${r.memberLastName ?? ""}`.trim()
          : null);
      const cur = grand.get(r.currencyCode) ?? new Decimal(0);
      grand.set(r.currencyCode, cur.plus(new Decimal(r.amount)));
      return {
        contributionId: r.contributionId,
        contributionDate: r.contributionDate,
        chapterReferenceCode: r.chapterReferenceCode,
        chapterName: r.chapterName,
        memberReferenceCode: r.memberReferenceCode,
        memberName,
        givingTypeShortCode: r.givingTypeShortCode,
        givingTypeName: r.givingTypeName,
        accountName: r.accountName,
        paymentMethodCode: r.paymentMethodCode,
        sourceType: r.sourceType,
        transactionId: r.transactionId,
        currencyCode: r.currencyCode,
        amount: r.amount,
        status: r.status as OnlineGivingLedgerRow["status"],
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
    if (filters.paymentMethodId) filterParts.push(`Payment ${filters.paymentMethodId}`);
    if (filters.givingTypeId) filterParts.push(`Giving type ${filters.givingTypeId}`);
    if (filters.accountId) filterParts.push(`Account ${filters.accountId}`);
    if (filters.sourceType) filterParts.push(`Source ${filters.sourceType}`);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Online ledger",
      branding,
      reportTitle: "Online giving ledger",
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

    // Every text cell is user-controlled (member name, chapter name,
    // payment-processor transaction id, account name). The
    // transaction id is the highest-risk attacker-controlled field
    // because it's mirrored from a bank statement or webhook
    // payload; `escapeExcelText` is the canonical sink.
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
    setWidthByKey(sheet, "givingTypeName", 24);
    setWidthByKey(sheet, "accountName", 22);
    setWidthByKey(sheet, "transactionId", 28);

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
