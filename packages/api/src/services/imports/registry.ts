// packages/api/src/services/imports/registry.ts
// Defines the registered import templates that drive XLSX downloads.
// Keeps parser-facing column metadata in one place so UI and workbooks do not drift.
// RELEVANT FILES: packages/api/src/services/imports/templates.ts, packages/api/src/services/imports/parsers.ts, packages/api/src/routes/tenant-imports.ts

export type ImportTemplateSurface = "zone" | "church" | "both";

export interface ImportTemplateColumn {
  header: string;
  required: boolean;
  notes: string;
  example?: string;
  width?: number;
}

export interface ImportTemplateDefinition {
  kind: string;
  title: string;
  description: string;
  fileType: string;
  sourceType: string;
  surface: ImportTemplateSurface;
  enabled: boolean;
  uploadHint: string;
  columns: ImportTemplateColumn[];
}

const MATCHER_COLUMNS: ImportTemplateColumn[] = [
  { header: "Member Reference", required: false, notes: "Preferred member identifier, for example M0000001.", width: 20 },
  { header: "Member Name", required: false, notes: "Fallback matching hint when no member reference is available.", width: 24 },
  { header: "Chapter Reference", required: false, notes: "Required for zone-wide files unless the upload is scoped to a chapter.", width: 20 },
  { header: "Giving Type", required: false, notes: "Giving type name when no short code is available.", width: 20 },
  { header: "Giving Type Code", required: false, notes: "Preferred giving type short code, for example TITHE.", width: 20 },
  { header: "Currency Code", required: false, notes: "ISO 4217 code. Defaults may be inferred only when the importer can do so safely.", width: 16 },
  { header: "Description", required: false, notes: "Statement narrative or treasurer note.", width: 30 },
  { header: "Service Type", required: false, notes: "Service type name for zone-wide statement uploads.", width: 20 },
  { header: "Service Date", required: false, notes: "YYYY-MM-DD, or DD/MM/YYYY for UK-style spreadsheets.", width: 16 },
];

