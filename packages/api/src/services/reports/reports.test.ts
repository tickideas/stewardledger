// packages/api/src/services/reports/reports.test.ts
// Phase 7 — end-to-end coverage for the three PR-1 reports:
//   • member-statement: ties out per-currency totals against a
//     hand-curated dataset, exercises the reversal-nets-to-zero
//     invariant, and Excel-renders without throwing.
//   • import-reconciliation: a committed import job appears with its
//     posted-contribution count and per-currency total; a rolled-back
//     job shows zero contributions posted.
//   • member-list: filters by chapter / isActive / memberType and
//     scopes to the caller's bindings.
//
// All three reports share the same access-check pattern; the route
// tests in `tenant-reports.test.ts` exercise role gating.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import {
  accounts,
  applyContributionTriggers,
  chapters,
  financialTargets,
  givingTypes,
  members,
  ministryYears,
  paymentMethods,
  serviceEventAttendance,
  serviceEvents,
  serviceTypes,
  user as userTable,
  zones,
} from "@stewardledger/db";
import type { AuthorizedContext } from "@stewardledger/shared";
import { ZONE_ROLES } from "@stewardledger/shared";
import { db } from "../../db";
import {
  commitImport,
  rollbackImport,
  scheduleImport,
  uploadImport,
} from "../imports";
import { ensurePlatformFailureTypes } from "../imports/failure-types";
import { seedZoneGivingSetup } from "../giving-setup-seed";
import { seedZonePeriods } from "../period-seed";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { createContribution, postContribution, reverseContribution } from "../contributions";
import { writeAudit } from "../audit";
import { auditLogReport } from "./audit-log";
import { envelopeLedgerReport } from "./envelope-ledger";
import { generalLedgerReport } from "./general-ledger";
import { givingByChapterReport } from "./giving-by-chapter";
import { importReconciliationReport } from "./import-reconciliation";
import { loadReportBranding } from "./branding";
import { memberFinanceSummaryReport } from "./member-finance-summary";
import { memberListReport } from "./member-list";
import { memberStatementReport } from "./member-statement";
import { onlineGivingLedgerReport } from "./online-giving-ledger";
import { partnershipProgressReport } from "./partnership-progress";
import { topChaptersReport } from "./top-chapters";
import { topPartnersReport } from "./top-partners";
import { weeklyFinanceReport } from "./weekly-finance";
import { ReportError, parseReportFilters } from "./types";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Copy a Uint8Array into a freshly-allocated ArrayBuffer. ExcelJS
 * accepts an ArrayBuffer / Buffer but TypeScript's `Uint8Array#buffer`
 * is `ArrayBufferLike` (can be `SharedArrayBuffer`); copying keeps the
 * loader happy regardless of the originating allocator.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

interface SeededZone {
  id: string;
  chapterId: string;
  chapterRef: string;
  otherChapterId: string;
  memberIds: string[]; // [m0 in chapterA, m1 in chapterA, m2 in chapterB]
  memberRefs: string[];
  userId: string;
  givingTypeId: string;
  givingTypeShortCode: string;
  offeringGivingTypeId: string;
  cashPaymentMethodId: string;
}

async function seedZone(): Promise<SeededZone> {
  const slug = `rpt-${unique()}`;
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Report Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });

  await seedZoneGivingSetup(db, zone.id, "GBP");
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });

  const [chapterA, chapterB] = await db
    .insert(chapters)
    .values([
      {
        zoneId: zone.id,
        referenceCode: `CA${unique()}`.slice(0, 12),
        name: `Chapter A ${unique()}`,
        dateFrom: "2024-01-01",
      },
      {
        zoneId: zone.id,
        referenceCode: `CB${unique()}`.slice(0, 12),
        name: `Chapter B ${unique()}`,
        dateFrom: "2024-01-01",
      },
    ])
    .returning({ id: chapters.id, referenceCode: chapters.referenceCode });

  const memberIds: string[] = [];
  const memberRefs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ref = `MR${unique()}`.slice(0, 10).toUpperCase();
    memberRefs.push(ref);
    const [m] = await db
      .insert(members)
      .values({
        zoneId: zone.id,
        chapterId: i < 2 ? chapterA.id : chapterB.id,
        referenceCode: ref,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        isActive: i !== 2, // m2 (chapter B) inactive
      })
      .returning({ id: members.id });
    memberIds.push(m.id);
  }

  const [gt] = await db
    .select({ id: givingTypes.id, shortCode: givingTypes.shortCode })
    .from(givingTypes)
    .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'TITHE'`)
    .limit(1);
  const [offering] = await db
    .select({ id: givingTypes.id })
    .from(givingTypes)
    .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'OFFERING'`)
    .limit(1);
  const [cash] = await db
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(sql`${paymentMethods.zoneId} = ${zone.id} and ${paymentMethods.code} = 'cash'`)
    .limit(1);

  const userId = `u-${unique()}`;
  await db.insert(userTable).values({
    id: userId,
    email: `${userId}@test.local`,
    emailVerified: true,
  });

  return {
    id: zone.id,
    chapterId: chapterA.id,
    chapterRef: chapterA.referenceCode,
    otherChapterId: chapterB.id,
    memberIds,
    memberRefs,
    userId,
    givingTypeId: gt.id,
    givingTypeShortCode: gt.shortCode!,
    offeringGivingTypeId: offering.id,
    cashPaymentMethodId: cash.id,
  };
}

function zoneCtx(zone: SeededZone): AuthorizedContext {
  return {
    userId: zone.userId,
    zoneId: zone.id,
    regionId: null,
    roleCodes: [ZONE_ROLES.ZONE_FINANCE_ADMIN],
    chapterIds: [],
    groupIds: [],
    isPlatformAdmin: false,
  };
}

const TODAY = new Date().toISOString().slice(0, 10);
function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function firstTuesdayOfYear(year: number): string {
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCDay() !== 2) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

const seededZones: string[] = [];

beforeAll(async () => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("reports.test.ts requires a *_test DATABASE_URL");
  }
  await applyContributionTriggers(db);
  await ensurePlatformFailureTypes(db);
  setStorageForTesting(new InMemoryStorage());
});

// Reuse the trigger-disable / per-zone cascade-cleanup pattern from
// imports.test.ts so the suite can be re-run on the same DB.
const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";

afterAll(async () => {
  const guards = [
    ["contributions", "contributions_posted_guard"],
    ["contributions", "contributions_no_delete_when_posted"],
    ["contribution_lines", "contribution_lines_posted_guard"],
  ] as const;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
      );
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
      }
      for (const id of seededZones) {
        await tx.execute(sql`delete from contribution_lines where zone_id = ${id}`);
        await tx.execute(sql`delete from contribution_members where zone_id = ${id}`);
        await tx.execute(sql`delete from processed_transactions where zone_id = ${id}`);
        await tx.execute(sql`delete from import_row_failures where zone_id = ${id}`);
        await tx.execute(sql`delete from import_rows where zone_id = ${id}`);
        await tx.execute(sql`delete from import_schedules where zone_id = ${id}`);
        await tx.execute(sql`delete from import_jobs where zone_id = ${id}`);
        await tx.execute(sql`delete from import_files where zone_id = ${id}`);
        await tx.execute(sql`delete from contributions where zone_id = ${id}`);
        await tx.execute(sql`delete from contribution_batches where zone_id = ${id}`);
        // service_events.chapter_id is FK ON DELETE RESTRICT, so the
        // event rows must go before the chapters they reference.
        // service_event_attendance cascades from service_events.
        await tx.execute(sql`delete from service_events where zone_id = ${id}`);
        // financial_targets.chapter_id is FK ON DELETE RESTRICT too;
        // chapter-scoped target rows must go before chapters.
        await tx.execute(sql`delete from financial_targets where zone_id = ${id}`);
        await tx.execute(sql`delete from members where zone_id = ${id}`);
        await tx.execute(sql`delete from chapters where zone_id = ${id}`);
        await tx.execute(sql`delete from zones where id = ${id}`);
      }
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
      }
    });
  } finally {
    setStorageForTesting(null);
  }
});

