// packages/api/src/services/reports/branding.ts
// Phase 7 — pull a zone's branding payload for export headers, and
// stamp a consistent branded header onto every Excel artefact.
//
// The header occupies the first 4 rows and is the same shape across
// every report:
//
//   Row 1: zone name (bold, 16pt)
//   Row 2: legal name + country (if present)
//   Row 3: report title + generated timestamp
//   Row 4: filter summary (e.g. "Date 2025-01-01 → 2025-12-31; chapter Trinity")
//
// Data + column headers start at row 6 to give the title visual breathing room.

import { eq } from "drizzle-orm";
import { zones } from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import ExcelJS from "exceljs";
import type { ReportBranding } from "./types";

export async function loadReportBranding(
  database: Database,
  zoneId: string,
): Promise<ReportBranding> {
  const [zone] = await database
    .select({
      slug: zones.slug,
      name: zones.name,
      legalName: zones.legalName,
      countryCode: zones.countryCode,
      defaultCurrencyCode: zones.defaultCurrencyCode,
    })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!zone) {
    // Never expected — the tenant middleware would have rejected the
    // request. We surface a developer-visible error rather than render
    // a half-broken workbook.
    throw new Error(`zone ${zoneId} not found while loading report branding`);
  }
  return {
    zoneSlug: zone.slug,
    zoneName: zone.name,
    legalName: zone.legalName,
    countryCode: zone.countryCode,
    defaultCurrencyCode: zone.defaultCurrencyCode,
  };
}

interface BrandedSheetArgs {
  workbook: ExcelJS.Workbook;
  sheetName: string;
  branding: ReportBranding;
  reportTitle: string;
  filterSummary: string;
  /** Number of columns the report uses (drives merged-cell widths). */
  columnCount: number;
}

/**
 * Append a sheet to `workbook` with the standard branded header at the
 * top and a frozen header row. Returns the sheet so callers can
 * `addRow` the columns + data. Data should begin at row 7 (column
 * headers at row 6; left to the caller so the column kinds + cell
 * styles are controlled by the report itself).
 */
export function addBrandedSheet(args: BrandedSheetArgs): ExcelJS.Worksheet {
  const sheet = args.workbook.addWorksheet(args.sheetName, {
    views: [{ state: "frozen", ySplit: 6 }],
  });
  const colCount = Math.max(args.columnCount, 1);
  const lastColLetter = excelColumnLetter(colCount);

  const titleCell = sheet.getCell("A1");
  titleCell.value = args.branding.zoneName;
  titleCell.font = { bold: true, size: 16 };
  sheet.mergeCells(`A1:${lastColLetter}1`);

  const subRow = sheet.getCell("A2");
  const subParts: string[] = [];
  if (args.branding.legalName) subParts.push(args.branding.legalName);
  subParts.push(`Country: ${args.branding.countryCode}`);
  subParts.push(`Default currency: ${args.branding.defaultCurrencyCode}`);
  subRow.value = subParts.join("  •  ");
  subRow.font = { color: { argb: "FF555555" }, size: 10 };
  sheet.mergeCells(`A2:${lastColLetter}2`);

  const titleRow = sheet.getCell("A3");
  titleRow.value = `${args.reportTitle} — generated ${new Date().toISOString()}`;
  titleRow.font = { bold: true, size: 11 };
  sheet.mergeCells(`A3:${lastColLetter}3`);

  if (args.filterSummary) {
    const filterCell = sheet.getCell("A4");
    filterCell.value = args.filterSummary;
    filterCell.font = { italic: true, color: { argb: "FF666666" }, size: 10 };
    sheet.mergeCells(`A4:${lastColLetter}4`);
  }

  return sheet;
}

/** Excel column index (1-based) → letter. Supports up to ZZ (702 cols). */
export function excelColumnLetter(index1Based: number): string {
  let n = index1Based;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

/** Money-formatted cell style for an ISO 4217 currency. */
export function moneyFormatForCurrency(currencyCode: string): string {
  // ExcelJS lets us set `numFmt`; we use a generic 2dp pattern with a
  // 3-letter currency prefix because Excel's built-in currency locale
  // is messy across systems. Reports preserve 4dp arithmetic via the
  // raw Decimal string; display rounds to 2.
  return `"${currencyCode}" #,##0.00;[Red]"${currencyCode}" -#,##0.00`;
}
