// packages/api/src/services/period-seed.test.ts
// Integration tests for the Phase 4 period seeding pipeline. Verifies the
// performance budget (<2s for a full year), and that deriveGivingPeriodForDate
// returns sensible dimensions across a spread of arbitrary dates.

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { givingPeriods, zones } from "@stewardledger/db/schema";
import { db } from "../db";
import { deriveGivingPeriodForDate, seedZonePeriods } from "./period-seed";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function createZone(slug: string): Promise<string> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Period Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  return zone.id;
}

describe("seedZonePeriods", () => {
  const cleanupSlugs: string[] = [];

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
  });

  it("seeds a full calendar year of giving_periods within the 2s budget", async () => {
    const slug = `perf-${unique()}`;
    cleanupSlugs.push(slug);
    const zoneId = await createZone(slug);

    const anchor = new Date(Date.UTC(2025, 0, 1));
    const startedAt = performance.now();
    await seedZonePeriods(
      db,
      zoneId,
      { fiscalYearStartMonth: 1, ministryYearStartMonth: 3 },
      anchor,
    );
    const durationMs = performance.now() - startedAt;
    expect(durationMs).toBeLessThan(2000);

    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(givingPeriods)
      .where(sql`${givingPeriods.zoneId} = ${zoneId}`);
    expect(count.count).toBe(365);
  });

  it("derives correct dimensions for arbitrary dates across the year", async () => {
    const slug = `derive-${unique()}`;
    cleanupSlugs.push(slug);
    const zoneId = await createZone(slug);
    const anchor = new Date(Date.UTC(2025, 0, 1));
    await seedZonePeriods(
      db,
      zoneId,
      { fiscalYearStartMonth: 1, ministryYearStartMonth: 3 },
      anchor,
    );

    const cases: Array<{
      date: string;
      weekday: number;
      month: number;
      quarter: number;
      isoWeek: number;
      isoYear: number;
    }> = [
      // Wed 2025-01-01 sits in the 2025-W01 partial week per ISO 8601.
      { date: "2025-01-01", weekday: 3, month: 1, quarter: 1, isoWeek: 1, isoYear: 2025 },
      // Sun 2025-03-30 — last Sunday of March.
      { date: "2025-03-30", weekday: 7, month: 3, quarter: 1, isoWeek: 13, isoYear: 2025 },
      // Tue 2025-07-15 mid-Q3.
      { date: "2025-07-15", weekday: 2, month: 7, quarter: 3, isoWeek: 29, isoYear: 2025 },
      // Sun 2025-12-28 still falls in ISO week 52 of 2025.
      { date: "2025-12-28", weekday: 7, month: 12, quarter: 4, isoWeek: 52, isoYear: 2025 },
      // Wed 2025-12-31 belongs to ISO year 2026 (week 1).
      { date: "2025-12-31", weekday: 3, month: 12, quarter: 4, isoWeek: 1, isoYear: 2026 },
    ];

    for (const expected of cases) {
      const period = await deriveGivingPeriodForDate(db, zoneId, expected.date);
      expect(period, `expected period for ${expected.date}`).not.toBeNull();
      expect(period!.weekday).toBe(expected.weekday);
      expect(period!.month).toBe(expected.month);
      expect(period!.quarter).toBe(expected.quarter);
      expect(period!.isoWeek).toBe(expected.isoWeek);
      expect(period!.isoYear).toBe(expected.isoYear);
      // Each giving_period must reference fiscal/ministry/partnership periods
      // owned by the same zone (FK enforces this; we still assert presence).
      expect(period!.fiscalPeriodId).toBeTruthy();
      expect(period!.ministryPeriodId).toBeTruthy();
      expect(period!.partnershipPeriodId).toBeTruthy();
    }
  });

  it("returns null when a date falls outside the seeded calendar year", async () => {
    const slug = `outside-${unique()}`;
    cleanupSlugs.push(slug);
    const zoneId = await createZone(slug);
    const anchor = new Date(Date.UTC(2025, 0, 1));
    await seedZonePeriods(
      db,
      zoneId,
      { fiscalYearStartMonth: 1, ministryYearStartMonth: 3 },
      anchor,
    );

    expect(await deriveGivingPeriodForDate(db, zoneId, "2024-12-31")).toBeNull();
    expect(await deriveGivingPeriodForDate(db, zoneId, "2026-01-01")).toBeNull();
  });

  it("is idempotent — re-running adds no duplicate giving_periods", async () => {
    const slug = `idem-${unique()}`;
    cleanupSlugs.push(slug);
    const zoneId = await createZone(slug);
    const anchor = new Date(Date.UTC(2025, 0, 1));
    await seedZonePeriods(
      db,
      zoneId,
      { fiscalYearStartMonth: 1, ministryYearStartMonth: 3 },
      anchor,
    );
    await seedZonePeriods(
      db,
      zoneId,
      { fiscalYearStartMonth: 1, ministryYearStartMonth: 3 },
      anchor,
    );
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(givingPeriods)
      .where(sql`${givingPeriods.zoneId} = ${zoneId}`);
    expect(count.count).toBe(365);
  });
});