describe("member-statement report", () => {
  it("ties out per-currency totals on a hand-curated dataset and renders Excel", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Three contributions for member 0: 100, 50, 25 GBP — all posted.
    // Total = 175 GBP.
    const amounts = ["100.00", "50.00", "25.00"];
    const ids: string[] = [];
    for (const amount of amounts) {
      const created = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
        chapterId: zone.chapterId,
        memberId: zone.memberIds[0],
        sourceType: "manual",
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.givingTypeId, amount }],
      });
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, created.contribution.id);
      ids.push(created.contribution.id);
    }
    // Reverse the middle one (50 GBP); net should fall to 125 GBP.
    await reverseContribution(db, { zoneId: zone.id, userId: zone.userId }, ids[1], {
      reason: "test reversal",
    });

    const result = await memberStatementReport.fetch(db, ctx, {
      memberId: zone.memberIds[0],
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      includeVoided: false,
    });

    // 3 originals + 1 reversal line = 4 line rows (50 + -50 line in the reversal).
    expect(result.rows).toHaveLength(4);
    // Each row carries a giving type, an amount, and a currency.
    expect(result.rows.every((r) => r.currencyCode === "GBP")).toBe(true);
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "125.0000" }]);

    // Excel renders end-to-end without throwing; the workbook parses
    // back into a sheet with the branded header at A1.
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await memberStatementReport.excel(
      result.rows,
      result.subtotals,
      {
        memberId: zone.memberIds[0],
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        includeVoided: false,
      },
      branding,
      result.meta,
    );
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Statement");
    expect(sheet).toBeTruthy();
    // A1 carries the zone name as the branded title.
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
    // The column header row is row 6.
    expect(sheet!.getCell("A6").value).toBe("Date");
  });

  it("throws ReportError('forbidden') when the caller's chapter does not own the member", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.otherChapterId], // chapter B only — member 0 is in A
      groupIds: [],
      isPlatformAdmin: false,
    };

    const filters = {
      memberId: zone.memberIds[0],
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      includeVoided: false,
    };
    // accessCheck passes (chapter B is bound); the row-level enforcement
    // throws ReportError("forbidden") rather than returning empty so a
    // route caller cannot use the empty response as an existence oracle.
    expect(memberStatementReport.accessCheck?.(chapterScopedCtx, filters)).toBeNull();
    await expect(
      memberStatementReport.fetch(db, chapterScopedCtx, filters),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("folds nonexistent + out-of-scope into one 403 response for chapter-scoped callers", async () => {
    // Existence-oracle guard: a chapter-scoped caller probing a random
    // UUID must receive the same 403 a real-but-out-of-scope member id
    // produces. Otherwise they can iterate UUIDs to learn which ones
    // resolve to actual members elsewhere in the zone.
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.otherChapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    // A syntactically valid UUID that doesn't resolve to any member.
    const phantomId = "00000000-0000-4000-8000-000000000000";
    await expect(
      memberStatementReport.fetch(db, chapterScopedCtx, {
        memberId: phantomId,
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        includeVoided: false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // Zone-wide reader still gets an empty 200 for a phantom id
    // (no PII leak — they can already see every member).
    const empty = await memberStatementReport.fetch(db, zoneCtx(zone), {
      memberId: phantomId,
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      includeVoided: false,
    });
    expect(empty.rows).toEqual([]);
  });

  it("escapes formula-injection prefixes in description cells", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Poisoned description on a posted contribution. Every text cell
    // in the workbook flows through the same `escapeExcelText` helper
    // (member-statement.ts:291-293), so exercising the description
    // path is sufficient to assert the helper fires.
    const created = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      contributionDate: TODAY,
      description: `=HYPERLINK("http://attacker/x","click")`,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, created.contribution.id);

    const result = await memberStatementReport.fetch(db, ctx, {
      memberId: zone.memberIds[0],
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      includeVoided: false,
    });
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await memberStatementReport.excel(
      result.rows,
      result.subtotals,
      {
        memberId: zone.memberIds[0],
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        includeVoided: false,
      },
      branding,
      result.meta,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Statement")!;
    // Find the description column (last of COLUMNS array).
    const headerRow = sheet.getRow(6);
    let descCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Description") descCol = col;
    });
    expect(descCol).toBeGreaterThan(0);
    const dataRow = sheet.getRow(7);
    const descValue = dataRow.getCell(descCol).value;
    // The leading `=` MUST have been escaped to a literal apostrophe-
    // prefixed string so Excel renders it as text, not a formula.
    // ExcelJS stores the apostrophe-escaped value verbatim; what
    // matters is that the *raw* cell value no longer begins with `=`.
    expect(typeof descValue === "string" && descValue.startsWith("=")).toBe(false);
  });
});

describe("import-reconciliation tenancy", () => {
  it("scopes chapter-scoped callers to their bound chapters' import jobs", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    // Commit one import for each chapter so we have two jobs to
    // discriminate.
    const csvForChapterA = [
      "date,member reference,giving type code,amount,reference,currency",
      `${TODAY},${zone.memberRefs[0]},TITHE,11.00,SCOPE-A,GBP`,
    ].join("\n");
    const csvForChapterB = [
      "date,member reference,giving type code,amount,reference,currency",
      `${TODAY},${zone.memberRefs[2]},TITHE,22.00,SCOPE-B,GBP`,
    ].join("\n");
    const uploadedA = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "scope-a.csv",
      body: new TextEncoder().encode(csvForChapterA),
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
    });
    const uploadedB = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "scope-b.csv",
      body: new TextEncoder().encode(csvForChapterB),
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.otherChapterId,
    });

    const chapterAReader: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    // accessCheck passes (caller has at least one binding).
    expect(importReconciliationReport.accessCheck?.(chapterAReader, {})).toBeNull();

    // fetch returns only the chapter-A job; chapter-B's job is invisible.
    const result = await importReconciliationReport.fetch(db, chapterAReader, {
      dateFrom: shiftDays(TODAY, -1),
    });
    const visibleJobIds = result.rows.map((r) => r.importJobId);
    expect(visibleJobIds).toContain(uploadedA.importJobId);
    expect(visibleJobIds).not.toContain(uploadedB.importJobId);

    // Zone-wide reader sees both.
    const both = await importReconciliationReport.fetch(db, zoneCtx(zone), {
      dateFrom: shiftDays(TODAY, -1),
    });
    const bothIds = both.rows.map((r) => r.importJobId);
    expect(bothIds).toContain(uploadedA.importJobId);
    expect(bothIds).toContain(uploadedB.importJobId);
  });

  it("denies a chapter-scoped caller with no bindings via accessCheck", () => {
    const noBindings: AuthorizedContext = {
      userId: "u-x",
      zoneId: "z-x",
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [],
      groupIds: [],
      isPlatformAdmin: false,
    };
    expect(importReconciliationReport.accessCheck?.(noBindings, {})).toBe("forbidden");
  });
});

describe("import-reconciliation report", () => {
  it("surfaces a committed job with posted contributions + per-currency total", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const csv = [
      "date,member reference,giving type code,amount,reference,currency",
      `${TODAY},${zone.memberRefs[0]},TITHE,100.00,REC-A,GBP`,
      `${TODAY},${zone.memberRefs[1]},TITHE,40.00,REC-B,GBP`,
    ].join("\n");
    const body = new TextEncoder().encode(csv);

    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "recon.csv",
      body,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);

    const result = await importReconciliationReport.fetch(db, zoneCtx(zone), {
      importJobId: uploaded.importJobId,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.status).toBe("committed");
    expect(row.committedRows).toBe(2);
    expect(row.contributionsPosted).toBe(2);
    expect(row.totalsByCurrency).toEqual([
      { currencyCode: "GBP", total: "140.0000" },
    ]);
    expect(result.subtotals).toEqual([
      { currencyCode: "GBP", total: "140.0000" },
    ]);
  });

  it("shows zero contributions posted after a rollback", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const csv = [
      "date,member reference,giving type code,amount,reference,currency",
      `${TODAY},${zone.memberRefs[0]},TITHE,20.00,REC-RB-A,GBP`,
    ].join("\n");
    const body = new TextEncoder().encode(csv);
    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "rollback.csv",
      body,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    await rollbackImport(
      db,
      { zoneId: zone.id, userId: zone.userId },
      uploaded.importJobId,
      { reason: "wrong file" },
    );

    const result = await importReconciliationReport.fetch(db, zoneCtx(zone), {
      importJobId: uploaded.importJobId,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("rolled_back");
    // The contribution was voided by rollback; the report excludes
    // voided rows from the posted tally.
    expect(result.rows[0].contributionsPosted).toBe(0);
    expect(result.rows[0].totalsByCurrency).toEqual([]);
  });
});