export const IMPORTER_REGISTRY = [
  {
    kind: "generic-bank-statement",
    title: "Generic bank statement",
    description: "Empty template for the generic bank-statement parser.",
    fileType: "statement",
    sourceType: "generic_csv",
    surface: "both",
    enabled: true,
    uploadHint: "Choose File type ‘Bank statement’ and Source ‘Generic CSV’. Zone-wide uploads must include chapter and service columns.",
    columns: [
      { header: "Date", required: true, notes: "Contribution or transaction date. Use YYYY-MM-DD where possible.", width: 16 },
      { header: "Amount", required: true, notes: "Positive amount. Use a decimal point; thousands separators are accepted.", width: 14 },
      { header: "Reference", required: true, notes: "Unique bank or external transaction reference for duplicate detection.", width: 24 },
      ...MATCHER_COLUMNS,
    ],
  },
  {
    kind: "bank-statement",
    title: "Bank statement",
    description: "Empty template for bank CSV exports with bank-oriented reference columns.",
    fileType: "statement",
    sourceType: "bank_csv",
    surface: "both",
    enabled: true,
    uploadHint: "Choose File type ‘Bank statement’ and Source ‘Bank CSV’. Keep one transaction per row.",
    columns: [
      { header: "Date", required: true, notes: "Bank transaction date. Use YYYY-MM-DD where possible.", width: 16 },
      { header: "Amount", required: true, notes: "Credit amount to import. Reversals are handled after posting, not by editing posted rows.", width: 14 },
      { header: "Transaction Reference", required: true, notes: "Unique bank transaction id or reference.", width: 24 },
      ...MATCHER_COLUMNS,
    ],
  },
  {
    kind: "online-giving-statement",
    title: "Online giving statement",
    description: "Empty template for online-giving processor exports.",
    fileType: "statement",
    sourceType: "online_giving",
    surface: "both",
    enabled: true,
    uploadHint: "Choose File type ‘Bank statement’ and Source ‘Online giving export’. Use the processor transaction id as the reference.",
    columns: [
      { header: "Date", required: true, notes: "Processor settlement or contribution date. Use YYYY-MM-DD where possible.", width: 16 },
      { header: "Amount", required: true, notes: "Gross contribution amount before any external reconciliation adjustments.", width: 14 },
      { header: "Transaction Reference", required: true, notes: "Processor payment, charge, or transaction id.", width: 26 },
      { header: "Currency Code", required: true, notes: "ISO 4217 code supplied by the processor.", width: 16 },
      { header: "Member Reference", required: false, notes: "Preferred member identifier, for example M0000001.", width: 20 },
      { header: "Member Name", required: false, notes: "Fallback matching hint when no member reference is available.", width: 24 },
      { header: "Giving Type", required: false, notes: "Giving type name when no short code is available.", width: 20 },
      { header: "Giving Type Code", required: false, notes: "Preferred giving type short code, for example TITHE.", width: 20 },
      { header: "Description", required: false, notes: "Processor memo or treasurer note.", width: 30 },
    ],
  },
  {
    kind: "envelope-batch",
    title: "Envelope batch",
    description: "Empty template for the Phase 10 bulk slip / envelope-batch importer.",
    fileType: "envelope_batch",
    sourceType: "envelope_batch",
    surface: "both",
    enabled: false,
    uploadHint: "Planned for the envelope-batch importer once the Phase 10 bulk slip flow is enabled.",
    columns: [
      { header: "Service Date", required: true, notes: "Service date for the envelope batch. Use YYYY-MM-DD where possible.", width: 16 },
      { header: "Chapter Reference", required: true, notes: "Chapter reference code for the envelope row.", width: 20 },
      { header: "Member Reference", required: true, notes: "Member reference code printed on the envelope or member record.", width: 20 },
      { header: "Giving Type Code", required: true, notes: "Giving type short code, for example TITHE or OFFERING.", width: 20 },
      { header: "Amount", required: true, notes: "Envelope amount as a positive decimal value.", width: 14 },
      { header: "Currency Code", required: true, notes: "ISO 4217 code for the amount.", width: 16 },
      { header: "Service Type Code", required: false, notes: "Optional service type short code when service date alone is ambiguous.", width: 20 },
      { header: "Payment Method", required: false, notes: "Cash, cheque, card, or another configured payment method code.", width: 18 },
      { header: "Envelope Number", required: false, notes: "Physical envelope or paying-in slip number for audit traceability.", width: 20 },
      { header: "Description", required: false, notes: "Treasurer note for the row.", width: 30 },
      { header: "External Reference", required: false, notes: "Optional row-level dedupe key from the source spreadsheet.", width: 24 },
    ],
  },
] as const satisfies readonly ImportTemplateDefinition[];

export type RegisteredImportKind = (typeof IMPORTER_REGISTRY)[number]["kind"];

export interface ImportTemplateSummary {
  kind: RegisteredImportKind;
  title: string;
  description: string;
  fileType: string;
  sourceType: string;
  uploadHint: string;
  requiredColumns: string[];
  optionalColumns: string[];
}

export function listImportTemplates(surface: "zone" | "church" = "zone"): ImportTemplateSummary[] {
  return IMPORTER_REGISTRY.filter(
    (template) => template.enabled && (template.surface === "both" || template.surface === surface),
  ).map(
    (template) => ({
      kind: template.kind,
      title: template.title,
      description: template.description,
      fileType: template.fileType,
      sourceType: template.sourceType,
      uploadHint: template.uploadHint,
      requiredColumns: template.columns.filter((column) => column.required).map((column) => column.header),
      optionalColumns: template.columns.filter((column) => !column.required).map((column) => column.header),
    }),
  );
}

export function getImportTemplate(kind: string): ImportTemplateDefinition | null {
  return IMPORTER_REGISTRY.find((template) => template.enabled && template.kind === kind) ?? null;
}
