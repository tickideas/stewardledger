// packages/web/src/lib/import-templates.ts
// Fetches and downloads tenant-branded XLSX import templates.
// Keeps import pages aligned with the API template centre endpoints.
// RELEVANT FILES: packages/web/src/lib/imports/template-download-centre.svelte, packages/web/src/routes/zone/imports/+page.svelte, packages/api/src/routes/tenant-imports.ts

import { PUBLIC_API_URL } from "./env";
import { currentZoneSlug } from "./api";

export interface ImportTemplateSummary {
  kind: string;
  title: string;
  description: string;
  fileType: string;
  sourceType: string;
  uploadHint: string;
  requiredColumns: string[];
  optionalColumns: string[];
}

export function templateDownloadPath(kind: string): string {
  return `/api/tenant/imports/templates/${encodeURIComponent(kind)}.xlsx`;
}

export async function downloadImportTemplate(kind: string): Promise<void> {
  const headers = new Headers();
  const zoneSlug = currentZoneSlug();
  if (zoneSlug) headers.set("x-stewardledger-zone-slug", zoneSlug);
  const res = await fetch(`${PUBLIC_API_URL}${templateDownloadPath(kind)}`, {
    credentials: "include",
    headers,
  });
  if (!res.ok) throw new Error(`Template download failed (${res.status})`);
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = filenameFromDisposition(disposition) ?? `${kind}-template.xlsx`;
  const href = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(href);
  }
}

function filenameFromDisposition(disposition: string): string | null {
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}
