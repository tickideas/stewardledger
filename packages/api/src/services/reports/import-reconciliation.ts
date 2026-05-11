// packages/api/src/services/reports/import-reconciliation.ts
// Phase 7 — statement-import reconciliation report (REPORTS.md §2.11).
//
// One row per import job. Surfaces the full lifecycle so a treasurer
// can answer "did every uploaded file end up in contributions?".
// Excludes nothing: failed and rolled-back jobs still appear so
// operators can chase them.
//
// Money totals are sum of committed-row line amounts grouped by
// currency. Phase 6 enforces single-currency imports today, so each
// job typically yields exactly one currency subtotal — but the spec
// is written multi-currency-aware so a future per-job mixed-currency
// strategy doesn't quietly break the report.

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import Decimal from "decimal.js";
import {
  contributionLines,
  contributions,
  importFiles,
  importJobs,
  importRows,
  user as userTable,
} from "@stewardledger/db/schema";
import { uuidSchema } from "@stewardledger/shared";
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

export const importReconciliationFiltersSchema = z
  .object({
    importJobId: uuidSchema.optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    status: z
      .enum([
        "received",
        "parsing",
        "parsed",
        "matching",
        "matched",
        "scheduled",
        "committing",
        "committed",
        "failed",
        "rolled_back",
      ])
      .optional(),
  })
  .refine((v) => v.importJobId || v.dateFrom || v.dateTo || v.status, {
    message: "Provide at least one filter (importJobId, dateFrom, dateTo, or status).",
    path: ["dateFrom"],
  });
export type ImportReconciliationFilters = z.infer<
  typeof importReconciliationFiltersSchema
>;

interface ReconciliationRow {
  importJobId: string;
  fileName: string;
  uploadedBy: string | null;
  uploadedAt: string;
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  duplicateRows: number;
  failedRows: number;
  committedRows: number;
  contributionsPosted: number;
  totalsByCurrency: CurrencySubtotal[];
  status: string;
  errorMessage: string | null;
}

const COLUMNS: ReportColumn[] = [
  { key: "fileName", label: "File", kind: "text" },
  { key: "uploadedBy", label: "Uploaded by", kind: "text" },
  { key: "uploadedAt", label: "Uploaded", kind: "datetime" },
  { key: "status", label: "Status", kind: "text" },
  { key: "totalRows", label: "Total", kind: "number" },
  { key: "matchedRows", label: "Matched", kind: "number" },
  { key: "unmatchedRows", label: "Unmatched", kind: "number" },
  { key: "duplicateRows", label: "Duplicate", kind: "number" },
  { key: "failedRows", label: "Failed", kind: "number" },
  { key: "committedRows", label: "Committed", kind: "number" },
  { key: "contributionsPosted", label: "Contributions posted", kind: "number" },
  { key: "totals", label: "Totals", kind: "text" },
  { key: "errorMessage", label: "Error", kind: "text" },
];

export const importReconciliationReport: ReportSpec<
  ImportReconciliationFilters,
  ReconciliationRow
