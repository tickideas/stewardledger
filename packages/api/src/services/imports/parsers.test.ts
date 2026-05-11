// packages/api/src/services/imports/parsers.test.ts
// Pure unit tests for the Phase 6 file parser. No DB needed.

import { describe, expect, it } from "vitest";
import { parseCsvBody, parseImportBody, parseXlsxBody, sniffFileType } from "./parsers";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("parseCsvBody", () => {
  it("turns a canonical statement CSV into parsed rows", () => {
    const csv = [
      "date,member reference,giving type code,amount,reference,currency",
      "2024-01-07,M0000001,TITHE,250.00,TX-1,GBP",
      "07/01/2024,M0000002,OFFERING,50,TX-2,GBP",
      "", // blank
      "2024-01-07,M0000003,TITHE,(10.00),TX-3,GBP",
    ].join("\n");

    const result = parseCsvBody(bytes(csv));
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      parsed: {
        contributionDate: "2024-01-07",
        memberReferenceCode: "M0000001",
        givingTypeShortCode: "TITHE",
        amount: "250.00",
        externalTransactionId: "TX-1",
        currencyCode: "GBP",
      },
    });
    // UK-style 07/01/2024 → 2024-01-07
    expect(result.rows[1].parsed.contributionDate).toBe("2024-01-07");
    // Bracketed negative
    expect(result.rows[2].parsed.amount).toBe("-10.00");
  });

  it("handles thousand separators and currency symbols", () => {
    const csv = "date,amount\n2024-01-07,\"£1,234.56\"";
    const result = parseCsvBody(bytes(csv));
    expect(result.rows[0].parsed.amount).toBe("1234.56");
  });

  it("returns empty result for an empty file", () => {
    expect(parseCsvBody(bytes("")).rows).toEqual([]);
  });

  it("rejects files with too many rows", () => {
    const csv = ["date,amount", ...Array.from({ length: 10_001 }, (_, i) => `2024-01-07,${i + 1}`)].join("\n");
    expect(() => parseCsvBody(bytes(csv))).toThrow(/too many rows/i);
  });

  it("rejects files with too many columns", () => {
    const headers = Array.from({ length: 101 }, (_, i) => `col${i}`).join(",");
    const cells = Array.from({ length: 101 }, () => "x").join(",");
    expect(() => parseCsvBody(bytes(`${headers}\n${cells}`))).toThrow(/too many columns/i);
  });

  it("rejects overlong cell values", () => {
    const csv = `date,description\n2024-01-07,${"x".repeat(5_001)}`;
    expect(() => parseCsvBody(bytes(csv))).toThrow(/cell value too long/i);
  });
});

describe("parseXlsxBody", () => {
  it("rejects xlsx until a safe parser is available", () => {
    expect(() => parseXlsxBody(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toThrow(
      /XLSX imports are disabled/,
    );
  });
});

describe("sniffFileType", () => {
  it("detects xlsx magic bytes", () => {
    const xlsxMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(sniffFileType(xlsxMagic, "anything.bin")).toBe("xlsx");
  });
  it("falls back to csv by default", () => {
    expect(sniffFileType(new Uint8Array([0x61, 0x62]), "thing.csv")).toBe("csv");
  });
});

describe("parseImportBody (dispatch)", () => {
  it("routes csv bytes through parseCsvBody", () => {
    const csv = "date,amount\n2024-01-07,1.00";
    const r = parseImportBody({ body: bytes(csv), fileName: "thing.csv" });
    expect(r.rows[0].parsed.amount).toBe("1.00");
  });

  it("rejects xlsx-looking uploads", () => {
    expect(() =>
      parseImportBody({
        body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        fileName: "unsafe.xlsx",
      }),
    ).toThrow(/XLSX imports are disabled/);
  });
});
