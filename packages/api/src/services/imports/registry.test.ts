// packages/api/src/services/imports/registry.test.ts
// Verifies registered import templates cover every v1 importer kind.
// Prevents template-download metadata from drifting away from parser choices.
// RELEVANT FILES: packages/api/src/services/imports/registry.ts, packages/api/src/services/imports/templates.ts, packages/api/src/routes/tenant-imports.ts

import { describe, expect, it } from "vitest";
import { IMPORTER_REGISTRY, listImportTemplates } from "./registry";

describe("IMPORTER_REGISTRY", () => {
  it("has unique template kinds with required columns", () => {
    const kinds = new Set<string>();
    for (const template of IMPORTER_REGISTRY) {
      expect(kinds.has(template.kind)).toBe(false);
      kinds.add(template.kind);
      expect(template.columns.some((column) => column.required)).toBe(true);
    }
  });

  it("tracks statement source types plus the planned envelope-batch template", () => {
    const bySource = new Set(IMPORTER_REGISTRY.map((template) => template.sourceType));
    expect([...bySource]).toEqual(expect.arrayContaining(["generic_csv", "bank_csv", "online_giving", "envelope_batch"]));
  });

  it("returns enabled UI-safe summaries without full column note payloads", () => {
    const summaries = listImportTemplates("church");
    expect(summaries.map((template) => template.kind)).not.toContain("envelope-batch");
    expect(summaries[0]).toMatchObject({
      title: expect.any(String),
      requiredColumns: expect.any(Array),
      optionalColumns: expect.any(Array),
    });
    expect("columns" in summaries[0]).toBe(false);
  });
});
