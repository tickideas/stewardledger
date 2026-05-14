// packages/api/src/services/reports/general-ledger.ts
// Phase 7 — general ledger (giving) report (REPORTS.md §2.6).
// Flat line-level ledger of all posted contributions; the foundation
// envelope / online ledger presets will filter against later.
// RELEVANT FILES: packages/api/src/services/reports/giving-by-chapter.ts, packages/api/src/services/reports/registry.ts, packages/api/src/services/reports/reports.test.ts, docs/REPORTS.md

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

export const generalLedgerFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    chapterId: uuidSchema.optional(),
    accountId: uuidSchema.optional(),
    givingTypeId: uuidSchema.optional(),
    paymentMethodId: uuidSchema.optional(),
    sourceType: z
      .enum(["envelope", "online", "bank_import", "oblation", "manual"])
      .optional(),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type GeneralLedgerFilters = z.infer<typeof generalLedgerFiltersSchema>;

interface GeneralLedgerRow {
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
  currencyCode: string;
  amount: string;
  status: "posted" | "reversed";
  reversalOfContributionId: string | null;
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
  { key: "currencyCode", label: "Currency", kind: "text" },
  { key: "amount", label: "Amount", kind: "money" },
  { key: "status", label: "Status", kind: "text" },
  { key: "reversalOfContributionId", label: "Reversal of", kind: "text" },
];

export const generalLedgerReport: ReportSpec<
  GeneralLedgerFilters,
  GeneralLedgerRow
> = {
  id: "general-ledger",
  title: "General ledger (giving)",
  description:
    "Line-level ledger of all posted contributions, ordered by account → giving type → date.",
  filtersSchema: generalLedgerFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx, filters) => {
    if (isZoneRead(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    if (filters.chapterId && !ctx.chapterIds.includes(filters.chapterId)) {
      return "forbidden";
    }
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<GeneralLedgerRow>> {
    const conditions = [
      eq(contributions.zoneId, ctx.zoneId),
      sql`${contributions.contributionDate} >= ${filters.dateFrom}`,
      sql`${contributions.contributionDate} <= ${filters.dateTo}`,
      sql`${contributions.status} in ('posted', 'reversed')`,
      // Soft-deleted members vanish from reports. Left-joined misses
      // also have deletedAt = NULL, so this preserves anonymous
      // contributions while filtering deleted members.
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
    if (filters.sourceType) {
      conditions.push(eq(contributions.sourceType, filters.sourceType));
    }
    if (filters.accountId) {
      // A line's effective account is `contribution_lines.account_id`
      // when set, otherwise the giving type's default account. The
      // `coalesce` lets a single equality filter cover both.
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
        givingTypeOrdinal: givingTypes.ordinal,
        lineAccountId: contributionLines.accountId,
        defaultAccountId: givingTypes.accountId,
        accountName: accounts.name,
        paymentMethodCode: paymentMethods.code,
        sourceType: contributions.sourceType,
        currencyCode: contributionLines.currencyCode,
        amount: contributionLines.amount,
        status: contributions.status,
        reversalOfContributionId: contributions.reversalOfContributionId,
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
      // Effective account = line override > giving-type default. The
      // join uses the same coalesce so each row gets a single account
      // label without a second round trip.
      .leftJoin(
        accounts,
        and(
          eq(accounts.zoneId, contributionLines.zoneId),
          sql`${accounts.id} = coalesce(${contributionLines.accountId}, ${givingTypes.accountId})`,
        ),
      )
      .where(and(...conditions))
      // Sort by (account, giving type ordinal, giving type name, date)
      // so the Excel sheet reads as account-grouped without needing
      // an extra pivot pass. `accounts.name nulls last` is the
      // canonical Postgres idiom for keeping unaccounted lines at
      // the bottom.
      .orderBy(
        sql`${accounts.name} asc nulls last`,
        asc(givingTypes.ordinal),
        asc(givingTypes.name),
        asc(contributions.contributionDate),
        asc(contributions.id),
      );

    const grand = new Map<string, Decimal>();
    const mapped: GeneralLedgerRow[] = rows.map((r) => {
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
        currencyCode: r.currencyCode,
        amount: r.amount,
        status: r.status as GeneralLedgerRow["status"],
        reversalOfContributionId: r.reversalOfContributionId,
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
    if (filters.accountId) filterParts.push(`Account ${filters.accountId}`);
    if (filters.givingTypeId) filterParts.push(`Giving type ${filters.givingTypeId}`);
    if (filters.paymentMethodId) filterParts.push(`Payment ${filters.paymentMethodId}`);
    if (filters.sourceType) filterParts.push(`Source ${filters.sourceType}`);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "General ledger",
      branding,
      reportTitle: "General ledger (giving)",
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

    // Every text column carries user-controlled data (chapter name,
    // member name, giving-type name, account name). Route every
    // string through `escapeExcelText` so a poisoned label can't
    // smuggle a formula into the workbook.
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
    // Resolve the wider "Member" / "Chapter" / "Giving type" widths by
    // key so a future column reorder doesn't widen the wrong cell.
    setWidthByKey(sheet, "memberName", 28);
    setWidthByKey(sheet, "chapterName", 24);
    setWidthByKey(sheet, "givingTypeName", 24);
    setWidthByKey(sheet, "accountName", 22);

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