> = {
  id: "import-reconciliation",
  title: "Statement import reconciliation",
  description:
    "Every import job with row outcomes, posted contributions, and per-currency totals.",
  filtersSchema: importReconciliationFiltersSchema,
  columns: () => COLUMNS,
  async fetch(database, ctx, filters): Promise<ReportFetchResult<ReconciliationRow>> {
    const jobConditions = [eq(importJobs.zoneId, ctx.zoneId)];
    if (filters.importJobId) jobConditions.push(eq(importJobs.id, filters.importJobId));
    if (filters.status) jobConditions.push(eq(importJobs.status, filters.status));
    if (filters.dateFrom)
      jobConditions.push(sql`${importJobs.createdAt} >= ${filters.dateFrom}::date`);
    if (filters.dateTo)
      // include the whole day
      jobConditions.push(sql`${importJobs.createdAt} < (${filters.dateTo}::date + 1)`);

    const jobRows = await database
      .select({
        id: importJobs.id,
        status: importJobs.status,
        totalRows: importJobs.totalRows,
        matchedRows: importJobs.matchedRows,
        unmatchedRows: importJobs.unmatchedRows,
        duplicateRows: importJobs.duplicateRows,
        failedRows: importJobs.failedRows,
        committedRows: importJobs.committedRows,
        errorMessage: importJobs.errorMessage,
        createdAt: importJobs.createdAt,
        importFileId: importJobs.importFileId,
        fileName: importFiles.originalFileName,
        uploadedByName: userTable.name,
        uploadedByEmail: userTable.email,
      })
      .from(importJobs)
      .innerJoin(
        importFiles,
        and(
          eq(importFiles.zoneId, importJobs.zoneId),
          eq(importFiles.id, importJobs.importFileId),
        ),
      )
      .leftJoin(userTable, eq(userTable.id, importFiles.uploadedByUserId))
      .where(and(...jobConditions))
      .orderBy(sql`${importJobs.createdAt} desc`);

    if (jobRows.length === 0) {
      return { rows: [], subtotals: [] };
    }

    const jobIds = jobRows.map((j) => j.id);

    // Per-job sums: posted contributions count + per-currency line totals.
    // Joining import_rows → contributions → contribution_lines is the
    // tightest way to attribute back to the source job. Voided
    // contributions are excluded; that's the canonical "did the import
    // actually post a contribution?" answer.
    const postedRows = await database
      .select({
        importJobId: importRows.importJobId,
        contributionId: contributions.id,
        amount: contributionLines.amount,
        currencyCode: contributionLines.currencyCode,
      })
      .from(importRows)
      .innerJoin(
        contributions,
        and(
          eq(contributions.zoneId, importRows.zoneId),
          eq(contributions.id, importRows.contributionId),
        ),
      )
      .innerJoin(
        contributionLines,
        and(
          eq(contributionLines.zoneId, contributions.zoneId),
          eq(contributionLines.contributionId, contributions.id),
        ),
      )
      .where(
        and(
          eq(importRows.zoneId, ctx.zoneId),
          sql`${importRows.contributionId} is not null`,
          eq(contributions.status, "posted"),
          inArray(importRows.importJobId, jobIds),
        ),
      );

    // Aggregate into job-keyed maps. Distinct contribution ids are
    // counted via a Set so a multi-line contribution doesn't inflate
    // the "contributionsPosted" tally.
    const totalsByJob = new Map<string, Map<string, Decimal>>();
    const postedIdsByJob = new Map<string, Set<string>>();
    for (const row of postedRows) {
      if (!row.importJobId) continue;
      const ids = postedIdsByJob.get(row.importJobId) ?? new Set<string>();
      ids.add(row.contributionId);
      postedIdsByJob.set(row.importJobId, ids);

      const byCur = totalsByJob.get(row.importJobId) ?? new Map<string, Decimal>();
      const cur = byCur.get(row.currencyCode) ?? new Decimal(0);
      byCur.set(row.currencyCode, cur.plus(new Decimal(row.amount)));
      totalsByJob.set(row.importJobId, byCur);
    }

    const rows: ReconciliationRow[] = jobRows.map((j) => {
      const totals = totalsByJob.get(j.id);
      const totalsArr: CurrencySubtotal[] = totals
        ? Array.from(totals.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currencyCode, total]) => ({
              currencyCode,
              total: total.toFixed(4),
            }))
        : [];
      return {
        importJobId: j.id,
        fileName: j.fileName,
        uploadedBy: j.uploadedByName ?? j.uploadedByEmail ?? null,
        uploadedAt: j.createdAt.toISOString(),
        totalRows: j.totalRows,
        matchedRows: j.matchedRows,
        unmatchedRows: j.unmatchedRows,
        duplicateRows: j.duplicateRows,
        failedRows: j.failedRows,
        committedRows: j.committedRows,
        contributionsPosted: postedIdsByJob.get(j.id)?.size ?? 0,
        totalsByCurrency: totalsArr,
        status: j.status,
        errorMessage: j.errorMessage,
      };
    });

    // Cross-job subtotals.
    const grand = new Map<string, Decimal>();
    for (const r of rows) {
      for (const sub of r.totalsByCurrency) {
        const c = grand.get(sub.currencyCode) ?? new Decimal(0);
        grand.set(sub.currencyCode, c.plus(new Decimal(sub.total)));
      }
    }
    const subtotals = Array.from(grand.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, total]) => ({
        currencyCode,
        total: total.toFixed(4),
      }));

    return { rows, subtotals };
  },
  async excel(rows, subtotals, filters, branding) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const filterParts: string[] = [];
    if (filters.importJobId) filterParts.push(`Job ${filters.importJobId}`);
    if (filters.dateFrom || filters.dateTo) {
      filterParts.push(`Uploaded ${filters.dateFrom ?? "…"} → ${filters.dateTo ?? "…"}`);
    }
    if (filters.status) filterParts.push(`Status ${filters.status}`);
    const filterSummary = filterParts.join("  •  ") || "All jobs";

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Reconciliation",
      branding,
      reportTitle: "Statement import reconciliation",
      filterSummary,
      columnCount: COLUMNS.length,
    });

    const headerRow = sheet.getRow(6);
    COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true };
    });
    headerRow.commit();

    // User-controlled text columns (fileName, uploadedBy, errorMessage)
    // go through `escapeExcelText` so a poisoned filename or parser
    // echo can't smuggle a formula into the workbook.
    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      dataRow.getCell(1).value = escapeExcelText(row.fileName);
      dataRow.getCell(2).value = escapeExcelText(row.uploadedBy);
      dataRow.getCell(3).value = escapeExcelText(row.uploadedAt);
      dataRow.getCell(4).value = row.status;
      dataRow.getCell(5).value = row.totalRows;
      dataRow.getCell(6).value = row.matchedRows;
      dataRow.getCell(7).value = row.unmatchedRows;
      dataRow.getCell(8).value = row.duplicateRows;
      dataRow.getCell(9).value = row.failedRows;
      dataRow.getCell(10).value = row.committedRows;
      dataRow.getCell(11).value = row.contributionsPosted;
      // Totals string is server-built from currency codes + decimal
      // strings — neither can lead with a dangerous char, but route
      // through the helper for uniformity.
      dataRow.getCell(12).value = escapeExcelText(
        row.totalsByCurrency
          .map((t) => `${t.currencyCode} ${t.total}`)
          .join(", "),
      );
      dataRow.getCell(13).value = escapeExcelText(row.errorMessage);
      dataRow.commit();
      r += 1;
    }

    if (subtotals && subtotals.length > 0) {
      r += 1;
      const head = sheet.getRow(r);
      head.getCell(1).value = "Posted totals (all jobs)";
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
      width: col.kind === "number" ? 12 : 22,
    }));
    sheet.getColumn(1).width = 30;
    sheet.getColumn(12).width = 28;
    sheet.getColumn(13).width = 30;

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};
