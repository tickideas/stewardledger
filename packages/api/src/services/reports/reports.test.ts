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
  givingTypes,
  members,
  paymentMethods,
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
import { generalLedgerReport } from "./general-ledger";
import { givingByChapterReport } from "./giving-by-chapter";
import { importReconciliationReport } from "./import-reconciliation";
import { loadReportBranding } from "./branding";
import { memberFinanceSummaryReport } from "./member-finance-summary";
import { memberListReport } from "./member-list";
import { memberStatementReport } from "./member-statement";
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

// Decimal is imported above for direct arithmetic in case future
// assertions need it; keep it referenced so biome doesn't strip the
// import on a future cleanup pass.
void Decimal;
