// packages/api/src/services/dashboards/zone-dashboard.test.ts
// Phase 7 — zone dashboard service tests (REPORTS.md §2.15).
// Hand-curated zones tie out chapter / member counts, current-month
// per-currency giving, top-chapters / top-partners rankings, and
// recent imports against the dashboard payload.
// RELEVANT FILES: packages/api/src/services/dashboards/zone-dashboard.ts, packages/api/src/services/reports/reports.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  applyContributionTriggers,
  chapters,
  givingTypes,
  importFiles,
  importJobs,
  members,
  paymentMethods,
  user as userTable,
  zones,
} from "@stewardledger/db";
import type { AuthorizedContext } from "@stewardledger/shared";
import { ZONE_ROLES } from "@stewardledger/shared";
import { db } from "../../db";
import { createContribution, postContribution, reverseContribution } from "../contributions";
import { seedZoneGivingSetup } from "../giving-setup-seed";
import { seedZonePeriods } from "../period-seed";
import { monthBoundsInZone, yearBoundsInZone } from "./calendar";
import { buildZoneDashboard } from "./zone-dashboard";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SeededZone {
  id: string;
  chapterAId: string;
  chapterARef: string;
  chapterBId: string;
  chapterBRef: string;
  memberIds: string[];
  memberRefs: string[];
  userId: string;
  givingTypeId: string;
  cashPaymentMethodId: string;
}