describe("member-statement filter schema", () => {
  it("rejects dateFrom > dateTo via parseReportFilters as invalid_filters", () => {
    // Drive the route's validation entry point so the test exercises
    // the same path the API does, not just the schema in isolation.
    let caught: unknown = null;
    try {
      parseReportFilters(memberStatementReport, {
        memberId: "00000000-0000-0000-0000-000000000000",
        dateFrom: "2025-12-31",
        dateTo: "2025-01-01",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReportError);
    expect((caught as ReportError).code).toBe("invalid_filters");
  });
});

describe("member-finance-summary report", () => {
  it("pivots per-member totals by giving type and renders Excel", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const first = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "100.00" },
        { givingTypeId: zone.offeringGivingTypeId, amount: "25.00" },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, first.contribution.id);

    const second = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[1],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "40.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, second.contribution.id);

    const result = await memberFinanceSummaryReport.fetch(db, ctx, {
      chapterId: zone.chapterId,
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(result.rows).toHaveLength(2);
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "165.0000" }]);

    const columns = result.columns as Array<{ key: string; label: string }> | undefined;
    const titheCol = columns?.find((c) => c.label.startsWith("TITHE - "));
    const offeringCol = columns?.find((c) => c.label.startsWith("OFFERING - "));
    expect(titheCol).toBeTruthy();
    expect(offeringCol).toBeTruthy();

    const member0 = result.rows.find((r) => r.memberReferenceCode === zone.memberRefs[0]);
    expect(member0?.[titheCol!.key]).toBe("100.0000");
    expect(member0?.[offeringCol!.key]).toBe("25.0000");
    expect(member0?.total).toBe("125.0000");

    const member1 = result.rows.find((r) => r.memberReferenceCode === zone.memberRefs[1]);
    expect(member1?.[titheCol!.key]).toBe("40.0000");
    expect(member1?.[offeringCol!.key]).toBe("0.0000");
    expect(member1?.total).toBe("40.0000");

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await memberFinanceSummaryReport.excel(
      result.rows,
      result.subtotals,
      {
        chapterId: zone.chapterId,
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
      },
      branding,
      result.meta,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Member summary");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("escapes formula-injection prefixes in dynamic giving-type headers", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    await db
      .update(givingTypes)
      .set({
        name: `=HYPERLINK("http://attacker/x","click")`,
        shortCode: null,
      })
      .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.id} = ${zone.offeringGivingTypeId}`);

    const result = await memberFinanceSummaryReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await memberFinanceSummaryReport.excel(
      result.rows,
      result.subtotals,
      {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
      },
      branding,
      result.meta,
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Member summary")!;
    const headerRow = sheet.getRow(6);
    const values: unknown[] = [];
    headerRow.eachCell((cell) => values.push(cell.value));
    const poisonedHeader = values.find(
      (value) => typeof value === "string" && value.includes("HYPERLINK"),
    );
    expect(poisonedHeader).toBeDefined();
    expect(typeof poisonedHeader).toBe("string");
    expect(poisonedHeader as string).not.toMatch(/^=/);
  });

  it("includes inactive giving types so historical totals tie out", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    await db
      .update(givingTypes)
      .set({ isActive: false })
      .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.id} = ${zone.offeringGivingTypeId}`);

    const contribution = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.offeringGivingTypeId, amount: "45.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, contribution.contribution.id);

    const result = await memberFinanceSummaryReport.fetch(db, ctx, {
      givingTypeId: zone.offeringGivingTypeId,
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });

    const inactiveCol = result.columns?.find((c) => c.label.includes("(inactive)"));
    expect(inactiveCol).toBeTruthy();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][inactiveCol!.key]).toBe("45.0000");
    expect(result.rows[0].total).toBe("45.0000");
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "45.0000" }]);
  });

  it("aggregates same-member giving into one visible ISO-week period row", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);
    const firstDate = firstTuesdayOfYear(new Date().getUTCFullYear());
    const secondDate = shiftDays(firstDate, 1);

    const first = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: firstDate,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, first.contribution.id);

    const second = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: secondDate,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "20.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, second.contribution.id);

    const result = await memberFinanceSummaryReport.fetch(db, ctx, {
      chapterId: zone.chapterId,
      dateFrom: firstDate,
      dateTo: secondDate,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].periodLabel).toMatch(/^ISO \d{4}-W\d{2}$/);
    expect(result.rows[0].total).toBe("30.0000");
  });

  it("scopes chapter callers and rejects an out-of-scope chapter filter", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    const denial = memberFinanceSummaryReport.accessCheck?.(chapterScopedCtx, {
      chapterId: zone.otherChapterId,
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(denial).toBe("forbidden");

    const inScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "15.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, inScope.contribution.id);

    const outOfScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, outOfScope.contribution.id);

    const result = await memberFinanceSummaryReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].chapterReferenceCode).toBe(zone.chapterRef);
    expect(result.rows[0].total).toBe("15.0000");
  });
});

describe("member-list report", () => {
  it("scopes to bound chapters for a chapter-scoped caller", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    // Without filter: returns only the two chapter-A members.
    const result = await memberListReport.fetch(db, chapterScopedCtx, {});
    expect(result.rows.map((r) => r.referenceCode).sort()).toEqual(
      [zone.memberRefs[0], zone.memberRefs[1]].sort(),
    );
  });

  it("filters by isActive and renders Excel", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const result = await memberListReport.fetch(db, zoneCtx(zone), {
      isActive: false,
    });
    expect(result.rows.map((r) => r.referenceCode)).toEqual([zone.memberRefs[2]]);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await memberListReport.excel(
      result.rows,
      undefined,
      { isActive: false },
      branding,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Members");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("denies a chapter-scoped caller with an out-of-scope chapterId filter", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    const denial = memberListReport.accessCheck?.(chapterScopedCtx, {
      chapterId: zone.otherChapterId,
    });
    expect(denial).toBe("forbidden");
  });
});

