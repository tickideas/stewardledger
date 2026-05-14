// packages/api/src/services/reports/audit-log.ts
// Phase 7 — audit log report (REPORTS.md §2.13).
// Admin-facing flat list of zone-scoped audit events (actor, action,
// entity, before/after JSON) over a date window with optional
// actor/entity/action filters.
// RELEVANT FILES: packages/db/src/schema/audit.ts, packages/api/src/services/audit.ts, packages/api/src/services/reports/registry.ts, packages/api/src/services/reports/reports.test.ts

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import { auditEvents, user as userTable } from "@stewardledger/db/schema";
import { hasZoneAdminRole } from "./access";
import { addBrandedSheet, escapeExcelText } from "./branding";
import type { ReportColumn, ReportFetchResult, ReportSpec } from "./types";

export const auditLogFiltersSchema = z
  .object({
    dateFrom: z.string().date(),
    dateTo: z.string().date(),
    // Better Auth user ids are plain text (not uuid), so accept any
    // non-empty trimmed string here.
    actorUserId: z.string().trim().min(1).optional(),
    entityType: z.string().trim().min(1).optional(),
    entityId: z.string().trim().min(1).optional(),
    action: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });
export type AuditLogFilters = z.infer<typeof auditLogFiltersSchema>;

interface AuditLogRow {
  occurredAt: string;
  actorEmail: string | null;
  actorRoleCode: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  before: string | null;
  after: string | null;
}

const COLUMNS: ReportColumn[] = [
  { key: "occurredAt", label: "When", kind: "datetime" },
  { key: "actorEmail", label: "Actor", kind: "text", pii: true },
  { key: "actorRoleCode", label: "Role", kind: "text" },
  { key: "action", label: "Action", kind: "text" },
  { key: "reason", label: "Reason", kind: "text" },
  { key: "entityType", label: "Entity type", kind: "text" },
  { key: "entityId", label: "Entity id", kind: "text" },
  { key: "before", label: "Before", kind: "text" },
  { key: "after", label: "After", kind: "text" },
];

/**
 * Excel cell value limit is 32,767 characters. JSON-stringified
 * before/after payloads can occasionally exceed that (e.g. a full
 * contribution-batch snapshot). Soft-truncate so the export never
 * silently drops the trailing bytes — the marker tells a reader the
 * row was clipped and the raw value is still available via the API.
 */
const EXCEL_CELL_CHAR_LIMIT = 32_000;

function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = JSON.stringify(value);
  if (raw.length <= EXCEL_CELL_CHAR_LIMIT) return raw;
  return `${raw.slice(0, EXCEL_CELL_CHAR_LIMIT)}…(truncated)`;
}

