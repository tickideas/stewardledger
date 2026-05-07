// packages/api/src/services/signup.test.ts
// Integration tests against the test DB (port 5433). Schema is pushed via
// `pnpm test:db:push` before this runs. Each test scopes its data with a
// random slug + name to avoid cross-test pollution.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  accounts,
  fiscalPeriods,
  givingCategories,
  givingPeriods,
  givingTypes,
  invitations,
  ministryPeriods,
  partnershipPeriods,
  paymentMethods,
  regions,
  roles,
  serviceTypes,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import { db } from "../db";
import { applyAcceptedInvitation, findInvitationByToken } from "./invitations";
import { deriveGivingPeriodForDate } from "./period-seed";
import { signupZone, SignupError } from "./signup";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function cleanup(slug: string): Promise<void> {
  await db.execute(sql`delete from zones where slug = ${slug}`);
}

async function cleanupRegion(name: string): Promise<void> {
  await db.execute(sql`delete from regions where lower(name) = lower(${name})`);
}

describe("signupZone", () => {
  const slugs: string[] = [];
  const regionNames: string[] = [];

  afterAll(async () => {
    for (const slug of slugs) await cleanup(slug);
    for (const n of regionNames) await cleanupRegion(n);
  });

  it("creates a zone in pending_setup, seeds foundations, and creates a zone_owner invite", async () => {
    const slug = `t-${unique()}`;
    const name = `Test Zone ${unique()}`;
    slugs.push(slug);

    const result = await signupZone(db, {
      name,
      slug,
      countryCode: "GB",
      timeZone: "Europe/London",
      defaultCurrency: "GBP",
      fiscalYearStartMonth: 1,
      ministryYearStartMonth: 3,
      regionNameUnverified: `Unverified Region ${unique()}`,
      primaryContactName: "Owner",
      primaryContactEmail: `owner+${unique()}@example.com`,
    });

    const [zone] = await db
      .select()
      .from(zones)
      .where(sql`${zones.id} = ${result.zoneId}`);
    expect(zone.status).toBe("pending_setup");
    expect(zone.regionId).toBeNull();
    expect(zone.regionNameUnverified).toMatch(/^Unverified Region /);

    const seededRoles = await db
      .select({ code: roles.code })
      .from(roles)
      .where(sql`${roles.zoneId} = ${result.zoneId}`);
    expect(seededRoles.length).toBe(9);
    expect(seededRoles.map((r) => r.code)).toContain(ZONE_ROLES.ZONE_OWNER);
    expect(seededRoles.map((r) => r.code)).toContain(CHAPTER_ROLES.CHAPTER_TREASURER);

    const [givingCategoryCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(givingCategories)
      .where(sql`${givingCategories.zoneId} = ${result.zoneId}`);
    expect(givingCategoryCount.count).toBe(4);

    const [accountCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(accounts)
      .where(sql`${accounts.zoneId} = ${result.zoneId}`);
    expect(accountCount.count).toBe(2);

    const [givingTypeCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(givingTypes)
      .where(sql`${givingTypes.zoneId} = ${result.zoneId}`);
    expect(givingTypeCount.count).toBe(4);

    const [paymentMethodCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentMethods)
      .where(sql`${paymentMethods.zoneId} = ${result.zoneId}`);
    expect(paymentMethodCount.count).toBe(6);

    const [serviceTypeCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${result.zoneId}`);
    expect(serviceTypeCount.count).toBe(3);

    const [givingPeriodCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(givingPeriods)
      .where(sql`${givingPeriods.zoneId} = ${result.zoneId}`);
    expect(givingPeriodCount.count).toBeGreaterThanOrEqual(365);

    const seededFiscalPeriods = await db
      .select({ periodNumber: fiscalPeriods.periodNumber })
      .from(fiscalPeriods)
      .where(sql`${fiscalPeriods.zoneId} = ${result.zoneId}`);
    expect(seededFiscalPeriods.length).toBeGreaterThanOrEqual(12);

    const July15 = `${new Date().getUTCFullYear()}-07-15`;
    const derivedPeriod = await deriveGivingPeriodForDate(db, result.zoneId, July15);
    expect(derivedPeriod).not.toBeNull();
    expect(derivedPeriod?.month).toBe(7);
    expect(derivedPeriod?.quarter).toBe(3);

    const invs = await db
      .select()
      .from(invitations)
      .where(sql`${invitations.id} = ${result.invitationId}`);
    expect(invs.length).toBe(1);
    expect(invs[0].roleCode).toBe(ZONE_ROLES.ZONE_OWNER);
    expect(invs[0].acceptedAt).toBeNull();
  });

  it("rejects a duplicate slug", async () => {
    const slug = `t-${unique()}`;
    slugs.push(slug);
    await signupZone(db, {
      name: `First ${unique()}`,
      slug,
      countryCode: "GB",
      timeZone: "Europe/London",
      defaultCurrency: "GBP",
      fiscalYearStartMonth: 1,
      ministryYearStartMonth: 3,
      regionNameUnverified: `URegion ${unique()}`,
      primaryContactName: "A",
      primaryContactEmail: `a+${unique()}@example.com`,
    });

    await expect(
      signupZone(db, {
        name: `Second ${unique()}`,
        slug,
        countryCode: "GB",
        timeZone: "Europe/London",
        defaultCurrency: "GBP",
        fiscalYearStartMonth: 1,
        ministryYearStartMonth: 3,
        regionNameUnverified: `URegion2 ${unique()}`,
        primaryContactName: "B",
        primaryContactEmail: `b+${unique()}@example.com`,
      }),
    ).rejects.toMatchObject({ code: "slug_taken" });
  });

  it("rejects a zone name that collides with an existing region (case-insensitive)", async () => {
    const regionName = `Shared Name ${unique()}`;
    regionNames.push(regionName);
    await db.insert(regions).values({ name: regionName, isActive: true });

    const slug = `t-${unique()}`;
    slugs.push(slug);
    await expect(
      signupZone(db, {
        name: regionName.toUpperCase(),
        slug,
        countryCode: "GB",
        timeZone: "Europe/London",
        defaultCurrency: "GBP",
        fiscalYearStartMonth: 1,
        ministryYearStartMonth: 3,
        regionNameUnverified: `URegion ${unique()}`,
        primaryContactName: "A",
        primaryContactEmail: `a+${unique()}@example.com`,
      }),
    ).rejects.toBeInstanceOf(SignupError);
  });

  it("rejects a region_name_unverified that collides with another zone's name", async () => {
    const slug1 = `t-${unique()}`;
    const slug2 = `t-${unique()}`;
    const name = `Conflict Zone ${unique()}`;
    slugs.push(slug1, slug2);

    await signupZone(db, {
      name,
      slug: slug1,
      countryCode: "GB",
      timeZone: "Europe/London",
      defaultCurrency: "GBP",
      fiscalYearStartMonth: 1,
      ministryYearStartMonth: 3,
      regionNameUnverified: `URegion ${unique()}`,
      primaryContactName: "A",
      primaryContactEmail: `a+${unique()}@example.com`,
    });

    await expect(
      signupZone(db, {
        name: `Other ${unique()}`,
        slug: slug2,
        countryCode: "GB",
        timeZone: "Europe/London",
        defaultCurrency: "GBP",
        fiscalYearStartMonth: 1,
        ministryYearStartMonth: 3,
        regionNameUnverified: name, // collides with zone created above
        primaryContactName: "B",
        primaryContactEmail: `b+${unique()}@example.com`,
      }),
    ).rejects.toBeInstanceOf(SignupError);
  });

  it("rejects cross-zone Phase 4 references and invalid period dimensions", async () => {
    const slug1 = `t-${unique()}`;
    const slug2 = `t-${unique()}`;
    slugs.push(slug1, slug2);

    const zone1 = await signupZone(db, {
      name: `Phase4 Guard A ${unique()}`,
      slug: slug1,
      countryCode: "GB",
      timeZone: "Europe/London",
      defaultCurrency: "GBP",
      fiscalYearStartMonth: 1,
      ministryYearStartMonth: 3,
      regionNameUnverified: `URegion ${unique()}`,
      primaryContactName: "A",
      primaryContactEmail: `a+${unique()}@example.com`,
    });
    const zone2 = await signupZone(db, {
      name: `Phase4 Guard B ${unique()}`,
      slug: slug2,
      countryCode: "GB",
      timeZone: "Europe/London",
      defaultCurrency: "GBP",
      fiscalYearStartMonth: 1,
      ministryYearStartMonth: 3,
      regionNameUnverified: `URegion ${unique()}`,
      primaryContactName: "B",
      primaryContactEmail: `b+${unique()}@example.com`,
    });

    const [foreignCategory] = await db
      .select({ id: givingCategories.id })
      .from(givingCategories)
      .where(sql`${givingCategories.zoneId} = ${zone1.zoneId}`)
      .limit(1);
    const [localAccount] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.zoneId} = ${zone2.zoneId}`)
      .limit(1);

    await expect(
      db.insert(givingTypes).values({
        zoneId: zone2.zoneId,
        categoryId: foreignCategory.id,
        accountId: localAccount.id,
        name: `Cross-zone Giving ${unique()}`,
      }),
    ).rejects.toBeTruthy();

    const [foreignFiscalPeriod] = await db
      .select({ id: fiscalPeriods.id })
      .from(fiscalPeriods)
      .where(sql`${fiscalPeriods.zoneId} = ${zone1.zoneId}`)
      .limit(1);
    const [localMinistryPeriod] = await db
      .select({ id: ministryPeriods.id })
      .from(ministryPeriods)
      .where(sql`${ministryPeriods.zoneId} = ${zone2.zoneId}`)
      .limit(1);
    const [localPartnershipPeriod] = await db
      .select({ id: partnershipPeriods.id })
      .from(partnershipPeriods)
      .where(sql`${partnershipPeriods.zoneId} = ${zone2.zoneId}`)
      .limit(1);

    await expect(
      db.insert(givingPeriods).values({
        zoneId: zone2.zoneId,
        date: "2099-01-01",
        weekday: 1,
        isoWeek: 1,
        isoYear: 2099,
        month: 1,
        quarter: 1,
        fiscalPeriodId: foreignFiscalPeriod.id,
        ministryPeriodId: localMinistryPeriod.id,
        partnershipPeriodId: localPartnershipPeriod.id,
      }),
    ).rejects.toBeTruthy();

    const [localFiscalPeriod] = await db
      .select({ id: fiscalPeriods.id })
      .from(fiscalPeriods)
      .where(sql`${fiscalPeriods.zoneId} = ${zone2.zoneId}`)
      .limit(1);
    await expect(
      db.insert(givingPeriods).values({
        zoneId: zone2.zoneId,
        date: "2099-01-02",
        weekday: 8,
        isoWeek: 1,
        isoYear: 2099,
        month: 1,
        quarter: 1,
        fiscalPeriodId: localFiscalPeriod.id,
        ministryPeriodId: localMinistryPeriod.id,
        partnershipPeriodId: localPartnershipPeriod.id,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("applyAcceptedInvitation", () => {
  const cleanups: string[] = [];
  let userId: string;

  beforeAll(async () => {
    userId = `u-${unique()}`;
    await db.insert(userTable).values({
      id: userId,
      email: `accept+${unique()}@example.com`,
      emailVerified: false,
    });
  });

  afterAll(async () => {
    for (const slug of cleanups) await cleanup(slug);
    await db.execute(sql`delete from "user" where id = ${userId}`);
  });

  it("activates the zone, creates a zone_owner binding, and marks the invite accepted", async () => {
    const slug = `t-${unique()}`;
    cleanups.push(slug);
    const signup = await signupZone(db, {
      name: `Accept Zone ${unique()}`,
      slug,
      countryCode: "GB",
      timeZone: "Europe/London",
      defaultCurrency: "GBP",
      fiscalYearStartMonth: 1,
      ministryYearStartMonth: 3,
      regionNameUnverified: `URegion ${unique()}`,
      primaryContactName: "A",
      primaryContactEmail: `a+${unique()}@example.com`,
    });

    // Pull the raw token from the DB \u2014 we hashed it on insert; for the test we
    // need to re-create one via createInvitation OR look it up by id and patch.
    // Simpler: re-issue an invitation directly so we hold the token.
    const { createInvitation } = await import("./invitations");
    const inv = await createInvitation(db, {
      zoneId: signup.zoneId,
      email: `extra+${unique()}@example.com`,
      roleCode: ZONE_ROLES.ZONE_OWNER, // for test only \u2014 the API blocks this
    });

    const lookup = await findInvitationByToken(db, inv.token);
    expect(lookup).not.toBeNull();
    expect(lookup?.id).toBe(inv.id);

    await applyAcceptedInvitation(db, { invitationId: inv.id, userId });

    const [zone] = await db
      .select({ status: zones.status, primaryContactUserId: zones.primaryContactUserId })
      .from(zones)
      .where(sql`${zones.id} = ${signup.zoneId}`);
    expect(zone.status).toBe("active");
    expect(zone.primaryContactUserId).toBe(userId);

    const bindings = await db
      .select({ roleId: userRoleBindings.roleId })
      .from(userRoleBindings)
      .where(
        sql`${userRoleBindings.userId} = ${userId} and ${userRoleBindings.zoneId} = ${signup.zoneId}`,
      );
    expect(bindings.length).toBe(1);
  });
});
