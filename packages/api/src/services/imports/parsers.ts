// packages/api/src/services/imports/parsers.ts
// Phase 6 — pluggable file-format parsers. Each parser turns raw bytes
// into a uniform `ParsedRow` shape; the matcher (services/imports/match.ts)
// is then agnostic to source format.
//
// Conventions:
//   • `row_number` is 1-indexed and refers to the source row a treasurer
//     would see in Excel — header row counts as row 1 and is excluded
//     from the output.
//   • `raw` is the verbatim column→cell map (string-only); `parsed` is
//     the normalised payload used by the matcher.
//   • Missing optional fields stay `null`, never `""` or `undefined`,
//     so the JSON column shape is stable.

import { parse as parseCsv } from "papaparse";

const MAX_IMPORT_ROWS = 10_000;
const MAX_IMPORT_COLUMNS = 100;
const MAX_IMPORT_CELL_CHARS = 5_000;

/** Header keys we recognise (case-insensitive, trimmed, snake-or-space-tolerant). */
const HEADER_ALIASES: Record<string, keyof ParsedRow["parsed"]> = {
  // amount
  amount: "amount",
  total: "amount",
  value: "amount",
  credit: "amount",
  // date
  date: "contributionDate",
  "transaction date": "contributionDate",
  "value date": "contributionDate",
  // member identification
  "member reference": "memberReferenceCode",
  "member ref": "memberReferenceCode",
  "member code": "memberReferenceCode",
  "reference code": "memberReferenceCode",
  member: "memberName",
  "member name": "memberName",
  name: "memberName",
  // chapter
  chapter: "chapterReferenceCode",
  "chapter code": "chapterReferenceCode",
  "chapter reference": "chapterReferenceCode",
  // giving type
  "giving type": "givingTypeName",
  "giving type code": "givingTypeShortCode",
  category: "givingCategoryName",
  // bank ref / dedupe key
  reference: "externalTransactionId",
  "transaction reference": "externalTransactionId",
  "transaction id": "externalTransactionId",
  "external reference": "externalTransactionId",
  // currency
  currency: "currencyCode",
  "currency code": "currencyCode",
  // payment method
  "payment method": "paymentMethodCode",
  method: "paymentMethodCode",
  // description / notes
  description: "description",
  narrative: "description",
  memo: "description",
  notes: "description",
};

export interface ParsedRow {
  rowNumber: number;
  raw: Record<string, string>;
  parsed: {
    amount: string | null;
    contributionDate: string | null;
    memberReferenceCode: string | null;
    memberName: string | null;
    chapterReferenceCode: string | null;
    givingTypeName: string | null;
    givingTypeShortCode: string | null;
    givingCategoryName: string | null;
    externalTransactionId: string | null;
    currencyCode: string | null;
    paymentMethodCode: string | null;
    description: string | null;
  };
}

const EMPTY_PARSED: ParsedRow["parsed"] = {
  amount: null,
  contributionDate: null,
  memberReferenceCode: null,
  memberName: null,
  chapterReferenceCode: null,
  givingTypeName: null,
  givingTypeShortCode: null,
  givingCategoryName: null,
  externalTransactionId: null,
  currencyCode: null,
  paymentMethodCode: null,
  description: null,
};

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

function toIsoDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // YYYY-MM-DD passes through.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // DD/MM/YYYY or DD-MM-YYYY (UK-default; the legacy app sat in UK/NG too).
  const m = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    return `${y.padStart(4, "0")}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Excel date serial (number of days since 1899-12-30). Treat as UTC noon
  // so a serial 45000 is the same calendar day everywhere.
  if (/^\d+(\.\d+)?$/.test(trimmed) && Number(trimmed) > 25569 && Number(trimmed) < 60000) {
    const epoch = Date.UTC(1899, 11, 30);
    const ms = epoch + Number(trimmed) * 86400_000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  // Fallback: let JS try and re-emit ISO date.
  const dt = new Date(trimmed);
  if (!Number.isNaN(dt.getTime())) {
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }
  return null;
}

function toAmount(value: string): string | null {
  let s = value.trim();
  if (!s) return null;
  // Bracketed negatives, e.g. "(1,234.56)" → -1234.56
  let negative = false;
  if (/^\(.+\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Strip currency symbols and thousands separators.
  s = s.replace(/[£$€,\s]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (negative && !s.startsWith("-")) s = `-${s}`;
  return s;
}

function applyHeader(parsed: ParsedRow["parsed"], header: string, cell: string): void {
  const key = HEADER_ALIASES[normaliseHeader(header)];
  if (!key) return;
  if (key === "amount") parsed.amount = toAmount(cell);
  else if (key === "contributionDate") parsed.contributionDate = toIsoDate(cell);
  else if (key === "currencyCode") parsed.currencyCode = cell.trim().toUpperCase() || null;
  else parsed[key] = cell.trim() || null;
}

/** Quick sniff: does the first KB look like XLSX (zip header) or CSV? */
export function sniffFileType(body: Uint8Array, fileName: string): "csv" | "xlsx" {
  // XLSX is a zip; the magic bytes are "PK\x03\x04".
  if (
    body.length >= 4 &&
    body[0] === 0x50 &&
    body[1] === 0x4b &&
    body[2] === 0x03 &&
    body[3] === 0x04
  ) {
    return "xlsx";
  }
  if (/\.xlsx?$/i.test(fileName)) return "xlsx";
  return "csv";
}

interface ParseInput {
  body: Uint8Array;
  fileName: string;
  /** Optional parser hint (e.g. "bank_csv"). Currently informational. */
  sourceType?: string | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Raw header list, in order, for the dashboard preview. */
  headers: string[];
}

function buildParsed(headers: string[], cells: string[]): ParsedRow["parsed"] {
  const out = { ...EMPTY_PARSED };
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const c = cells[i] ?? "";
    if (h) applyHeader(out, h, c);
  }
  return out;
}

function buildRaw(headers: string[], cells: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]?.trim();
    if (!h) continue;
    out[h] = (cells[i] ?? "").trim();
  }
  return out;
}

function isRowEmpty(cells: string[]): boolean {
  return cells.every((c) => !c?.trim());
}

function assertCsvBounds(headers: string[], rows: string[][]): void {
  if (headers.length > MAX_IMPORT_COLUMNS) {
    throw new Error(`CSV has too many columns (${headers.length}); maximum is ${MAX_IMPORT_COLUMNS}`);
  }
  const dataRows = rows.length > 0 ? rows.length - 1 : 0;
  if (dataRows > MAX_IMPORT_ROWS) {
    throw new Error(`CSV has too many rows (${dataRows}); maximum is ${MAX_IMPORT_ROWS}`);
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row.length > MAX_IMPORT_COLUMNS) {
      throw new Error(
        `CSV row ${rowIndex + 1} has too many columns (${row.length}); maximum is ${MAX_IMPORT_COLUMNS}`,
      );
    }
    for (let colIndex = 0; colIndex < row.length; colIndex++) {
      const cell = row[colIndex] ?? "";
      if (cell.length > MAX_IMPORT_CELL_CHARS) {
        throw new Error(
          `CSV cell value too long at row ${rowIndex + 1}, column ${colIndex + 1}; maximum is ${MAX_IMPORT_CELL_CHARS} characters`,
        );
      }
    }
  }
}

export function parseCsvBody(body: Uint8Array): ParseResult {
  const text = new TextDecoder("utf-8").decode(body);
  if (text.trim().length === 0) return { rows: [], headers: [] };
  const parsed = parseCsv<string[]>(text, { skipEmptyLines: true });
  // `Delimiter` errors arise on tiny / single-column files and are not
  // fatal — papaparse still returns the row split as one column. Only
  // raise on truly structural errors.
  const fatal = parsed.errors.filter((e) => e.type !== "Delimiter");
  if (fatal.length > 0) {
    const first = fatal[0];
    throw new Error(`CSV parse error on row ${first.row ?? "?"}: ${first.message}`);
  }
  const rows = parsed.data as unknown as string[][];
  if (rows.length === 0) return { rows: [], headers: [] };
  const headers = rows[0].map((h) => h.trim());
  assertCsvBounds(headers, rows);
  const out: ParsedRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells || isRowEmpty(cells)) continue;
    out.push({
      rowNumber: i + 1, // 1-indexed; header is row 1
      raw: buildRaw(headers, cells),
      parsed: buildParsed(headers, cells),
    });
  }
  return { rows: out, headers };
}

export function parseXlsxBody(_body: Uint8Array): ParseResult {
  throw new Error(
    "XLSX imports are disabled until StewardLedger ships a hardened parser; export the sheet as CSV.",
  );
}

export function parseImportBody({ body, fileName, sourceType }: ParseInput): ParseResult {
  // sourceType is currently informational; bank-specific parsers can hook
  // off it in later phases (e.g. switch on "bank_a" to apply a header map
  // override).
  void sourceType;
  const kind = sniffFileType(body, fileName);
  if (kind === "xlsx") return parseXlsxBody(body);
  return parseCsvBody(body);
}
