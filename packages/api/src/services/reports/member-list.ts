// packages/api/src/services/reports/member-list.ts
// Phase 7 — member list (REPORTS.md §2.12).
//
// Simple flat list of members in scope: zone-wide for finance/auditor
// readers; chapter-scoped for chapter readers. Exports to Excel.
//
// PII columns (email, mobile, dateOfBirth) are populated for every
// reader because the on-screen path already exposes them via
// /api/tenant/members; the role gating happens at the route layer
// (only export roles can hit the export endpoint).

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import ExcelJS from "exceljs";
import {
  chapters,
  maritalStatuses,
  memberTypes,
  members,
  titles,
} from "@stewardledger/db/schema";
import {
  uuidSchema,
} from "@stewardledger/shared";
import { addBrandedSheet, escapeExcelText } from "./branding";
import { hasAnyZoneRole } from "./access";
import type { ReportColumn, ReportFetchResult, ReportSpec } from "./types";

export const memberListFiltersSchema = z.object({
  chapterId: uuidSchema.optional(),
  isActive: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  memberTypeId: uuidSchema.optional(),
});
export type MemberListFilters = z.infer<typeof memberListFiltersSchema>;

interface MemberListRow {
  referenceCode: string;
  fullName: string;
  titleName: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  mobile: string | null;
  email: string | null;
  chapterReferenceCode: string | null;
  chapterName: string | null;
  memberType: string | null;
  maritalStatus: string | null;
  dateJoinedMinistry: string | null;
  isActive: boolean;
}

const COLUMNS: ReportColumn[] = [
  { key: "referenceCode", label: "Ref", kind: "text" },
  { key: "fullName", label: "Full name", kind: "text" },
  { key: "titleName", label: "Title", kind: "text" },
  { key: "gender", label: "Gender", kind: "text" },
  { key: "dateOfBirth", label: "DOB", kind: "date", pii: true },
  { key: "mobile", label: "Mobile", kind: "text", pii: true },
  { key: "email", label: "Email", kind: "text", pii: true },
  { key: "chapterReferenceCode", label: "Chapter ref", kind: "text" },
  { key: "chapterName", label: "Chapter", kind: "text" },
  { key: "memberType", label: "Member type", kind: "text" },
  { key: "maritalStatus", label: "Marital status", kind: "text" },
  { key: "dateJoinedMinistry", label: "Joined ministry", kind: "date" },
  { key: "isActive", label: "Active", kind: "text" },
];

