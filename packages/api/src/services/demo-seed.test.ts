// packages/api/src/services/demo-seed.test.ts
// Integration tests for the demo-seed reset path. Asserts that:
//   1. dropDemoZones refuses slugs that don't start with the demo prefix
//   2. After dropDemoZones runs (successfully or otherwise), the posted-
//      guard triggers are re-enabled. This is the riskiest invariant in
//      seed-demo because the reset temporarily disables triggers that
//      protect production data integrity.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { chapters, members, zones } from "@stewardledger/db/schema";
import { db } from "../db";
import { seedZoneGivingSetup } from "./giving-setup-seed";
import { seedZoneLookups } from "./lookup-seed";
import { seedZonePeriods } from "./period-seed";
import { seedZoneRoles } from "./role-seed";
import { nextChapterReferenceCode } from "./chapter-codes";
import { nextMemberReferenceCode } from "./member-codes";
import { dropDemoZones, readPostedGuardTriggerStates } from "./demo-seed";

const DEMO_PREFIX = "demo-seed-test-";

function unique(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function seedThrowawayZone(slug: string): Promise<string> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Test ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  await seedZoneRoles(db, zone.id);
  await seedZoneLookups(db, zone.id);
  await seedZoneGivingSetup(db, zone.id, "GBP");
  await seedZonePeriods(db, zone.id, { fiscalYearStartMonth: 1, ministryYearStartMonth: 3 });
  // A chapter and a member so the dependent-row deletes have something to do.
  const refCode = await nextChapterReferenceCode(db, zone.id);
  const [chapter] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: refCode,
      name: "Test Chapter",
      countryCode: "GB",
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  await db.insert(members).values({
    zoneId: zone.id,
    chapterId: chapter.id,
    referenceCode: await nextMemberReferenceCode(db, zone.id),
    firstName: "Test",
    lastName: "Member",
    isActive: true,
  });
  return zone.id;
}

describe("dropDemoZones", () => {
  beforeAll(async () => {
    // Triggers must exist for the test to be meaningful; the bootstrap is
    // idempotent so re-running it is cheap.
    const { applyContributionTriggers } = await import("@stewardledger/db");
    await applyContributionTriggers(db);
  });

  afterAll(async () => {
    // Belt-and-braces: leave triggers enabled regardless of test outcome.
    await db.execute(sql`alter table contributions enable trigger contributions_posted_guard`);
    await db.execute(
      sql`alter table contributions enable trigger contributions_no_delete_when_posted`,
    );
    await db.execute(
      sql`alter table contribution_lines enable trigger contribution_lines_posted_guard`,
    );
  });

  it("refuses slugs that lack the demo prefix", async () => {
    await expect(dropDemoZones(db, ["real-tenant"], DEMO_PREFIX)).rejects.toThrow(
      /lacks ".*" prefix/,
    );
  });

  it("is a no-op when no matching zones exist", async () => {
    const before = await readPostedGuardTriggerStates(db);
    const r = await dropDemoZones(db, [`${DEMO_PREFIX}nonexistent-${unique()}`], DEMO_PREFIX);
    expect(r.deletedZones).toBe(0);
    const after = await readPostedGuardTriggerStates(db);
    expect(after).toEqual(before);
    expect(after.every((t) => t.enabled)).toBe(true);
  });

  it("deletes a zone and re-enables posted-guard triggers", async () => {
    const slug = `${DEMO_PREFIX}${unique()}`;
    await seedThrowawayZone(slug);

    // Pre-condition: triggers all enabled before the destructive call.
    const before = await readPostedGuardTriggerStates(db);
    expect(before).toHaveLength(3);
    expect(before.every((t) => t.enabled)).toBe(true);

    const r = await dropDemoZones(db, [slug], DEMO_PREFIX);
    expect(r.deletedZones).toBe(1);

    // Post-condition: zone (and all its rows) gone, and all three triggers
    // restored to enabled state — this is THE invariant.
    const remaining = await db.select({ id: zones.id }).from(zones).where(sql`slug = ${slug}`);
    expect(remaining).toHaveLength(0);
    const after = await readPostedGuardTriggerStates(db);
    expect(after).toHaveLength(3);
    expect(after.every((t) => t.enabled)).toBe(true);

  });
});
