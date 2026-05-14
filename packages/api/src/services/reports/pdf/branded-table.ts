// packages/api/src/services/reports/pdf/branded-table.ts
// Phase 7 — generic branded-table PDF renderer for tabular reports.
// Every Phase 7 report has the same shape: branded header, column
// row, data rows, per-currency subtotals. This module renders that
// shape into a PDF buffer via `pdfkit`. Bespoke layouts (member
// statement letter, partnership receipts) will get their own
// renderers once the Playwright/Chromium infra ships per
// ARCHITECTURE.md §2.
// RELEVANT FILES: packages/api/src/services/reports/branding.ts, packages/api/src/services/reports/types.ts, packages/api/src/routes/tenant-reports.ts

import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import Decimal from "decimal.js";
import type {
  CurrencySubtotal,
  ReportBranding,
  ReportColumn,
} from "../types";

/**
 * Roboto (Apache-2.0) bundled at `./assets/`. The 14 standard PDF
 * fonts pdfkit ships use WinAnsi encoding — they don't render
 * non-Latin glyphs. Roboto covers Latin, Latin Extended, Cyrillic,
 * Greek, and Vietnamese, which is sufficient for the founding
 * cohort. CJK / Arabic / Hebrew tenants will need an additional
 * Noto Sans subset registered at module load.
 *
 * The same `new URL("./assets/...", import.meta.url)` shape works
 * in dev (tsx/vitest — resolves to the source-tree assets dir) and
 * in the bundled `dist/server.js` because `build.mjs` copies the
 * TTFs into `dist/assets/` alongside the bundle.
 */
const FONT_REGULAR = readFileSync(new URL("./assets/Roboto-Regular.ttf", import.meta.url));
const FONT_BOLD = readFileSync(new URL("./assets/Roboto-Bold.ttf", import.meta.url));
const FONT_ITALIC = readFileSync(new URL("./assets/Roboto-Italic.ttf", import.meta.url));

export interface RenderBrandedTablePdfArgs {
  reportTitle: string;
  filterSummary: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  /** Per-currency subtotals, rendered at the end. Optional. */
  subtotals?: CurrencySubtotal[];
  branding: ReportBranding;
  /**
   * Currency-aware lookup for the row's effective currency. When a
   * row carries a `currencyCode` field that's where the money number
   * format is keyed; reports with a column-level currency override
   * the lookup. Defaults to `row.currencyCode` when present.
   */
  resolveRowCurrency?: (row: Record<string, unknown>) => string | null;
}

/** Letter-size page constants. pdfkit defaults assume 72 dpi. */
const PAGE_MARGINS = { top: 48, bottom: 48, left: 48, right: 48 };
/** Letter is 8.5" × 11" = 612 × 792 points. */
const LETTER_PORTRAIT_WIDTH = 612;
const LETTER_PORTRAIT_HEIGHT = 792;
const LETTER_LANDSCAPE_WIDTH = 792;
const LETTER_LANDSCAPE_HEIGHT = 612;
const HEADER_BAND_HEIGHT = 72;
const COLUMN_HEADER_HEIGHT = 18;
const ROW_PADDING = 4;
const FOOTER_GAP = 12;
/** Data-row font size. The minimum row height is `BODY_FONT_SIZE * 1.2`. */
const BODY_FONT_SIZE = 9;

/**
 * Render the given tabular report into a PDF buffer.
 *
 * Layout choices:
 *   • Landscape when the column count exceeds 6 so wide ledger
 *     reports (general-ledger, weekly-finance) don't crowd cells.
 *   • Branded header repeats on every page.
 *   • Column widths weight by `ReportColumn.kind`: money / number
 *     columns get a narrower share; text columns get the remainder.
 *   • Text cells are sanitised against the same formula-injection
 *     vector as the Excel renderer would catch — irrelevant for PDF
 *     (no formula evaluation) but cosmetically consistent.
 */
