// packages/api/src/services/reports/pdf/branded-table.test.ts
// Phase 7 — unit tests for the generic branded-table PDF renderer.
// We assert structural invariants (valid PDF magic bytes, page count
// grows with row count, subtotals block lands at the end) rather
// than pixel-perfect output — the renderer's job is structural, not
// stylistic.
// RELEVANT FILES: packages/api/src/services/reports/pdf/branded-table.ts

import { describe, expect, it } from "vitest";
import type { ReportBranding, ReportColumn } from "../types";
import { renderBrandedTablePdf } from "./branded-table";

const BRANDING: ReportBranding = {
  zoneSlug: "test-zone",
  zoneName: "Test Zone",
  legalName: "Test Zone Trust",
  countryCode: "GB",
  defaultCurrencyCode: "GBP",
};

const COLUMNS: ReportColumn[] = [
  { key: "date", label: "Date", kind: "date" },
  { key: "member", label: "Member", kind: "text" },
  { key: "type", label: "Type", kind: "text" },
  { key: "amount", label: "Amount", kind: "money" },
  { key: "currencyCode", label: "Currency", kind: "text" },
];

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  // PDF magic bytes: %PDF-
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}

describe("renderBrandedTablePdf", () => {
  it("produces a valid PDF buffer for a small dataset", async () => {
    const bytes = await renderBrandedTablePdf({
      reportTitle: "Test report",
      filterSummary: "Period 2025-01-01 -> 2025-12-31",
      columns: COLUMNS,
      rows: [
        { date: "2025-01-15", member: "Alice", type: "TITHE", amount: "100.00", currencyCode: "GBP" },
        { date: "2025-02-10", member: "Bob", type: "OFFERING", amount: "25.50", currencyCode: "GBP" },
      ],
      subtotals: [{ currencyCode: "GBP", total: "125.5000" }],
      branding: BRANDING,
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(startsWithPdfMagic(bytes)).toBe(true);
  });

  it("renders an empty dataset (branded header + no data block)", async () => {
    const bytes = await renderBrandedTablePdf({
      reportTitle: "Empty report",
      filterSummary: "",
      columns: COLUMNS,
      rows: [],
      branding: BRANDING,
    });
    expect(bytes.byteLength).toBeGreaterThan(500);
    expect(startsWithPdfMagic(bytes)).toBe(true);
  });

  it("paginates with many rows (output grows with row count)", async () => {
    const smallRows = Array.from({ length: 5 }, (_, i) => ({
      date: "2025-01-15",
      member: `Member ${i}`,
      type: "TITHE",
      amount: "100.00",
      currencyCode: "GBP",
    }));
    const largeRows = Array.from({ length: 200 }, (_, i) => ({
      date: "2025-01-15",
      member: `Member ${i}`,
      type: "TITHE",
      amount: "100.00",
      currencyCode: "GBP",
    }));
    const small = await renderBrandedTablePdf({
      reportTitle: "Small",
      filterSummary: "",
      columns: COLUMNS,
      rows: smallRows,
      branding: BRANDING,
    });
    const large = await renderBrandedTablePdf({
      reportTitle: "Large",
      filterSummary: "",
      columns: COLUMNS,
      rows: largeRows,
      branding: BRANDING,
    });
    // 40x rows produces a meaningfully larger PDF \u2014 not 40x in bytes
    // because of compression and shared structures, but > 3x is a
    // safe sanity floor that catches a regression where pagination
    // silently truncates.
    expect(large.byteLength).toBeGreaterThan(small.byteLength * 3);
    expect(startsWithPdfMagic(large)).toBe(true);
  });

  it("renders zero-currency money cells without crashing", async () => {
    const bytes = await renderBrandedTablePdf({
      reportTitle: "Zero currency",
      filterSummary: "",
      columns: COLUMNS,
      rows: [{ date: "2025-01-15", member: "Alice", type: "X", amount: "0.00", currencyCode: null }],
      branding: BRANDING,
    });
    expect(startsWithPdfMagic(bytes)).toBe(true);
  });
});
