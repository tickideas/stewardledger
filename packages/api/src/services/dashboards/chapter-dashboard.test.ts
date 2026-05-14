// packages/api/src/services/dashboards/chapter-dashboard.test.ts
// Phase 7 — chapter dashboard service tests (REPORTS.md §2.14).
// Tie out members / weekly / monthly / YTD totals, top-giving-types
// and top-partners rankings, pending-batch totals, and the recent
// contributions feed against a hand-curated chapter dataset.
// RELEVANT FILES: packages/api/src/services/dashboards/chapter-dashboard.ts, packages/api/src/services/dashboards/zone-dashboard.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  applyContributionTriggers,
  chapters,
  contributionBatches,
  givingTypes,
  members,
  paymentMethods,
  user as userTable,
  zones,
} from "@stewardledger/db";
import { db } from "../../db";
import { createContribution, postContribution, reverseContribution } from "../contributions";
import { seedZoneGivingSetup } from "../giving-setup-seed";
import { seedZonePeriods } from "../period-seed";
import { weekBoundsInZone } from "./calendar";
import {
  buildChapterDashboard,
  ChapterDashboardError,
} from "./chapter-dashboard";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SeededZone {
  id: string;
  chapterAId: string;
  chapterARef: string;
  chapterBId: string;
  memberIds: string[];
  memberRefs: string[];
  userId: string;
  titheGivingTypeId: string;
  offeringGivingTypeId: string;
  cashPaymentMethodId: string;
}

