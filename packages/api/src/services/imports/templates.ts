// packages/api/src/services/imports/templates.ts
// Builds branded XLSX workbooks for registered import templates.
// Gives treasurers empty canonical sheets whose headers match importer metadata.
// RELEVANT FILES: packages/api/src/services/imports/registry.ts, packages/api/src/services/reports/branding.ts, packages/api/src/routes/tenant-imports.ts

import ExcelJS from "exceljs";
import type { Database } from "@stewardledger/db";
import type { AuthorizedContext } from "@stewardledger/shared";
import {
  addBrandedSheet,
  escapeExcelText,
  loadReportBranding,
} from "../reports/branding";
import { getImportTemplate, type RegisteredImportKind } from "./registry";

export const IMPORT_TEMPLATE_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;

export interface ImportTemplateWorkbookResult {
  fileName: string;
  contentType: typeof IMPORT_TEMPLATE_XLSX_CONTENT_TYPE;
  body: Uint8Array;
}

export class ImportTemplateError extends Error {
  constructor(
    readonly code: "template_not_found",
    message: string,
  ) {
    super(message);
  }
}

export async function buildImportTemplateWorkbook(
  database: Database,
  ctx: Pick<AuthorizedContext, "zoneId">,
  kind: RegisteredImportKind | string,
): Promise<ImportTemplateWorkbookResult> {
  const template = getImportTemplate(kind);
  if (!template) throw new ImportTemplateError("template_not_found", `Import template ${kind} not found`);

  const branding = await loadReportBranding(database, ctx.zoneId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StewardLedger";
  workbook.created = new Date();

  const sheet = addBrandedSheet({
    workbook,
    sheetName: safeSheetName(template.title),
    branding,
    reportTitle: `${template.title} template`,
    filterSummary: `Empty import template; upload as ${template.fileType}/${template.sourceType}`,
    columnCount: template.columns.length,
  });

  template.columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width ?? 18;
  });
  const headerRow = sheet.getRow(6);
  headerRow.font = { bold: true };
  template.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.required ? `${column.header} *` : column.header;
    cell.value = escapeExcelText(String(cell.value ?? ""));
    cell.note = `${column.required ? "Required" : "Optional"}. ${column.notes}`;
    cell.alignment = { vertical: "middle", wrapText: true };
  });

  const instructions = workbook.addWorksheet("Instructions", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  instructions.columns = [
    { header: "Item", key: "item", width: 24 },
    { header: "Guidance", key: "guidance", width: 90 },
  ];
  instructions.getRow(1).font = { bold: true };
  const instructionRows: [string, string][] = [
    ["Template", template.title],
    ["Upload selection", template.uploadHint],
    ["File type", template.fileType],
    ["Source type", template.sourceType],
    ["Required columns", template.columns.filter((column) => column.required).map((column) => column.header).join(", ")],
    ["Dates", "Use YYYY-MM-DD where possible. UK-style DD/MM/YYYY is accepted by statement parsers."],
    ["Amounts", "Use positive decimal amounts. Posted contributions are immutable; corrections are posted as reversals."],
    ["Headers", "Do not rename the header row. Fill rows below the header in the first sheet."],
    ["Upload", "If the importer requests CSV, save the first sheet as CSV before upload. Keep this XLSX as the canonical blank template."],
  ];
  for (const [item, guidance] of instructionRows) {
    instructions.addRow({ item: escapeExcelText(item), guidance: escapeExcelText(guidance) });
  }
  instructions.eachRow((row) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
    });
  });

  const buf = await workbook.xlsx.writeBuffer();
  return {
    fileName: `${branding.zoneSlug}-${template.kind}-template.xlsx`,
    contentType: IMPORT_TEMPLATE_XLSX_CONTENT_TYPE,
    body: new Uint8Array(buf as ArrayBuffer),
  };
}

function safeSheetName(name: string): string {
  return name.replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || "Import template";
}
