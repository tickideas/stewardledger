// packages/web/src/lib/import-templates.ts
// Builds downloadable CSV templates for contribution import screens.
// Keeps zone and church import pages aligned with the API parser aliases
// and chapter-scoped template rules.
// RELEVANT FILES: packages/web/src/routes/zone/imports/+page.svelte, packages/web/src/routes/church/imports/+page.svelte, packages/api/src/services/imports/parsers.ts

type ImportTemplateScope = "zone" | "chapter";

const baseRows = [
  ["date", "member reference", "giving type code", "amount", "reference", "currency", "description"],
  ["2026-05-24", "M0000001", "TITHE", "100.00", "TX-001", "GBP", "Sunday tithe"],
  ["2026-05-24", "M0000002", "OFFERING", "50.00", "TX-002", "GBP", "Offering"],
];

const zoneRows = baseRows.map((row, index) =>
  index === 0 ? ["chapter", ...row] : ["C000001", ...row],
);

function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const escaped = cell.replaceAll("\"", "\"\"");
          return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
        })
        .join(","),
    )
    .join("\n");
}

export function importTemplateHref(scope: ImportTemplateScope): string {
  const rows = scope === "zone" ? zoneRows : baseRows;
  return `data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(rows))}`;
}