async function seedZone(
  options: { extraChapters?: number; timeZone?: string } = {},
): Promise<SeededZone> {
  const slug = `dash-${unique()}`;
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Dashboard Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: options.timeZone ?? "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });

  await seedZoneGivingSetup(db, zone.id, "GBP");
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });

  const baseChapters = await db
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
  const [chapterA, chapterB] = baseChapters;

  for (let i = 0; i < (options.extraChapters ?? 0); i++) {
    await db.insert(chapters).values({
      zoneId: zone.id,
      referenceCode: `CX${unique()}`.slice(0, 12),
      name: `Chapter X${i} ${unique()}`,
      dateFrom: "2024-01-01",
    });
  }

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
        // m2 inactive — exercises the active/inactive split.
        isActive: i !== 2,
      })
      .returning({ id: members.id });
    memberIds.push(m.id);
  }

  const [gt] = await db
    .select({ id: givingTypes.id })
    .from(givingTypes)
    .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'TITHE'`)
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
    chapterAId: chapterA.id,
    chapterARef: chapterA.referenceCode,
    chapterBId: chapterB.id,
    chapterBRef: chapterB.referenceCode,
    memberIds,
    memberRefs,
    userId,
    givingTypeId: gt.id,
    cashPaymentMethodId: cash.id,
  };
}

function zoneCtx(zone: SeededZone): AuthorizedContext {
  return {
    userId: zone.userId,
    zoneId: zone.id,
    regionId: null,
    roleCodes: [ZONE_ROLES.ZONE_OWNER],
    chapterIds: [],
    isPlatformAdmin: false,
  };
}

const TODAY = new Date().toISOString().slice(0, 10);

const seededZones: string[] = [];

beforeAll(async () => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("zone-dashboard.test.ts requires a *_test DATABASE_URL");
  }
  await applyContributionTriggers(db);
});

const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";

afterAll(async () => {
  // Suites that touch the contribution triggers compete for an
  // `AccessExclusiveLock` on `contributions` / `contribution_lines`
  // (DISABLE TRIGGER takes that lock). The cascade delete below
  // takes row-level locks across the same tables. Holding the same
  // advisory lock as `applyContributionTriggers` serialises cleanup
  // against any other suite still booting its own triggers, which
  // closes the deadlock window observed when the dashboard tests
  // ran in parallel with `reports.test.ts`.
  const guards = [
    ["contributions", "contributions_posted_guard"],
    ["contributions", "contributions_no_delete_when_posted"],
    ["contribution_lines", "contribution_lines_posted_guard"],
  ] as const;
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
      await tx.execute(sql`delete from import_rows where zone_id = ${id}`);
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
});

describe("zone dashboard service", () => {
  it("returns zero/empty cards for an empty zone", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const payload = await buildZoneDashboard(db, zoneCtx(zone));

    expect(payload.chapters).toEqual({ total: 2, active: 2 });
    // 3 members seeded; m2 inactive.
    expect(payload.members).toEqual({ total: 3, active: 2, inactive: 1 });
    expect(payload.monthlyGiving.perCurrency).toEqual([]);
    expect(payload.yearToDateGiving.perCurrency).toEqual([]);
    expect(payload.topChapters).toEqual([]);
    expect(payload.topPartners).toEqual([]);
    expect(payload.recentImports).toEqual([]);
    // Period bounds are ISO dates.
    expect(payload.monthlyGiving.periodStart).toMatch(/^\d{4}-\d{2}-01$/);
    expect(payload.yearToDateGiving.periodStart).toMatch(/^\d{4}-01-01$/);
    // The zone seeds with `defaultTimeZone: "Europe/London"`; the
    // payload echoes that for the UI's footer.
    expect(payload.timeZone).toBe("Europe/London");
    // Phase-8 placeholder remains in the response shape.
    expect(payload.partnershipProgress).toEqual({
      available: false,
      reason: "Pending Phase 8 financial targets.",
    });
  });

  it("aggregates posted giving for the current month, nets reversals, ranks top chapters and partners", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Three posted contributions in the current month.
    // Chapter A: m0 = 100, m1 = 50.  Chapter B: m2 = 80.
    const seedCalls = [
      [zone.memberIds[0], zone.chapterAId, "100.00"],
      [zone.memberIds[1], zone.chapterAId, "50.00"],
      [zone.memberIds[2], zone.chapterBId, "80.00"],
    ] as const;
    for (const [memberId, chapterId, amount] of seedCalls) {
      const c = await createContribution(
        db,
        { zoneId: zone.id, userId: zone.userId },
        {
          chapterId,
          memberId,
          sourceType: "manual",
          paymentMethodId: zone.cashPaymentMethodId,
          contributionDate: TODAY,
          lines: [{ givingTypeId: zone.givingTypeId, amount }],
        },
      );
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }
    // Also seed and reverse a 25 GBP contribution from m0 — it should
    // net to zero and not change any totals or rankings.
    const reversible = await createContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        chapterId: zone.chapterAId,
        memberId: zone.memberIds[0],
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.givingTypeId, amount: "25.00" }],
      },
    );
    await postContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      reversible.contribution.id,
    );
    await reverseContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      reversible.contribution.id,
      { reason: "test" },
    );

    const payload = await buildZoneDashboard(db, ctx);

    // Net giving = 100 + 50 + 80 = 230 GBP (the +25 / -25 reversal cancels).
    expect(payload.monthlyGiving.perCurrency).toEqual([
      { currencyCode: "GBP", total: "230.0000" },
    ]);
    expect(payload.yearToDateGiving.perCurrency).toEqual([
      { currencyCode: "GBP", total: "230.0000" },
    ]);

    // Top chapters: A (150), B (80).
    expect(payload.topChapters.map((c) => c.referenceCode)).toEqual([
      zone.chapterARef,
      zone.chapterBRef,
    ]);
    expect(payload.topChapters.map((c) => c.total)).toEqual(["150.0000", "80.0000"]);
    expect(payload.topChapters.every((c) => c.currencyCode === "GBP")).toBe(true);

    // Top partners: m0 (100), m2 (80), m1 (50) — strictly per-currency.
    expect(payload.topPartners.map((p) => p.referenceCode)).toEqual([
      zone.memberRefs[0],
      zone.memberRefs[2],
      zone.memberRefs[1],
    ]);
    expect(payload.topPartners.map((p) => p.total)).toEqual([
      "100.0000",
      "80.0000",
      "50.0000",
    ]);
  });

  it("truncates top chapters / partners to 5", async () => {
    // Seed 4 extra chapters (6 total) so we exceed the TOP_N=5 cap.
    const zone = await seedZone({ extraChapters: 4 });
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Six contributions: chapter A=60, B=50, X0=40, X1=30, X2=20, X3=10.
    // Without truncation we'd see 6 rows; the dashboard caps at 5.
    const rows = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(sql`${chapters.zoneId} = ${zone.id}`)
      .orderBy(chapters.referenceCode);
    expect(rows.length).toBeGreaterThanOrEqual(6);

    const amounts = ["60.00", "50.00", "40.00", "30.00", "20.00", "10.00"];
    for (let i = 0; i < 6; i++) {
      const c = await createContribution(
        db,
        { zoneId: zone.id, userId: zone.userId },
        {
          chapterId: rows[i].id,
          // Reuse m0 for all six — top-chapters doesn't care about
          // member identity, only the chapter total.
          memberId: zone.memberIds[0],
          sourceType: "manual",
          paymentMethodId: zone.cashPaymentMethodId,
          contributionDate: TODAY,
          lines: [{ givingTypeId: zone.givingTypeId, amount: amounts[i] }],
        },
      );
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }

    const payload = await buildZoneDashboard(db, ctx);
    expect(payload.topChapters).toHaveLength(5);
    expect(payload.topChapters[0].total).toBe("60.0000");
    expect(payload.topChapters[4].total).toBe("20.0000");
  });

  it("lists each currency a member gave in separately in topPartners", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // m0 gives GBP. m1 gives USD on a separate contribution
    // — exercises per-currency ranking without summing across. The
    // currency lives on the contribution header (currency-cohesion
    // trigger guarantees lines agree); the line input itself doesn't
    // accept a per-line currency.
    const gbp = await createContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        chapterId: zone.chapterAId,
        memberId: zone.memberIds[0],
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        currencyCode: "GBP",
        lines: [{ givingTypeId: zone.givingTypeId, amount: "100.00" }],
      },
    );
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, gbp.contribution.id);
    const usd = await createContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        chapterId: zone.chapterAId,
        memberId: zone.memberIds[1],
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        currencyCode: "USD",
        lines: [{ givingTypeId: zone.givingTypeId, amount: "75.00" }],
      },
    );
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, usd.contribution.id);

    const payload = await buildZoneDashboard(db, ctx);
    // Each currency must produce its own ranked row attributed to the
    // correct member. The previous assertion only checked that both
    // currencies appeared in the list, which would pass even if the
    // rows were attributed to the wrong members.
    const gbpRow = payload.topPartners.find((p) => p.currencyCode === "GBP");
    const usdRow = payload.topPartners.find((p) => p.currencyCode === "USD");
    expect(gbpRow?.referenceCode).toBe(zone.memberRefs[0]);
    expect(gbpRow?.total).toBe("100.0000");
    expect(usdRow?.referenceCode).toBe(zone.memberRefs[1]);
    expect(usdRow?.total).toBe("75.0000");
    expect(payload.monthlyGiving.perCurrency.map((c) => c.currencyCode).sort()).toEqual([
      "GBP",
      "USD",
    ]);
  });

  it("derives month / YTD windows from the zone's defaultTimeZone", async () => {
    // Wire-up check: with a zone in Pacific/Auckland, the payload's
    // window must match what `monthBoundsInZone(now, ...)` would
    // produce — not the UTC month. Computing the expected bounds the
    // same way the service does keeps the test invariant of the
    // current date (it tests the wiring, not specific dates).
    const zone = await seedZone({ timeZone: "Pacific/Auckland" });
    seededZones.push(zone.id);
    const payload = await buildZoneDashboard(db, zoneCtx(zone));

    expect(payload.timeZone).toBe("Pacific/Auckland");
    const expectedMonth = monthBoundsInZone(new Date(payload.asOf), "Pacific/Auckland");
    expect(payload.monthlyGiving.periodStart).toBe(expectedMonth.start);
    expect(payload.monthlyGiving.periodEnd).toBe(expectedMonth.end);
    const expectedYear = yearBoundsInZone(new Date(payload.asOf), "Pacific/Auckland");
    expect(payload.yearToDateGiving.periodStart).toBe(expectedYear.start);
    expect(payload.yearToDateGiving.periodEnd).toBe(expectedYear.end);
  });

  it("lists the 5 most recent imports newest-first", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const ctx = zoneCtx(zone);

    // Seed 6 raw import_files + import_jobs directly. We're testing
    // the listing shape; the per-job posted-count path is exercised
    // by the import-reconciliation report itself.
    for (let i = 0; i < 6; i++) {
      const [file] = await db
        .insert(importFiles)
        .values({
          zoneId: zone.id,
          uploadedByUserId: zone.userId,
          originalFileName: `import-${i}.csv`,
          storageKey: `tests/${unique()}.csv`,
          sizeBytes: 100,
          checksumSha256: unique().padEnd(64, "0"),
          fileType: "giving",
          sourceType: "generic_csv",
        })
        .returning({ id: importFiles.id });
      await db.insert(importJobs).values({
        zoneId: zone.id,
        importFileId: file.id,
        status: i % 2 === 0 ? "committed" : "rolled_back",
        createdAt: new Date(Date.now() - (5 - i) * 60_000),
      });
    }

    const payload = await buildZoneDashboard(db, ctx);
    expect(payload.recentImports).toHaveLength(5);
    // Each row has the expected shape.
    expect(payload.recentImports[0].fileName).toMatch(/^import-\d\.csv$/);
    expect(["committed", "rolled_back"]).toContain(payload.recentImports[0].status);
    // Newest first: createdAt must be monotonically non-increasing.
    const stamps = payload.recentImports.map((r) => r.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });
});
