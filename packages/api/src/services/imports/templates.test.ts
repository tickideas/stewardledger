// packages/api/src/services/imports/templates.test.ts
// Unit/integration coverage for branded XLSX import-template generation.
// Confirms template workbooks use the shared report branding sheet shape.
// RELEVANT FILES: packages/api/src/services/imports/templates.ts, packages/api/src/services/imports/registry.ts, packages/api/src/services/reports/branding.ts

import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zones } from "@stewardledger/db";
import { db } from "../../db";
import { IMPORTER_REGISTRY } from "./registry";
import { buildImportTemplateWorkbook } from "./templates";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

describe("buildImportTemplateWorkbook", () => {
  const slug = `tmpl-${unique()}`;
  let zoneId: string;

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("templates.test.ts requires a *_test DATABASE_URL");
    }
    const [zone] = await db
      .insert(zones)
      .values({
        slug,
        name: "=Template Zone",
        countryCode: "GB",
        defaultCurrencyCode: "GBP",
        defaultTimeZone: "Europe/London",
        regionNameUnverified: `Region ${unique()}`,
        status: "active",
      })
      .returning({ id: zones.id });
    zoneId = zone.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from zones where slug = ${slug}`);
  });

  it("builds a branded empty workbook for each registered template", async () => {
    for (const template of IMPORTER_REGISTRY.filter((item) => item.enabled)) {
      const result = await buildImportTemplateWorkbook(db, { zoneId }, template.kind);
      expect(result.fileName).toBe(`${slug}-${template.kind}-template.xlsx`);
      expect(result.body.byteLength).toBeGreaterThan(1000);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(toArrayBuffer(result.body));
      const sheet = workbook.worksheets[0];
      expect(sheet.getCell("A1").value).toBe("'=Template Zone");
      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 6 });
      expect(sheet.getRow(6).values).toEqual([
        undefined,
        ...template.columns.map((column) => column.required ? `${column.header} *` : column.header),
      ]);
      expect(sheet.getRow(7).actualCellCount).toBe(0);
      expect(workbook.getWorksheet("Instructions")?.getCell("B5").value).toBe(template.sourceType);
    }
  });
});