describe("giving-by-chapter report", () => {
  it("pivots by giving type, ties out per-currency totals, and renders Excel", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Chapter A: 100 TITHE + 25 OFFERING + 40 TITHE = 165 total.
    // Chapter B: 60 OFFERING.
    const a1 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "100.00" },
        { givingTypeId: zone.offeringGivingTypeId, amount: "25.00" },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a1.contribution.id);
    const a2 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[1],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "40.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a2.contribution.id);
    const b1 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.offeringGivingTypeId, amount: "60.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, b1.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      pivotBy: "givingType" as const,
    };
    const result = await givingByChapterReport.fetch(db, ctx, filters);

    expect(result.rows).toHaveLength(2);
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "225.0000" }]);

    const columns = result.columns as Array<{ key: string; label: string }> | undefined;
    const titheCol = columns?.find((c) => c.label.startsWith("TITHE - "));
    const offeringCol = columns?.find((c) => c.label.startsWith("OFFERING - "));
    expect(titheCol).toBeTruthy();
    expect(offeringCol).toBeTruthy();

    const rowA = result.rows.find((r) => r.chapterReferenceCode === zone.chapterRef);
    expect(rowA?.[titheCol!.key]).toBe("140.0000");
    expect(rowA?.[offeringCol!.key]).toBe("25.0000");
    expect(rowA?.total).toBe("165.0000");

    const rowB = result.rows.find((r) => r.chapterReferenceCode !== zone.chapterRef);
    expect(rowB?.[titheCol!.key]).toBe("0.0000");
    expect(rowB?.[offeringCol!.key]).toBe("60.0000");
    expect(rowB?.total).toBe("60.0000");

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await givingByChapterReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
      result.meta,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Giving by chapter");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("pivots by category, aggregating multiple giving types under one parent", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const contribution = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "30.00" },
        { givingTypeId: zone.offeringGivingTypeId, amount: "20.00" },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, contribution.contribution.id);

    const result = await givingByChapterReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      pivotBy: "category",
    });

    const columns = result.columns as Array<{ key: string; label: string }> | undefined;
    // The seed assigns Tithe → "Tithes" category and Offering →
    // "Offerings" category, so both category columns should appear.
    const titheCatCol = columns?.find((c) => c.label.includes("TITHE -"));
    const offeringCatCol = columns?.find((c) => c.label.includes("OFFERING -"));
    expect(titheCatCol).toBeTruthy();
    expect(offeringCatCol).toBeTruthy();

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row[titheCatCol!.key]).toBe("30.0000");
    expect(row[offeringCatCol!.key]).toBe("20.0000");
    expect(row.total).toBe("50.0000");
  });

  it("pivots by month and emits one column per month present in the dataset", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Two dates in distinct months. Using fixed historical dates so
    // both fall inside the requested window regardless of when the
    // test runs.
    const firstDate = "2024-04-15";
    const secondDate = "2024-06-20";
    for (const [date, amount] of [
      [firstDate, "10.00"],
      [secondDate, "25.00"],
    ] as const) {
      const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
        chapterId: zone.chapterId,
        memberId: zone.memberIds[0],
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: date,
        lines: [{ givingTypeId: zone.givingTypeId, amount }],
      });
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }

    const result = await givingByChapterReport.fetch(db, ctx, {
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
      pivotBy: "month",
    });

    const columns = result.columns as Array<{ key: string; label: string }> | undefined;
    const monthColumns = columns?.filter((c) => c.label.match(/^\d{4}-\d{2}$/));
    expect(monthColumns?.map((c) => c.label)).toEqual(["2024-04", "2024-06"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].total).toBe("35.0000");
  });

  it("scopes chapter callers to bound chapters and rejects an out-of-scope chapterId filter", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    const denial = givingByChapterReport.accessCheck?.(chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      pivotBy: "givingType",
      chapterId: zone.otherChapterId,
    });
    expect(denial).toBe("forbidden");

    const inScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "15.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, inScope.contribution.id);

    const outOfScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, outOfScope.contribution.id);

    const result = await givingByChapterReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      pivotBy: "givingType",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].chapterReferenceCode).toBe(zone.chapterRef);
    expect(result.rows[0].total).toBe("15.0000");
  });

  it("nets reversals to zero inside the date range", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const original = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "80.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, original.contribution.id);
    await reverseContribution(db, { zoneId: zone.id, userId: zone.userId }, original.contribution.id, {
      reason: "test",
    });

    const result = await givingByChapterReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      pivotBy: "givingType",
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].total).toBe("0.0000");
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "0.0000" }]);
  });

  it("escapes formula-injection prefixes in dynamic pivot labels", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Poison the active TITHE giving type so its column header would
    // be a HYPERLINK formula in a naïve renderer.
    await db
      .update(givingTypes)
      .set({
        name: `=HYPERLINK("http://attacker/x","click")`,
        shortCode: null,
      })
      .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.id} = ${zone.givingTypeId}`);

    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      pivotBy: "givingType" as const,
    };
    const result = await givingByChapterReport.fetch(db, ctx, filters);
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await givingByChapterReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
      result.meta,
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Giving by chapter")!;
    const headerRow = sheet.getRow(6);
    const values: unknown[] = [];
    headerRow.eachCell((cell) => values.push(cell.value));
    const poisoned = values.find(
      (v) => typeof v === "string" && v.includes("HYPERLINK"),
    );
    expect(poisoned).toBeDefined();
    expect(typeof poisoned).toBe("string");
    expect(poisoned as string).not.toMatch(/^=/);
  });
});

describe("general-ledger report", () => {
  it("lists posted lines with per-currency totals across multiple chapters", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Chapter A: 100 TITHE + 25 OFFERING (manual, cash) by m0.
    // Chapter A: 40 TITHE (manual, cash) by m1.
    // Chapter B: 60 OFFERING (manual, cash) by m2.
    const a1 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "100.00" },
        { givingTypeId: zone.offeringGivingTypeId, amount: "25.00" },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a1.contribution.id);
    const a2 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[1],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "40.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a2.contribution.id);
    const b1 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.offeringGivingTypeId, amount: "60.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, b1.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    };
    const result = await generalLedgerReport.fetch(db, ctx, filters);

    // 4 lines total across the three contributions.
    expect(result.rows).toHaveLength(4);
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "225.0000" }]);

    // Every row carries the account label resolved via the
    // giving-type default (the seed has TITHE + OFFERING both on
    // "General Fund").
    expect(result.rows.every((r) => r.accountName === "General Fund")).toBe(true);

    // Excel renders end-to-end.
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await generalLedgerReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("General ledger");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
    expect(sheet!.getCell("A6").value).toBe("Date");
  });

  it("filters by chapter and by giving type", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const a = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "10.00" },
        { givingTypeId: zone.offeringGivingTypeId, amount: "20.00" },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a.contribution.id);
    const b = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "30.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, b.contribution.id);

    const onlyChapter = await generalLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      chapterId: zone.chapterId,
    });
    expect(onlyChapter.rows.map((r) => r.amount).sort()).toEqual(["10.0000", "20.0000"]);

    const onlyTithe = await generalLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      givingTypeId: zone.givingTypeId,
    });
    expect(onlyTithe.rows.map((r) => r.amount).sort()).toEqual(["10.0000", "30.0000"]);
  });

  it("filters by account using the line override > giving-type default rule", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Resolve General Fund + Partnership Fund ids from the seed.
    const [general] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.zoneId} = ${zone.id} and ${accounts.name} = 'General Fund'`)
      .limit(1);
    const [partnership] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.zoneId} = ${zone.id} and ${accounts.name} = 'Partnership Fund'`)
      .limit(1);

    // TITHE defaults to General Fund. Post one normal contribution
    // (account inherits General Fund) and one with a line-level
    // override pointing at Partnership Fund.
    const inherited = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "50.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, inherited.contribution.id);

    const overridden = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "75.00", accountId: partnership.id },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, overridden.contribution.id);

    const inGeneral = await generalLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      accountId: general.id,
    });
    expect(inGeneral.rows.map((r) => r.amount)).toEqual(["50.0000"]);

    const inPartnership = await generalLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      accountId: partnership.id,
    });
    expect(inPartnership.rows.map((r) => r.amount)).toEqual(["75.0000"]);
  });

  it("filters by source type", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const manual = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, manual.contribution.id);
    const online = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "online",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "20.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, online.contribution.id);

    const onlyManual = await generalLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      sourceType: "manual",
    });
    expect(onlyManual.rows).toHaveLength(1);
    expect(onlyManual.rows[0].sourceType).toBe("manual");
    expect(onlyManual.rows[0].amount).toBe("10.0000");
  });

  it("includes posted + reversal lines; reversal nets to zero", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const original = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "80.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, original.contribution.id);
    await reverseContribution(db, { zoneId: zone.id, userId: zone.userId }, original.contribution.id, {
      reason: "test reversal",
    });

    const result = await generalLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });

    // Two rows: the original line (status reversed) + the
    // corrective contribution's line (status posted, negative
    // amount, reversalOfContributionId set).
    expect(result.rows).toHaveLength(2);
    const reversalRow = result.rows.find((r) => r.reversalOfContributionId !== null);
    expect(reversalRow).toBeTruthy();
    expect(new Decimal(reversalRow!.amount).toString()).toBe("-80");
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "0.0000" }]);
  });

  it("clamps chapter-scoped callers to their bound chapters", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    expect(
      generalLedgerReport.accessCheck?.(chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        chapterId: zone.otherChapterId,
      }),
    ).toBe("forbidden");

    const inScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "15.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, inScope.contribution.id);
    const outOfScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, outOfScope.contribution.id);

    const result = await generalLedgerReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].chapterReferenceCode).toBe(zone.chapterRef);
    expect(result.rows[0].amount).toBe("15.0000");
  });

  it("escapes formula-injection prefixes in member names", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Poison member 0's name with a HYPERLINK payload. `fullName`
    // is a generated column; poisoning `firstName` propagates through
    // the `||` concat so the rendered `memberName` lands as a
    // formula-prefixed string.
    await db
      .update(members)
      .set({
        firstName: `=HYPERLINK("http://attacker/x","click")`,
      })
      .where(sql`${members.zoneId} = ${zone.id} and ${members.id} = ${zone.memberIds[0]}`);

    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    };
    const result = await generalLedgerReport.fetch(db, ctx, filters);
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await generalLedgerReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("General ledger")!;

    // Locate the Member column and assert the data row doesn't start
    // with `=` (escapeExcelText prefixes a literal apostrophe).
    const headerRow = sheet.getRow(6);
    let memberCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Member") memberCol = col;
    });
    expect(memberCol).toBeGreaterThan(0);
    const dataRow = sheet.getRow(7);
    const memberValue = dataRow.getCell(memberCol).value;
    expect(typeof memberValue === "string" && memberValue.startsWith("=")).toBe(false);
  });
});

describe("envelope-ledger report", () => {
  it("lists envelope contributions and rolls up lines per envelope; non-envelope sources are excluded", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Two envelope contributions for member 0 (multi-line) and
    // member 1 (single line). Plus a manual contribution that
    // must NOT appear in the envelope ledger.
    const env1 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "envelope",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "ENV-001",
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "100.00" },
        { givingTypeId: zone.offeringGivingTypeId, amount: "25.00" },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, env1.contribution.id);

    const env2 = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[1],
      sourceType: "envelope",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "ENV-002",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "40.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, env2.contribution.id);

    const manual = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, manual.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    };
    const result = await envelopeLedgerReport.fetch(db, ctx, filters);

    expect(result.rows).toHaveLength(2);
    const env001 = result.rows.find((r) => r.envelopeId === "ENV-001");
    const env002 = result.rows.find((r) => r.envelopeId === "ENV-002");
    expect(env001).toBeTruthy();
    expect(env002).toBeTruthy();
    // Lines summary lists both giving types for env1 (ordinal: TITHE then OFFERING).
    expect(env001!.linesSummary).toBe("TITHE 100.0000, OFFERING 25.0000");
    expect(env001!.totalAmount).toBe("125.0000");
    expect(env002!.linesSummary).toBe("TITHE 40.0000");
    expect(env002!.totalAmount).toBe("40.0000");
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "165.0000" }]);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await envelopeLedgerReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Envelope ledger");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("filters by chapter and by member", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    for (const [chapterId, memberId, ref, amount] of [
      [zone.chapterId, zone.memberIds[0], "E-A-0", "10.00"],
      [zone.chapterId, zone.memberIds[1], "E-A-1", "20.00"],
      [zone.otherChapterId, zone.memberIds[2], "E-B-2", "30.00"],
    ] as const) {
      const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
        chapterId,
        memberId,
        sourceType: "envelope",
        paymentMethodId: zone.cashPaymentMethodId,
        externalTransactionId: ref,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.givingTypeId, amount }],
      });
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }

    const onlyA = await envelopeLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      chapterId: zone.chapterId,
    });
    expect(onlyA.rows.map((r) => r.envelopeId).sort()).toEqual(["E-A-0", "E-A-1"]);

    const onlyMember0 = await envelopeLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      memberId: zone.memberIds[0],
    });
    expect(onlyMember0.rows.map((r) => r.envelopeId)).toEqual(["E-A-0"]);
  });

  it("clamps chapter-scoped callers to their bound chapters", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    expect(
      envelopeLedgerReport.accessCheck?.(chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        chapterId: zone.otherChapterId,
      }),
    ).toBe("forbidden");

    const inScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "envelope",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "E-IN",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "15.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, inScope.contribution.id);
    const outOfScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "envelope",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "E-OUT",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, outOfScope.contribution.id);

    const result = await envelopeLedgerReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].envelopeId).toBe("E-IN");
  });

  it("folds out-of-scope memberId into 403 for chapter-scoped callers (existence-oracle guard)", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    // Real member but in chapter B (the caller binds chapter A only).
    await expect(
      envelopeLedgerReport.fetch(db, chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        memberId: zone.memberIds[2],
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // Phantom uuid: same response, no oracle.
    await expect(
      envelopeLedgerReport.fetch(db, chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        memberId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("escapes formula-injection prefixes in member names", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Poison via firstName so the generated `fullName` carries the
    // payload through the `||` concat (same trick used in the
    // general-ledger formula-injection test).
    await db
      .update(members)
      .set({
        firstName: `=HYPERLINK("http://attacker/x","click")`,
      })
      .where(sql`${members.zoneId} = ${zone.id} and ${members.id} = ${zone.memberIds[0]}`);

    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "envelope",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "E-POISON",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    };
    const result = await envelopeLedgerReport.fetch(db, ctx, filters);
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await envelopeLedgerReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Envelope ledger")!;
    const headerRow = sheet.getRow(6);
    let memberCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Member") memberCol = col;
    });
    expect(memberCol).toBeGreaterThan(0);
    const memberValue = sheet.getRow(7).getCell(memberCol).value;
    expect(typeof memberValue === "string" && memberValue.startsWith("=")).toBe(false);
  });
});

describe("online-giving-ledger report", () => {
  it("lists only online + bank_import sources with per-currency totals", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const online = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "online",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "STRIPE-001",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "50.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, online.contribution.id);

    const bankImport = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[1],
      sourceType: "bank_import",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "BANK-002",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "30.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, bankImport.contribution.id);

    // These must NOT appear.
    const envelope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "envelope",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "ENV-X",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "77.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, envelope.contribution.id);
    const manual = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "88.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, manual.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    };
    const result = await onlineGivingLedgerReport.fetch(db, ctx, filters);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.sourceType).sort()).toEqual(["bank_import", "online"]);
    expect(result.rows.map((r) => r.transactionId).sort()).toEqual(["BANK-002", "STRIPE-001"]);
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "80.0000" }]);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await onlineGivingLedgerReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Online ledger");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("narrows to a single source when sourceType is supplied", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const online = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "online",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "TX-O",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, online.contribution.id);
    const bank = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "bank_import",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "TX-B",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "20.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, bank.contribution.id);

    const onlyOnline = await onlineGivingLedgerReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      sourceType: "online",
    });
    expect(onlyOnline.rows).toHaveLength(1);
    expect(onlyOnline.rows[0].transactionId).toBe("TX-O");
  });

  it("rejects an out-of-preset sourceType (envelope) via parseReportFilters", () => {
    let caught: unknown = null;
    try {
      parseReportFilters(onlineGivingLedgerReport, {
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
        sourceType: "envelope",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReportError);
    expect((caught as ReportError).code).toBe("invalid_filters");
  });

  it("clamps chapter-scoped callers to their bound chapters", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    expect(
      onlineGivingLedgerReport.accessCheck?.(chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        chapterId: zone.otherChapterId,
      }),
    ).toBe("forbidden");

    const inScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "online",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "TX-IN",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "15.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, inScope.contribution.id);
    const outOfScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "online",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: "TX-OUT",
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, outOfScope.contribution.id);

    const result = await onlineGivingLedgerReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(result.rows.map((r) => r.transactionId)).toEqual(["TX-IN"]);
  });

  it("escapes formula-injection prefixes in attacker-controlled transaction ids", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // A poisoned bank reference — a treasurer's bank statement could
    // carry an attacker-controlled memo like this.
    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "bank_import",
      paymentMethodId: zone.cashPaymentMethodId,
      externalTransactionId: `=HYPERLINK("http://attacker/x","click")`,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    };
    const result = await onlineGivingLedgerReport.fetch(db, ctx, filters);
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await onlineGivingLedgerReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Online ledger")!;
    const headerRow = sheet.getRow(6);
    let txCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Transaction id") txCol = col;
    });
    expect(txCol).toBeGreaterThan(0);
    const txValue = sheet.getRow(7).getCell(txCol).value;
    expect(typeof txValue === "string" && txValue.startsWith("=")).toBe(false);
  });
});

describe("top-partners report", () => {
  it("ranks members by total giving over the window with per-currency totals", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // m0: 100, m1: 200, m2: 50 GBP.
    for (const [memberId, chapterId, amount] of [
      [zone.memberIds[0], zone.chapterId, "100.00"],
      [zone.memberIds[1], zone.chapterId, "200.00"],
      [zone.memberIds[2], zone.otherChapterId, "50.00"],
    ] as const) {
      const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
        chapterId,
        memberId,
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.givingTypeId, amount }],
      });
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 20,
      partnershipOnly: false,
    };
    const result = await topPartnersReport.fetch(db, ctx, filters);

    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(result.rows.map((r) => r.memberReferenceCode)).toEqual([
      zone.memberRefs[1],
      zone.memberRefs[0],
      zone.memberRefs[2],
    ]);
    expect(result.rows.map((r) => r.total)).toEqual(["200.0000", "100.0000", "50.0000"]);
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "350.0000" }]);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await topPartnersReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Top partners");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("honours topN by truncating the ranking", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    for (const [memberId, amount] of [
      [zone.memberIds[0], "10.00"],
      [zone.memberIds[1], "20.00"],
      [zone.memberIds[2], "30.00"],
    ] as const) {
      const chapterId = memberId === zone.memberIds[2] ? zone.otherChapterId : zone.chapterId;
      const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
        chapterId,
        memberId,
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.givingTypeId, amount }],
      });
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }

    const result = await topPartnersReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 2,
      partnershipOnly: false,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.total)).toEqual(["30.0000", "20.0000"]);
  });

  it("partnershipOnly restricts to giving types with has_partnership_target=true", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Resolve the seeded PARTNER giving type (has_partnership_target=true).
    const [partnerType] = await db
      .select({ id: givingTypes.id })
      .from(givingTypes)
      .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'PARTNER'`)
      .limit(1);

    // m0: 200 TITHE + 50 PARTNER.
    // m1: 100 TITHE.
    // Without partnershipOnly: m0 (250), m1 (100).
    // With partnershipOnly: m0 (50), m1 absent.
    const a = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [
        { givingTypeId: zone.givingTypeId, amount: "200.00" },
        { givingTypeId: partnerType.id, amount: "50.00" },
      ],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a.contribution.id);
    const b = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[1],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "100.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, b.contribution.id);

    const all = await topPartnersReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 20,
      partnershipOnly: false,
    });
    expect(all.rows.map((r) => r.total)).toEqual(["250.0000", "100.0000"]);

    const partnership = await topPartnersReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 20,
      partnershipOnly: true,
    });
    expect(partnership.rows).toHaveLength(1);
    expect(partnership.rows[0].memberReferenceCode).toBe(zone.memberRefs[0]);
    expect(partnership.rows[0].total).toBe("50.0000");
  });

  it("clamps chapter-scoped callers to their bound chapters", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    expect(
      topPartnersReport.accessCheck?.(chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        topN: 20,
        partnershipOnly: false,
        chapterId: zone.otherChapterId,
      }),
    ).toBe("forbidden");

    const inScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "15.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, inScope.contribution.id);
    const outOfScope = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, outOfScope.contribution.id);

    const result = await topPartnersReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 20,
      partnershipOnly: false,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].memberReferenceCode).toBe(zone.memberRefs[0]);
  });

  it("escapes formula-injection prefixes in member names", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    await db
      .update(members)
      .set({ firstName: `=HYPERLINK("http://attacker/x","click")` })
      .where(sql`${members.zoneId} = ${zone.id} and ${members.id} = ${zone.memberIds[0]}`);

    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 20,
      partnershipOnly: false,
    };
    const result = await topPartnersReport.fetch(db, ctx, filters);
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await topPartnersReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Top partners")!;
    const headerRow = sheet.getRow(6);
    let memberCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Member") memberCol = col;
    });
    expect(memberCol).toBeGreaterThan(0);
    const memberValue = sheet.getRow(7).getCell(memberCol).value;
    expect(typeof memberValue === "string" && memberValue.startsWith("=")).toBe(false);
  });
});