async function seedZone(): Promise<SeededZone> {
  const slug = `chdash-${unique()}`;
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Chapter Dashboard Zone ${unique()}`,
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
        // m0, m1 in chapter A; m2 in chapter B (out of scope for
        // chapter-A dashboard tests, exercises the cross-chapter
        // isolation invariant).
        chapterId: i < 2 ? chapterA.id : chapterB.id,
        referenceCode: ref,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        isActive: i !== 1, // m1 inactive
      })
      .returning({ id: members.id });
    memberIds.push(m.id);
  }

  const [tithe] = await db
    .select({ id: givingTypes.id })
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
    chapterAId: chapterA.id,
    chapterARef: chapterA.referenceCode,
    chapterBId: chapterB.id,
    memberIds,
    memberRefs,
    userId,
    titheGivingTypeId: tithe.id,
    offeringGivingTypeId: offering.id,
    cashPaymentMethodId: cash.id,
  };
}

const TODAY = new Date().toISOString().slice(0, 10);

const seededZones: string[] = [];

beforeAll(async () => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("chapter-dashboard.test.ts requires a *_test DATABASE_URL");
  }
  await applyContributionTriggers(db);
});

const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";

afterAll(async () => {
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

describe("chapter dashboard service", () => {
  it("returns zero/empty cards for an empty chapter", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const payload = await buildChapterDashboard(db, zone.id, zone.chapterAId);

    expect(payload.chapter.id).toBe(zone.chapterAId);
    expect(payload.chapter.referenceCode).toBe(zone.chapterARef);
    expect(payload.members).toEqual({ total: 2, active: 1, inactive: 1 });
    expect(payload.weeklyGiving.perCurrency).toEqual([]);
    expect(payload.monthlyGiving.perCurrency).toEqual([]);
    expect(payload.yearToDateGiving.perCurrency).toEqual([]);
    expect(payload.topGivingTypes).toEqual([]);
    expect(payload.topPartners).toEqual([]);
    expect(payload.pendingBatches).toEqual({ count: 0, perCurrency: [] });
    expect(payload.recentContributions).toEqual([]);
    expect(payload.timeZone).toBe("Europe/London");
    expect(payload.partnershipProgress).toEqual({
      available: false,
      reason: "Pending Phase 8 financial targets.",
    });
  });

  it("aggregates posted giving and ranks giving types / partners within the chapter", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    // Chapter A contributions today:
    //   m0 → 100 TITHE
    //   m0 → 30 OFFERING
    //   m1 → 70 TITHE
    // Plus a 25 TITHE contribution from m0 that gets reversed
    // (nets to zero, must not appear in tops or totals).
    const seeds = [
      [zone.memberIds[0], zone.titheGivingTypeId, "100.00"],
      [zone.memberIds[0], zone.offeringGivingTypeId, "30.00"],
      [zone.memberIds[1], zone.titheGivingTypeId, "70.00"],
    ] as const;
    for (const [memberId, givingTypeId, amount] of seeds) {
      const c = await createContribution(
        db,
        { zoneId: zone.id, userId: zone.userId },
        {
          chapterId: zone.chapterAId,
          memberId,
          sourceType: "manual",
          paymentMethodId: zone.cashPaymentMethodId,
          contributionDate: TODAY,
          lines: [{ givingTypeId, amount }],
        },
      );
      await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);
    }
    const reversible = await createContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        chapterId: zone.chapterAId,
        memberId: zone.memberIds[0],
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.titheGivingTypeId, amount: "25.00" }],
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

    // Chapter B contribution must NOT leak into chapter A totals.
    const otherChapter = await createContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        chapterId: zone.chapterBId,
        memberId: zone.memberIds[2],
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: TODAY,
        lines: [{ givingTypeId: zone.titheGivingTypeId, amount: "999.00" }],
      },
    );
    await postContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      otherChapter.contribution.id,
    );

    const payload = await buildChapterDashboard(db, zone.id, zone.chapterAId);

    // Net giving = 100 + 30 + 70 = 200 GBP. The reversed pair nets
    // to zero; chapter B's 999 must not leak in.
    expect(payload.monthlyGiving.perCurrency).toEqual([
      { currencyCode: "GBP", total: "200.0000" },
    ]);
    expect(payload.yearToDateGiving.perCurrency).toEqual([
      { currencyCode: "GBP", total: "200.0000" },
    ]);

    // Top giving types: TITHE 170, OFFERING 30.
    expect(payload.topGivingTypes.map((g) => g.shortCode)).toEqual(["TITHE", "OFFERING"]);
    expect(payload.topGivingTypes.map((g) => g.total)).toEqual(["170.0000", "30.0000"]);

    // Top partners (chapter A only): m0 (130), m1 (70).
    expect(payload.topPartners.map((p) => p.referenceCode)).toEqual([
      zone.memberRefs[0],
      zone.memberRefs[1],
    ]);
    expect(payload.topPartners.map((p) => p.total)).toEqual(["130.0000", "70.0000"]);

    // Recent contributions: 3 posted in chapter A (the +25/−25
    // reversed pair is excluded — the dashboard recent feed shows
    // posted contributions only).
    expect(payload.recentContributions).toHaveLength(3);
    expect(payload.recentContributions.every((c) => c.currencyCode === "GBP")).toBe(true);
    // Every recent contribution must resolve to a chapter-A member;
    // chapter B's m2 must never appear here. The previous version
    // of this assertion was a no-op (`some((ref) => true)`).
    const chapterAMemberNames = ["First0 Last0", "First1 Last1"];
    expect(
      payload.recentContributions.every(
        (c) => c.memberName !== null && chapterAMemberNames.includes(c.memberName),
      ),
    ).toBe(true);
    // Cross-chapter isolation invariant, made explicit: chapter B's
    // m2 must not appear in chapter A's topPartners either.
    expect(
      payload.topPartners.some((p) => p.referenceCode === zone.memberRefs[2]),
    ).toBe(false);
  });

  it("isolates weekly window: pre-week contributions land in YTD but not 'this week'", async () => {
    // Seed a contribution dated the day BEFORE the current ISO
    // week's Monday. It must land in YTD but NOT in 'this week'.
    // Derive the date from `weekBoundsInZone` itself so the test
    // doesn't drift around year boundaries.
    const zone = await seedZone();
    seededZones.push(zone.id);

    const { start: weekStart } = weekBoundsInZone(new Date(), "Europe/London");
    // One day before week start, evaluated as a pure date shift.
    const beforeWeek = (() => {
      const [y, m, d] = weekStart.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - 1);
      return dt.toISOString().slice(0, 10);
    })();
    // Guard: if the prior-week day happens to fall in the previous
    // civil year (Jan 1 ± a few days), skip the YTD assertion since
    // YTD won't include the date by design. Other assertions still
    // run.
    const inSameYear = beforeWeek.slice(0, 4) === weekStart.slice(0, 4);

    const c = await createContribution(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        chapterId: zone.chapterAId,
        memberId: zone.memberIds[0],
        sourceType: "manual",
        paymentMethodId: zone.cashPaymentMethodId,
        contributionDate: beforeWeek,
        lines: [{ givingTypeId: zone.titheGivingTypeId, amount: "42.00" }],
      },
    );
    await postContribution(db, { zoneId: zone.id, userId: zone.userId }, c.contribution.id);

    const payload = await buildChapterDashboard(db, zone.id, zone.chapterAId);
    expect(payload.weeklyGiving.perCurrency).toEqual([]);
    if (inSameYear) {
      expect(payload.yearToDateGiving.perCurrency).toEqual([
        { currencyCode: "GBP", total: "42.0000" },
      ]);
    }
  });

  it("totals pending batch cash + cheque per currency and excludes posted / voided", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    // Three pending batches: draft (50 cash), submitted (20 cash +
    // 10 cheque), approved (5 cash). Plus one posted batch that
    // must be excluded.
    await db.insert(contributionBatches).values([
      {
        zoneId: zone.id,
        chapterId: zone.chapterAId,
        sourceType: "manual",
        status: "draft",
        currencyCode: "GBP",
        cashTotal: "50.00",
      },
      {
        zoneId: zone.id,
        chapterId: zone.chapterAId,
        sourceType: "manual",
        status: "submitted",
        currencyCode: "GBP",
        cashTotal: "20.00",
        chequeTotal: "10.00",
      },
      {
        zoneId: zone.id,
        chapterId: zone.chapterAId,
        sourceType: "manual",
        status: "approved",
        currencyCode: "GBP",
        cashTotal: "5.00",
      },
      {
        zoneId: zone.id,
        chapterId: zone.chapterAId,
        sourceType: "manual",
        status: "voided",
        currencyCode: "GBP",
        cashTotal: "999.00",
      },
    ]);

    const payload = await buildChapterDashboard(db, zone.id, zone.chapterAId);
    expect(payload.pendingBatches.count).toBe(3);
    expect(payload.pendingBatches.perCurrency).toEqual([
      { currencyCode: "GBP", total: "85.0000" },
    ]);
  });

  it("throws ChapterDashboardError for an unknown chapter", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const phantom = "00000000-0000-4000-8000-000000000000";
    await expect(buildChapterDashboard(db, zone.id, phantom)).rejects.toBeInstanceOf(
      ChapterDashboardError,
    );
  });
});