export const auditLogReport: ReportSpec<AuditLogFilters, AuditLogRow> = {
  id: "audit-log",
  title: "Audit log",
  description:
    "Zone-scoped audit trail of sensitive writes. Filter by actor, entity, action, and date.",
  filtersSchema: auditLogFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx) => {
    // Audit-log is admin-tier: it surfaces every actor's edits across
    // the zone, which is sensitive even when read-only. Viewer roles
    // (zone_auditor, zone_pastor_viewer) and any chapter-scoped role
    // are denied outright — see REPORTS.md §2.13 ("admin-facing").
    if (!hasZoneAdminRole(ctx)) return "forbidden";
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<AuditLogRow>> {
    // Date semantics: `dateFrom` is inclusive from start-of-day UTC,
    // `dateTo` is inclusive of the whole day UTC. The column is
    // `timestamptz`, so we pin both boundaries to UTC explicitly —
    // otherwise Postgres' session `TimeZone` GUC would silently
    // shift the window between environments (test box vs prod).
    const conditions = [
      eq(auditEvents.zoneId, ctx.zoneId),
      sql`${auditEvents.occurredAt} >= (${filters.dateFrom}::date at time zone 'UTC')`,
      sql`${auditEvents.occurredAt} < ((${filters.dateTo}::date + interval '1 day') at time zone 'UTC')`,
    ];
    if (filters.actorUserId) {
      conditions.push(eq(auditEvents.actorUserId, filters.actorUserId));
    }
    if (filters.entityType) {
      conditions.push(eq(auditEvents.entityType, filters.entityType));
    }
    if (filters.entityId) {
      conditions.push(eq(auditEvents.entityId, filters.entityId));
    }
    if (filters.action) {
      conditions.push(eq(auditEvents.action, filters.action));
    }

    const rows = await database
      .select({
        id: auditEvents.id,
        occurredAt: auditEvents.occurredAt,
        actorEmail: userTable.email,
        actorRoleCode: auditEvents.actorRoleCode,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        reason: auditEvents.reason,
        before: auditEvents.before,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .leftJoin(userTable, eq(userTable.id, auditEvents.actorUserId))
      .where(and(...conditions))
      // Stable tie-breaker on `id` for events sharing an
      // `occurred_at` microsecond. Note: `id` is a random UUID so the
      // tie-breaker is stable across queries but is *not*
      // chronological — events written inside the same transaction
      // may render in any relative order.
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id));

    const mapped: AuditLogRow[] = rows.map((r) => ({
      occurredAt: r.occurredAt.toISOString(),
      actorEmail: r.actorEmail,
      actorRoleCode: r.actorRoleCode,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      reason: r.reason,
      before: stringifyJson(r.before),
      after: stringifyJson(r.after),
    }));

    return { rows: mapped, meta: { eventCount: mapped.length } };
  },
  async excel(rows, _subtotals, filters, branding) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const filterParts: string[] = [`Period ${filters.dateFrom} -> ${filters.dateTo}`];
    if (filters.actorUserId) filterParts.push(`Actor ${filters.actorUserId}`);
    if (filters.entityType) filterParts.push(`Entity type ${filters.entityType}`);
    if (filters.entityId) filterParts.push(`Entity ${filters.entityId}`);
    if (filters.action) filterParts.push(`Action ${filters.action}`);

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Audit log",
      branding,
      reportTitle: "Audit log",
      filterSummary: filterParts.join("  •  "),
      columnCount: COLUMNS.length,
    });

    const headerRow = sheet.getRow(6);
    COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true };
      cell.alignment = { horizontal: "left" };
    });
    headerRow.commit();

    // Every column is user / system controlled text. Audit reasons
    // and JSON payloads can contain values that start with `=`, `+`,
    // `-`, or `@` — route every string through `escapeExcelText` so
    // a poisoned value never executes when a workbook is opened.
    // The `When` column ships as a real Date so spreadsheets can
    // sort it numerically.
    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      COLUMNS.forEach((col, i) => {
        const cell = dataRow.getCell(i + 1);
        const value = (row as unknown as Record<string, unknown>)[col.key];
        if (col.key === "occurredAt" && typeof value === "string") {
          cell.value = new Date(value);
          cell.numFmt = "yyyy-mm-dd hh:mm:ss";
        } else if (typeof value === "string") {
          cell.value = escapeExcelText(value);
        } else {
          cell.value = (value as ExcelJS.CellValue) ?? null;
        }
      });
      dataRow.commit();
      r += 1;
    }

    sheet.columns = COLUMNS.map((col) => ({
      header: undefined,
      key: col.key,
      width: 20,
    }));
    setWidthByKey(sheet, "occurredAt", 24);
    setWidthByKey(sheet, "actorEmail", 28);
    setWidthByKey(sheet, "action", 28);
    setWidthByKey(sheet, "reason", 32);
    setWidthByKey(sheet, "entityType", 22);
    setWidthByKey(sheet, "entityId", 24);
    setWidthByKey(sheet, "before", 40);
    setWidthByKey(sheet, "after", 40);

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};

function setWidthByKey(sheet: ExcelJS.Worksheet, key: string, width: number): void {
  const idx = COLUMNS.findIndex((c) => c.key === key) + 1;
  if (idx > 0) sheet.getColumn(idx).width = width;
}