describe("top-chapters report", () => {
  it("ranks chapters by total giving over the window", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Chapter A total: 100 + 50 = 150. Chapter B total: 80.
    for (const [memberId, chapterId, amount] of [
      [zone.memberIds[0], zone.chapterId, "100.00"],
      [zone.memberIds[1], zone.chapterId, "50.00"],
      [zone.memberIds[2], zone.otherChapterId, "80.00"],
    ] as const) {
      const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
        chapterId,
        memberId,
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.givingTypeId, amount }],
      });
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }

    const filters = {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 20,
      partnershipOnly: false,
    };
    const result = await topChaptersReport.fetch(db, ctx, filters);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(result.rows.map((r) => r.chapterReferenceCode)).toEqual([
      zone.chapterRef,
      result.rows[1].chapterReferenceCode, // chapter B, name resolved at runtime
    ]);
    expect(result.rows.map((r) => r.total)).toEqual(["150.0000", "80.0000"]);
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "230.0000" }]);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await topChaptersReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Top chapters");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("honours topN", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    for (const [memberId, chapterId, amount] of [
      [zone.memberIds[0], zone.chapterId, "10.00"],
      [zone.memberIds[2], zone.otherChapterId, "20.00"],
    ] as const) {
      const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
        chapterId,
        memberId,
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.givingTypeId, amount }],
      });
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }

    const result = await topChaptersReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 1,
      partnershipOnly: false,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].total).toBe("20.0000");
  });

  it("clamps chapter-scoped callers to their bound chapters", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    // accessCheck just requires at least one binding.
    expect(
      topChaptersReport.accessCheck?.(chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        topN: 20,
        partnershipOnly: false,
      }),
    ).toBeNull();

    // Seed contributions in both chapters; the scoped caller should
    // only see their bound chapter.
    const a = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "15.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a.contribution.id);
    const b = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "99.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, b.contribution.id);

    const result = await topChaptersReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
      topN: 20,
      partnershipOnly: false,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].chapterReferenceCode).toBe(zone.chapterRef);
    expect(result.rows[0].total).toBe("15.0000");
  });
});

