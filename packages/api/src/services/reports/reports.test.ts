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
  applyContributionTriggers,
  chapters,
  givingTypes,
  members,
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
import { importReconciliationReport } from "./import-reconciliation";
import { loadReportBranding } from "./branding";
import { memberListReport } from "./member-list";
import { memberStatementReport } from "./member-statement";

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
  otherChapterId: string;
  memberIds: string[]; // [m0 in chapterA, m1 in chapterA, m2 in chapterB]
  memberRefs: string[];
  userId: string;
  givingTypeId: string;
  givingTypeShortCode: string;
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
    .returning({ id: chapters.id });

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

  const userId = `u-${unique()}`;
  await db.insert(userTable).values({
    id: userId,
    email: `${userId}@test.local`,
    emailVerified: true,
  });

  return {
    id: zone.id,
    chapterId: chapterA.id,
    otherChapterId: chapterB.id,
    memberIds,
    memberRefs,
    userId,
    givingTypeId: gt.id,
    givingTypeShortCode: gt.shortCode!,
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

  it("denies a chapter-scoped caller whose chapter does not own the member", async () => {
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
    // accessCheck passes (chapter B is bound); but the fetch returns
    // empty because the member's home chapter is not in the caller's
    // bindings — guarding the PII at the row level.
    expect(memberStatementReport.accessCheck?.(chapterScopedCtx, filters)).toBeNull();
    const result = await memberStatementReport.fetch(db, chapterScopedCtx, filters);
    expect(result.rows).toEqual([]);
    expect(result.subtotals).toEqual([]);
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

// Decimal is imported above for direct arithmetic in case future
// assertions need it; keep it referenced so biome doesn't strip the
// import on a future cleanup pass.
void Decimal;