export const memberListReport: ReportSpec<MemberListFilters, MemberListRow> = {
  id: "member-list",
  title: "Member list",
  description:
    "Active and inactive members in scope, with chapter, member type, and contact details.",
  filtersSchema: memberListFiltersSchema,
  columns: () => COLUMNS,
  accessCheck: (ctx, filters) => {
    // Chapter-scoped readers can only pull their bound chapters.
    if (hasAnyZoneRole(ctx)) return null;
    if (ctx.chapterIds.length === 0) return "forbidden";
    if (filters.chapterId && !ctx.chapterIds.includes(filters.chapterId)) {
      return "forbidden";
    }
    return null;
  },
  async fetch(database, ctx, filters): Promise<ReportFetchResult<MemberListRow>> {
    const conditions = [eq(members.zoneId, ctx.zoneId), isNull(members.deletedAt)];
    if (filters.isActive !== undefined) conditions.push(eq(members.isActive, filters.isActive));
    if (filters.memberTypeId) conditions.push(eq(members.memberTypeId, filters.memberTypeId));
    if (hasAnyZoneRole(ctx)) {
      if (filters.chapterId) conditions.push(eq(members.chapterId, filters.chapterId));
    } else {
      // Chapter-scoped: filter to bound chapters (accessCheck has
      // already rejected an out-of-scope filters.chapterId).
      if (filters.chapterId) {
        conditions.push(eq(members.chapterId, filters.chapterId));
      } else {
        conditions.push(inArray(members.chapterId, ctx.chapterIds));
      }
    }

    const rows = await database
      .select({
        referenceCode: members.referenceCode,
        fullName: members.fullName,
        firstName: members.firstName,
        lastName: members.lastName,
        gender: members.gender,
        dateOfBirth: members.dateOfBirth,
        mobile: members.mobile,
        email: members.email,
        chapterId: members.chapterId,
        dateJoinedMinistry: members.dateJoinedMinistry,
        isActive: members.isActive,
        titleName: titles.name,
        memberTypeName: memberTypes.name,
        maritalStatusName: maritalStatuses.name,
        chapterReferenceCode: chapters.referenceCode,
        chapterName: chapters.name,
      })
      .from(members)
      .leftJoin(
        titles,
        and(eq(titles.zoneId, members.zoneId), eq(titles.id, members.titleId)),
      )
      .leftJoin(
        memberTypes,
        and(
          eq(memberTypes.zoneId, members.zoneId),
          eq(memberTypes.id, members.memberTypeId),
        ),
      )
      .leftJoin(
        maritalStatuses,
        and(
          eq(maritalStatuses.zoneId, members.zoneId),
          eq(maritalStatuses.id, members.maritalStatusId),
        ),
      )
      .leftJoin(
        chapters,
        and(eq(chapters.zoneId, members.zoneId), eq(chapters.id, members.chapterId)),
      )
      .where(and(...conditions))
      .orderBy(asc(members.referenceCode));

    const mapped: MemberListRow[] = rows.map((m) => ({
      referenceCode: m.referenceCode,
      fullName: m.fullName ?? `${m.firstName} ${m.lastName ?? ""}`.trim(),
      titleName: m.titleName,
      gender: m.gender,
      dateOfBirth: m.dateOfBirth,
      mobile: m.mobile,
      email: m.email,
      chapterReferenceCode: m.chapterReferenceCode,
      chapterName: m.chapterName,
      memberType: m.memberTypeName,
      maritalStatus: m.maritalStatusName,
      dateJoinedMinistry: m.dateJoinedMinistry,
      isActive: m.isActive,
    }));
    return { rows: mapped };
  },
  async excel(rows, _subtotals, filters, branding) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = escapeExcelText(`StewardLedger — ${branding.zoneName}`);
    workbook.created = new Date();

    const filterParts: string[] = [];
    if (filters.chapterId) filterParts.push(`Chapter ${filters.chapterId}`);
    if (filters.isActive !== undefined)
      filterParts.push(filters.isActive ? "Active only" : "Inactive only");
    if (filters.memberTypeId) filterParts.push(`Type ${filters.memberTypeId}`);
    const filterSummary = filterParts.join("  •  ") || "All members";

    const sheet = addBrandedSheet({
      workbook,
      sheetName: "Members",
      branding,
      reportTitle: "Member list",
      filterSummary,
      columnCount: COLUMNS.length,
    });

    const headerRow = sheet.getRow(6);
    COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true };
    });
    headerRow.commit();

    // Every text column is user-controlled (member full name, email,
    // mobile, chapter name). Route through `escapeExcelText` so a
    // poisoned member name like `=cmd|'/c calc'!A0` can't fire when a
    // viewer opens the workbook.
    let r = 7;
    for (const row of rows) {
      const dataRow = sheet.getRow(r);
      COLUMNS.forEach((col, i) => {
        const cell = dataRow.getCell(i + 1);
        const v = (row as unknown as Record<string, unknown>)[col.key];
        if (col.key === "isActive") {
          cell.value = row.isActive ? "Active" : "Inactive";
        } else if (typeof v === "string") {
          cell.value = escapeExcelText(v);
        } else {
          cell.value = (v as ExcelJS.CellValue) ?? null;
        }
      });
      dataRow.commit();
      r += 1;
    }

    sheet.columns = COLUMNS.map((col) => ({
      header: undefined,
      key: col.key,
      width: col.kind === "text" ? 22 : 14,
    }));
    sheet.getColumn(2).width = 30; // full name
    sheet.getColumn(9).width = 24; // chapter name

    const buf = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  },
};