describe("audit-log report", () => {
  const wideFilters = () => ({
    dateFrom: shiftDays(TODAY, -1),
    dateTo: shiftDays(TODAY, 1),
  });

  it("lists zone-scoped events newest-first and renders Excel", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      actorRoleCode: ZONE_ROLES.ZONE_FINANCE_ADMIN,
      action: "member.update",
      entityType: "member",
      entityId: zone.memberIds[0],
      after: { firstName: "Updated" },
      reason: "manual correction",
    });
    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      action: "chapter.create",
      entityType: "chapter",
      entityId: zone.chapterId,
      after: { name: "New chapter" },
    });
    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      action: "import.commit",
      entityType: "import_job",
      entityId: "job-xyz",
    });

    const result = await auditLogReport.fetch(db, ctx, wideFilters());
    // The zone is freshly seeded and no contributions are posted in
    // this test, so only the three audits we wrote land in the
    // window. Three sequential writeAudit calls can share `now()`
    // microsecond on a fast box, so assert membership rather than
    // exact ordering (the spec orders by occurredAt then id desc; the
    // newest-first invariant is exercised in the next assertion).
    expect(new Set(result.rows.map((r) => r.action))).toEqual(
      new Set(["member.update", "chapter.create", "import.commit"]),
    );
    expect(result.meta).toMatchObject({ eventCount: 3 });
    // Newest-first check: pull the timestamps and confirm monotonic
    // descending without assuming the chronological ordering of
    // three fast-back-to-back inserts.
    const stamps = result.rows.map((r) => r.occurredAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await auditLogReport.excel(
      result.rows,
      undefined,
      wideFilters(),
      branding,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Audit log");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
    expect(sheet!.getCell("A6").value).toBe("When");
  });

  it("filters by entityType and action", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      action: "member.update",
      entityType: "member",
      entityId: zone.memberIds[0],
    });
    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      action: "chapter.create",
      entityType: "chapter",
      entityId: zone.chapterId,
    });

    const byEntity = await auditLogReport.fetch(db, ctx, {
      ...wideFilters(),
      entityType: "member",
    });
    expect(byEntity.rows.every((r) => r.entityType === "member")).toBe(true);
    expect(byEntity.rows.some((r) => r.action === "member.update")).toBe(true);

    const byAction = await auditLogReport.fetch(db, ctx, {
      ...wideFilters(),
      action: "chapter.create",
    });
    expect(byAction.rows.every((r) => r.action === "chapter.create")).toBe(true);
  });

  it("excludes events outside the date window", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      action: "member.update",
      entityType: "member",
      entityId: zone.memberIds[0],
    });

    // A window in the distant past — no events should fall in it.
    const result = await auditLogReport.fetch(db, ctx, {
      dateFrom: "2000-01-01",
      dateTo: "2000-01-02",
    });
    expect(result.rows).toHaveLength(0);
  });

  it("denies non-admin callers via accessCheck (chapter + viewer roles)", () => {
    const baseCtx: Omit<AuthorizedContext, "roleCodes"> = {
      userId: "u-stub",
      zoneId: "z-stub",
      regionId: null,
      chapterIds: ["c-stub"],
      groupIds: [],
      isPlatformAdmin: false,
    };
    // Chapter-scoped role — no zone view at all.
    expect(
      auditLogReport.accessCheck?.(
        { ...baseCtx, roleCodes: ["chapter_treasurer"] } satisfies AuthorizedContext,
        wideFilters(),
      ),
    ).toBe("forbidden");
    // Zone viewer tiers are also denied: REPORTS.md §2.13 marks this
    // report admin-facing, and the trail itself is sensitive even
    // read-only (it exposes who edited what / when across the zone).
    expect(
      auditLogReport.accessCheck?.(
        {
          ...baseCtx,
          roleCodes: [ZONE_ROLES.ZONE_AUDITOR],
          chapterIds: [],
          groupIds: [],
        } satisfies AuthorizedContext,
        wideFilters(),
      ),
    ).toBe("forbidden");
    expect(
      auditLogReport.accessCheck?.(
        {
          ...baseCtx,
          roleCodes: [ZONE_ROLES.ZONE_PASTOR_VIEWER],
          chapterIds: [],
          groupIds: [],
        } satisfies AuthorizedContext,
        wideFilters(),
      ),
    ).toBe("forbidden");
    // Admin tiers pass.
    for (const code of [
      ZONE_ROLES.ZONE_OWNER,
      ZONE_ROLES.ZONE_ADMIN,
      ZONE_ROLES.ZONE_FINANCE_ADMIN,
    ]) {
      expect(
        auditLogReport.accessCheck?.(
          {
            ...baseCtx,
            roleCodes: [code],
            chapterIds: [],
            groupIds: [],
          } satisfies AuthorizedContext,
          wideFilters(),
        ),
      ).toBeNull();
    }
  });

  it("isolates events across zones", async () => {
    const zoneA = await seedZone();
    seededZones.push(zoneA.id);
    const zoneB = await seedZone();
    seededZones.push(zoneB.id);

    await writeAudit(db, {
      zoneId: zoneB.id,
      actorUserId: zoneB.userId,
      action: "member.update",
      entityType: "member",
      entityId: zoneB.memberIds[0],
      reason: "zone-B-only",
    });

    const result = await auditLogReport.fetch(db, zoneCtx(zoneA), wideFilters());
    expect(result.rows.some((r) => r.reason === "zone-B-only")).toBe(false);
  });

  it("soft-truncates oversized before/after JSON to the Excel cell limit", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // 40k chars exceeds Excel's 32,767 cell limit; the JSON wrapper
    // ("...") adds two more chars so the raw stringify lands well
    // above the threshold.
    const huge = "x".repeat(40_000);
    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      action: "member.update",
      entityType: "member",
      entityId: zone.memberIds[0],
      after: { blob: huge },
    });

    const result = await auditLogReport.fetch(db, ctx, wideFilters());
    const target = result.rows.find((r) => r.action === "member.update");
    expect(target).toBeTruthy();
    // The cell stays under the Excel limit and carries the truncation
    // marker so a reader can tell the row was clipped.
    expect(target!.after).not.toBeNull();
    expect(target!.after!.length).toBeLessThan(33_000);
    expect(target!.after).toMatch(/…\(truncated\)$/);
  });

  it("escapes formula-injection prefixes in reason", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: zone.userId,
      action: "member.update",
      entityType: "member",
      entityId: zone.memberIds[0],
      reason: '=HYPERLINK("http://attacker/x","click")',
    });

    const result = await auditLogReport.fetch(db, ctx, wideFilters());
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await auditLogReport.excel(
      result.rows,
      undefined,
      wideFilters(),
      branding,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Audit log")!;
    const headerRow = sheet.getRow(6);
    let reasonCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Reason") reasonCol = col;
    });
    expect(reasonCol).toBeGreaterThan(0);
    // Find the row whose reason starts with '=HYPERLINK after the
    // leading-apostrophe escape; assert no row exposes a raw `=` prefix.
    let foundEscaped = false;
    for (let r = 7; r <= sheet.rowCount; r++) {
      const v = sheet.getRow(r).getCell(reasonCol).value;
      if (typeof v === "string") {
        expect(v.startsWith("=")).toBe(false);
        if (v.startsWith("'=HYPERLINK")) foundEscaped = true;
      }
    }
    expect(foundEscaped).toBe(true);
  });
});