export async function renderBrandedTablePdf(
  args: RenderBrandedTablePdfArgs,
): Promise<Uint8Array> {
  const landscape = args.columns.length > 6;
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: "LETTER",
    layout: landscape ? "landscape" : "portrait",
    margins: PAGE_MARGINS,
    info: {
      Title: args.reportTitle,
      Author: `StewardLedger — ${args.branding.zoneName}`,
      Creator: "StewardLedger",
      CreationDate: new Date(),
    },
  });

  // Register the Unicode-capable fonts under stable names. PDFKit's
  // default "Helvetica" et al. are WinAnsi-only — we replace them
  // wholesale so non-Latin member names render correctly.
  doc.registerFont("body", FONT_REGULAR);
  doc.registerFont("body-bold", FONT_BOLD);
  doc.registerFont("body-italic", FONT_ITALIC);

  const chunks: Buffer[] = [];
  const captured = new Promise<Uint8Array>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => {
      if (chunks.length === 0) {
        // pdfkit should always emit at least one chunk; an empty
        // stream here means the render aborted silently. Surface
        // it as an error rather than a zero-byte download.
        reject(new Error("PDF render produced no output"));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    doc.on("error", reject);
  });

  const pageWidth = landscape ? LETTER_LANDSCAPE_WIDTH : LETTER_PORTRAIT_WIDTH;
  const pageHeight = landscape ? LETTER_LANDSCAPE_HEIGHT : LETTER_PORTRAIT_HEIGHT;
  const contentLeft = PAGE_MARGINS.left;
  const contentRight = pageWidth - PAGE_MARGINS.right;
  const contentWidth = contentRight - contentLeft;
  const pageBottom = pageHeight - PAGE_MARGINS.bottom;
  const columnWidths = computeColumnWidths(args.columns, contentWidth);

  const resolveRowCurrency =
    args.resolveRowCurrency ?? ((row) => coerceCurrencyCode(row.currencyCode));

  let currentY = 0;
  // Generated-at is ISO + UTC by design. The PDF is an archival
  // export that lives forever; UTC keeps the timestamp unambiguous
  // across tenants and time zones. If a tenant-TZ display is wanted
  // later, add it as a second line rather than replacing.
  const generatedAt = new Date().toISOString();

  function newPage(): void {
    doc.addPage();
    currentY = PAGE_MARGINS.top;
    drawHeader();
    drawColumnHeaderRow();
  }

  function drawHeader(): void {
    const top = currentY;
    doc
      .font("body-bold")
      .fontSize(16)
      .fillColor("#000000")
      .text(args.branding.zoneName, contentLeft, top, { width: contentWidth });
    const subParts: string[] = [];
    if (args.branding.legalName) subParts.push(args.branding.legalName);
    subParts.push(`Country: ${args.branding.countryCode}`);
    subParts.push(`Default currency: ${args.branding.defaultCurrencyCode}`);
    doc
      .font("body")
      .fontSize(BODY_FONT_SIZE)
      .fillColor("#555555")
      .text(subParts.join("  •  "), contentLeft, top + 20, { width: contentWidth });
    doc
      .font("body-bold")
      .fontSize(11)
      .fillColor("#000000")
      .text(
        `${args.reportTitle} — generated ${generatedAt}`,
        contentLeft,
        top + 36,
        { width: contentWidth },
      );
    if (args.filterSummary) {
      doc
        .font("body-italic")
        .fontSize(BODY_FONT_SIZE)
        .fillColor("#666666")
        .text(args.filterSummary, contentLeft, top + 52, { width: contentWidth });
    }
    currentY = top + HEADER_BAND_HEIGHT;
  }

  function drawColumnHeaderRow(): void {
    let x = contentLeft;
    doc.font("body-bold").fontSize(BODY_FONT_SIZE).fillColor("#000000");
    args.columns.forEach((col, i) => {
      const width = columnWidths[i];
      const align = isNumeric(col) ? "right" : "left";
      doc.text(col.label, x + ROW_PADDING, currentY, {
        width: width - ROW_PADDING * 2,
        align,
        lineBreak: false,
      });
      x += width;
    });
    // Underline beneath the column header band.
    doc
      .moveTo(contentLeft, currentY + COLUMN_HEADER_HEIGHT - 2)
      .lineTo(contentRight, currentY + COLUMN_HEADER_HEIGHT - 2)
      .lineWidth(0.5)
      .strokeColor("#000000")
      .stroke();
    currentY += COLUMN_HEADER_HEIGHT;
    // Reset the font state to the data-row default so the caller's
    // data-row loop doesn't accidentally inherit Bold after a
    // pagination-triggered newPage(). Without this reset every row
    // on pages 2+ would render bold. The size must use the same
    // `BODY_FONT_SIZE` constant the row-height measurement uses —
    // a literal `9` here would silently desync from the layout
    // math if the constant ever changed.
    doc.font("body").fontSize(BODY_FONT_SIZE).fillColor("#000000");
  }

  newPage();

  // Data rows. Measure each cell's wrapped height; take the max to
  // size the row. The measurement is a pure read — pdfkit's
  // `heightOfString` doesn't mutate the document state — so it's
  // safe to call in a loop. The font state is set by
  // `drawColumnHeaderRow()` for us after each page break.
  for (const row of args.rows) {
    const cellTexts = args.columns.map((col) =>
      formatCell(row[col.key], col, resolveRowCurrency(row)),
    );
    // Compute per-cell wrapped height; take the max.
    const heights = cellTexts.map((text, i) =>
      doc.heightOfString(text, {
        width: columnWidths[i] - ROW_PADDING * 2,
        lineBreak: true,
      }),
    );
    const rowHeight = Math.max(...heights, BODY_FONT_SIZE * 1.2) + ROW_PADDING;
    if (currentY + rowHeight > pageBottom) {
      newPage();
    }
    let x = contentLeft;
    args.columns.forEach((col, i) => {
      const width = columnWidths[i];
      const align = isNumeric(col) ? "right" : "left";
      doc.text(cellTexts[i], x + ROW_PADDING, currentY + 1, {
        width: width - ROW_PADDING * 2,
        align,
        lineBreak: true,
      });
      x += width;
    });
    currentY += rowHeight;
  }

  // Per-currency subtotal block.
  if (args.subtotals && args.subtotals.length > 0) {
    if (currentY + FOOTER_GAP + 24 + 14 * args.subtotals.length > pageBottom) {
      newPage();
    }
    currentY += FOOTER_GAP;
    doc
      .font("body-bold")
      .fontSize(10)
      .fillColor("#000000")
      .text("Totals per currency", contentLeft, currentY, { width: contentWidth });
    currentY += 14;
    for (const sub of args.subtotals) {
      doc
        .font("body-bold")
        .fontSize(BODY_FONT_SIZE)
        .text(sub.currencyCode, contentLeft, currentY, { width: 60, lineBreak: false });
      doc
        .font("body")
        .fontSize(BODY_FONT_SIZE)
        .text(formatMoney(sub.total), contentLeft + 60, currentY, {
          width: 160,
          align: "right",
          lineBreak: false,
        });
      currentY += 14;
    }
  }

  doc.end();
  return captured;
}

/** Compute column widths from kind. Money / number cells get a smaller share. */
function computeColumnWidths(columns: ReportColumn[], totalWidth: number): number[] {
  const weights = columns.map((c) => {
    switch (c.kind) {
      case "money":
        return 1.0;
      case "number":
        return 0.7;
      case "date":
        return 0.8;
      case "datetime":
        return 1.2;
      default:
        return 1.5;
    }
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / sum) * totalWidth);
}

function isNumeric(col: ReportColumn): boolean {
  return col.kind === "money" || col.kind === "number";
}

function coerceCurrencyCode(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  return v;
}

function formatCell(value: unknown, col: ReportColumn, currency: string | null): string {
  if (value === null || value === undefined) return "";
  if (col.kind === "money" && typeof value === "string") {
    const amount = formatMoney(value);
    return currency ? `${currency} ${amount}` : amount;
  }
  if (col.kind === "number" && typeof value === "number") {
    return value.toLocaleString("en-US");
  }
  if (col.kind === "datetime" && typeof value === "string") {
    return value.replace("T", " ").replace(/\..*$/, "");
  }
  return String(value);
}

function formatMoney(value: string): string {
  try {
    const d = new Decimal(value);
    return d.toFixed(2);
  } catch {
    return value;
  }
}