describe("weekly-finance report", () => {
  async function seedServiceTypeAndEvent(
    zone: SeededZone,
    chapterId: string,
    serviceDate: string,
  ): Promise<{ serviceEventId: string; serviceTypeId: string }> {
    const [serviceType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zone.id} and ${serviceTypes.shortCode} = 'SUN'`)
      .limit(1);
    const [event] = await db
      .insert(serviceEvents)
      .values({
        zoneId: zone.id,
        chapterId,
        serviceTypeId: serviceType.id,
        serviceDate,
      })
      .returning({ id: serviceEvents.id });
    return { serviceEventId: event.id, serviceTypeId: serviceType.id };
  }

  async function setAttendance(
    zoneId: string,
    serviceEventId: string,
    counts: { men: number; women: number; teens: number; children: number; firstTimers: number; newConverts: number },
  ): Promise<void> {
    await db.insert(serviceEventAttendance).values({
      zoneId,
      serviceEventId,
      ...counts,
    });
  }

  it("ties out per-event headcount + line totals for a curated dataset", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const { serviceEventId } = await seedServiceTypeAndEvent(zone, zone.chapterId, TODAY);
    await setAttendance(zone.id, serviceEventId, {
      men: 10,
      women: 15,
      teens: 4,
      children: 5,
      firstTimers: 1,
      newConverts: 0,
    });

    // Two posted contributions on this service event, plus one that
    // gets reversed (must net to zero in the line total).
    const a = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      serviceEventId,
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "100.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a.contribution.id);
    const b = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[1],
      serviceEventId,
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "50.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, b.contribution.id);
    const reversible = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      serviceEventId,
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "25.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, reversible.contribution.id);
    await reverseContribution(db, { zoneId: zone.id, userId: zone.userId }, reversible.contribution.id, { reason: "test" });

    const filters = { dateFrom: shiftDays(TODAY, -1), dateTo: shiftDays(TODAY, 1) };
    const result = await weeklyFinanceReport.fetch(db, ctx, filters);

    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(row.serviceEventId).toBe(serviceEventId);
    expect(row.men).toBe(10);
    expect(row.women).toBe(15);
    expect(row.teens).toBe(4);
    expect(row.children).toBe(5);
    expect(row.firstTimers).toBe(1);
    expect(row.newConverts).toBe(0);
    expect(row.totalAttendance).toBe(35);
    expect(row.lineTotal).toBe("150.0000"); // 100 + 50; reversed pair nets to zero
    expect(row.currencyCode).toBe("GBP");
    expect(result.subtotals).toEqual([{ currencyCode: "GBP", total: "150.0000" }]);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await weeklyFinanceReport.excel(result.rows, result.subtotals, filters, branding);
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Weekly finance");
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell("A1").value).toBe(branding.zoneName);
  });

  it("emits a zero-attendance row for a service event with no attendance recorded", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    const { serviceEventId } = await seedServiceTypeAndEvent(zone, zone.chapterId, TODAY);
    const a = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      serviceEventId,
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "20.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a.contribution.id);

    const result = await weeklyFinanceReport.fetch(db, ctx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(row.men).toBe(0);
    expect(row.women).toBe(0);
    expect(row.totalAttendance).toBe(0);
    expect(row.lineTotal).toBe("20.0000");
  });

  it("clamps chapter-scoped readers to their bound chapters", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    // Seed an in-scope and an out-of-scope event on the same date.
    // The out-of-scope event is the canary: the chapter-clamp must
    // drop it from the chapter-scoped caller's result.
    const inScope = await seedServiceTypeAndEvent(zone, zone.chapterId, TODAY);
    const outOfScope = await seedServiceTypeAndEvent(zone, zone.otherChapterId, TODAY);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    // accessCheck allows the request; the fetch only returns events
    // in bound chapters.
    expect(
      weeklyFinanceReport.accessCheck?.(chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
      }),
    ).toBeNull();
    const result = await weeklyFinanceReport.fetch(db, chapterScopedCtx, {
      dateFrom: shiftDays(TODAY, -1),
      dateTo: shiftDays(TODAY, 1),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].serviceEventId).toBe(inScope.serviceEventId);
    // The chapter-B event must NOT leak into the chapter-A caller's
    // result — explicit canary assertion to lock the invariant in.
    expect(
      result.rows.some((r) => r.serviceEventId === outOfScope.serviceEventId),
    ).toBe(false);

    // Out-of-scope chapterId filter is denied.
    expect(
      weeklyFinanceReport.accessCheck?.(chapterScopedCtx, {
        dateFrom: shiftDays(TODAY, -1),
        dateTo: shiftDays(TODAY, 1),
        chapterId: zone.otherChapterId,
      }),
    ).toBe("forbidden");
  });

  it("escapes formula-injection prefixes in service type name", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Poison the SUN service type's name.
    await db
      .update(serviceTypes)
      .set({ name: '=HYPERLINK("http://attacker/x","click")' })
      .where(sql`${serviceTypes.zoneId} = ${zone.id} and ${serviceTypes.shortCode} = 'SUN'`);

    const { serviceEventId } = await seedServiceTypeAndEvent(zone, zone.chapterId, TODAY);
    const a = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      serviceEventId,
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: zone.givingTypeId, amount: "10.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a.contribution.id);

    const filters = { dateFrom: shiftDays(TODAY, -1), dateTo: shiftDays(TODAY, 1) };
    const result = await weeklyFinanceReport.fetch(db, ctx, filters);
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await weeklyFinanceReport.excel(result.rows, result.subtotals, filters, branding);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Weekly finance")!;
    const headerRow = sheet.getRow(6);
    let typeCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Service type") typeCol = col;
    });
    expect(typeCol).toBeGreaterThan(0);
    const v = sheet.getRow(7).getCell(typeCol).value;
    expect(typeof v === "string" && v.startsWith("=")).toBe(false);
  });
});

describe("partnership-progress report", () => {
  async function seedTargetingContext(
    zone: SeededZone,
  ): Promise<{
    partnerGivingTypeId: string;
    ministryYearId: string;
    ministryYearStart: string;
    ministryYearEnd: string;
  }> {
    const [partner] = await db
      .select({ id: givingTypes.id })
      .from(givingTypes)
      .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'PARTNER'`)
      .limit(1);
    // Pick the ministry year that covers TODAY so the achieved-side
    // contributions on TODAY actually fall inside the window.
    const [my] = await db
      .select({
        id: ministryYears.id,
        startDate: ministryYears.startDate,
        endDate: ministryYears.endDate,
      })
      .from(ministryYears)
      .where(
        sql`${ministryYears.zoneId} = ${zone.id}
            and ${ministryYears.startDate} <= ${TODAY}::date
            and ${ministryYears.endDate} >= ${TODAY}::date`,
      )
      .limit(1);
    if (!my) throw new Error("No ministry year covers TODAY for the test seed.");
    return {
      partnerGivingTypeId: partner.id,
      ministryYearId: my.id,
      ministryYearStart: my.startDate,
      ministryYearEnd: my.endDate,
    };
  }

  it("ties out target vs achieved for a chapter-scoped partnership target", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);
    const { partnerGivingTypeId, ministryYearId } = await seedTargetingContext(zone);

    // 12k target, 1k monthly; achieved so far = 250 (one
    // contribution).
    await db.insert(financialTargets).values({
      zoneId: zone.id,
      chapterId: zone.chapterId,
      givingTypeId: partnerGivingTypeId,
      ministryYearId,
      fullTarget: "12000.0000",
      monthlyTarget: "1000.0000",
      weeklyBreakdown: "250.0000",
      currencyCode: "GBP",
    });
    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: partnerGivingTypeId, amount: "250.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const result = await partnershipProgressReport.fetch(db, ctx, {
      ministryYearId,
    });

    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(row.fullTarget).toBe("12000.0000");
    expect(row.achieved).toBe("250.0000");
    // 250 / 12000 = 2.0833...%; rounded to 1dp.
    expect(row.percentProgress).toBe("2.1%");
    expect(row.currencyCode).toBe("GBP");
    // The per-currency subtotal block is intentionally empty: zone-
    // wide and chapter-scoped targets can overlap, so summing
    // "achieved" across rows would double-count. The per-row
    // achieved figure is the canonical answer.
    expect(result.subtotals).toEqual([]);

    const branding = await loadReportBranding(db, zone.id);
    const bytes = await partnershipProgressReport.excel(
      result.rows,
      result.subtotals,
      { ministryYearId },
      branding,
    );
    expect(bytes.byteLength).toBeGreaterThan(500);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    expect(wb.getWorksheet("Partnership progress")).toBeTruthy();
  });

  it("excludes giving types whose has_partnership_target is false", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);
    const { ministryYearId } = await seedTargetingContext(zone);

    // Seed a target on OFFERING (which has_partnership_target=false
    // per the giving setup seed) and confirm it does not appear.
    await db.insert(financialTargets).values({
      zoneId: zone.id,
      chapterId: zone.chapterId,
      givingTypeId: zone.offeringGivingTypeId,
      ministryYearId,
      fullTarget: "5000.0000",
      currencyCode: "GBP",
    });
    const result = await partnershipProgressReport.fetch(db, ctx, { ministryYearId });
    expect(result.rows).toHaveLength(0);
  });

  it("zone-wide target aggregates across all chapters; chapter-scoped target stays scoped", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);
    const { partnerGivingTypeId, ministryYearId } = await seedTargetingContext(zone);

    // Zone-wide partnership target: 50k.
    await db.insert(financialTargets).values({
      zoneId: zone.id,
      chapterId: null,
      givingTypeId: partnerGivingTypeId,
      ministryYearId,
      fullTarget: "50000.0000",
      currencyCode: "GBP",
    });
    // Two contributions: 100 in chapter A, 60 in chapter B.
    const a = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: partnerGivingTypeId, amount: "100.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, a.contribution.id);
    const b = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.otherChapterId,
      memberId: zone.memberIds[2],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: partnerGivingTypeId, amount: "60.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, b.contribution.id);

    const result = await partnershipProgressReport.fetch(db, ctx, { ministryYearId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].chapterName).toBe("All chapters");
    // Zone-wide aggregates: 100 + 60 = 160.
    expect(result.rows[0].achieved).toBe("160.0000");
  });

  it("does not double-count when chapter-scoped and zone-wide targets overlap", async () => {
    // Both a chapter-A target and a zone-wide target exist on the
    // same partnership giving type, in the same currency. The same
    // 100 GBP contribution is visible to both targets' achieved
    // figures. The subtotal block stays empty so the consumer
    // doesn't read 200 instead of the real 100 GBP in the system.
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);
    const { partnerGivingTypeId, ministryYearId } = await seedTargetingContext(zone);

    await db.insert(financialTargets).values([
      {
        zoneId: zone.id,
        chapterId: zone.chapterId,
        givingTypeId: partnerGivingTypeId,
        ministryYearId,
        fullTarget: "1000.0000",
        currencyCode: "GBP",
      },
      {
        zoneId: zone.id,
        chapterId: null,
        givingTypeId: partnerGivingTypeId,
        ministryYearId,
        fullTarget: "5000.0000",
        currencyCode: "GBP",
      },
    ]);
    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: partnerGivingTypeId, amount: "100.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const result = await partnershipProgressReport.fetch(db, ctx, { ministryYearId });
    expect(result.rows).toHaveLength(2);
    // Both rows independently report achieved = 100; the chapter
    // target sees its chapter's bucket, the zone-wide target sees
    // the same chapter via the zone-wide aggregation.
    expect(result.rows.every((r) => r.achieved === "100.0000")).toBe(true);
    // Subtotal would have been 200 with a naive sum, but it must
    // stay empty because the underlying GBP in the system is 100.
    expect(result.subtotals).toEqual([]);
  });

  it("reversed contributions net to zero in the achieved column", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);
    const { partnerGivingTypeId, ministryYearId } = await seedTargetingContext(zone);

    await db.insert(financialTargets).values({
      zoneId: zone.id,
      chapterId: zone.chapterId,
      givingTypeId: partnerGivingTypeId,
      ministryYearId,
      fullTarget: "10000.0000",
      currencyCode: "GBP",
    });
    const c = await createContribution(db, { zoneId: zone.id, userId: zone.userId }, {
      chapterId: zone.chapterId,
      memberId: zone.memberIds[0],
      sourceType: "manual",
      paymentMethodId: zone.cashPaymentMethodId,
      contributionDate: TODAY,
      lines: [{ givingTypeId: partnerGivingTypeId, amount: "500.00" }],
    });
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    await reverseContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id, {
      reason: "test",
    });

    const result = await partnershipProgressReport.fetch(db, ctx, { ministryYearId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].achieved).toBe("0.0000");
  });

  it("clamps chapter-scoped readers to their bound chapters but keeps zone-wide rows visible", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const { partnerGivingTypeId, ministryYearId } = await seedTargetingContext(zone);

    // Seed three targets: chapter A, chapter B, zone-wide.
    await db.insert(financialTargets).values([
      {
        zoneId: zone.id,
        chapterId: zone.chapterId,
        givingTypeId: partnerGivingTypeId,
        ministryYearId,
        fullTarget: "1000.0000",
        currencyCode: "GBP",
      },
      {
        zoneId: zone.id,
        chapterId: zone.otherChapterId,
        givingTypeId: partnerGivingTypeId,
        ministryYearId,
        fullTarget: "2000.0000",
        currencyCode: "GBP",
      },
      {
        zoneId: zone.id,
        chapterId: null,
        givingTypeId: partnerGivingTypeId,
        ministryYearId,
        fullTarget: "3000.0000",
        currencyCode: "GBP",
      },
    ]);

    const chapterScopedCtx: AuthorizedContext = {
      userId: zone.userId,
      zoneId: zone.id,
      regionId: null,
      roleCodes: ["chapter_treasurer"],
      chapterIds: [zone.chapterId],
      groupIds: [],
      isPlatformAdmin: false,
    };

    // Out-of-scope chapter filter is denied.
    expect(
      partnershipProgressReport.accessCheck?.(chapterScopedCtx, {
        ministryYearId,
        chapterId: zone.otherChapterId,
      }),
    ).toBe("forbidden");

    const result = await partnershipProgressReport.fetch(db, chapterScopedCtx, {
      ministryYearId,
    });
    // Chapter A target + zone-wide target; chapter B's target is hidden.
    expect(result.rows).toHaveLength(2);
    expect(
      result.rows.some((r) => r.chapterReferenceCode === zone.chapterRef),
    ).toBe(true);
    expect(result.rows.some((r) => r.chapterName === "All chapters")).toBe(true);
  });

  it("escapes formula-injection prefixes in giving type name", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);
    const { partnerGivingTypeId, ministryYearId } = await seedTargetingContext(zone);

    await db
      .update(givingTypes)
      .set({ name: '=HYPERLINK("http://attacker/x","click")' })
      .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.id} = ${partnerGivingTypeId}`);

    await db.insert(financialTargets).values({
      zoneId: zone.id,
      chapterId: zone.chapterId,
      givingTypeId: partnerGivingTypeId,
      ministryYearId,
      fullTarget: "100.0000",
      currencyCode: "GBP",
    });
    const filters = { ministryYearId };
    const result = await partnershipProgressReport.fetch(db, ctx, filters);
    const branding = await loadReportBranding(db, zone.id);
    const bytes = await partnershipProgressReport.excel(
      result.rows,
      result.subtotals,
      filters,
      branding,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const sheet = wb.getWorksheet("Partnership progress")!;
    const headerRow = sheet.getRow(6);
    let typeCol = 0;
    headerRow.eachCell((cell, col) => {
      if (cell.value === "Giving type") typeCol = col;
    });
    expect(typeCol).toBeGreaterThan(0);
    const v = sheet.getRow(7).getCell(typeCol).value;
    expect(typeof v === "string" && v.startsWith("=")).toBe(false);
  });
});

// Decimal is imported above for direct arithmetic in case future
// assertions need it; keep it referenced so biome doesn't strip the
// import on a future cleanup pass.
void Decimal;
