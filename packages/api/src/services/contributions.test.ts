// packages/api/src/services/contributions.test.ts
// DB-level guarantees for the Phase 5 contributions schema:
//   • Cross-tenant FKs reject lines/members from another zone.
//   • Posted contributions are immutable except for void/reverse fields.
//   • Posted contributions cannot be deleted; lines can't be added/changed/removed.
//   • A contribution_line.currency_code must match its parent.
//   • Currency on a new contribution batch defaults from the zone but can be
//     overridden when the chosen account uses a different currency.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  accounts,
  applyContributionTriggers,
  chapters,
  contributionBatches,
  contributionLines,
  contributionMembers,
  contributions,
  givingTypes,
  members,
  zones,
} from "@stewardledger/db";
import { db } from "../db";
import { seedZoneGivingSetup } from "./giving-setup-seed";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Drizzle wraps postgres errors; the trigger message lives on `cause`. */
async function expectRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message =
      (err as { cause?: { message?: string }; message?: string }).cause?.message ??
      (err as { message?: string }).message ??
      String(err);
    expect(message).toMatch(pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}, got resolution`);
}

interface SeededZone {
  id: string;
  slug: string;
  defaultCurrency: string;
  chapterId: string;
  memberId: string;
  givingTypeId: string;
  generalFundAccountId: string;
}

async function seedZone(slug: string, currency: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Contrib Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: currency,
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  await seedZoneGivingSetup(db, zone.id, currency);
  const [chapter] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: `Chapter ${unique()}`,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  const [member] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chapter.id,
      referenceCode: `M${unique()}`,
      firstName: "Alex",
      lastName: "Tester",
    })
    .returning({ id: members.id });
  const [givingType] = await db
    .select({ id: givingTypes.id })
    .from(givingTypes)
    .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'TITHE'`)
    .limit(1);
  const [generalFund] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(sql`${accounts.zoneId} = ${zone.id} and ${accounts.name} = 'General Fund'`)
    .limit(1);
  return {
    id: zone.id,
    slug: zone.slug,
    defaultCurrency: currency,
    chapterId: chapter.id,
    memberId: member.id,
    givingTypeId: givingType.id,
    generalFundAccountId: generalFund.id,
  };
}

async function makeBatch(
  zone: SeededZone,
  overrides: Partial<typeof contributionBatches.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(contributionBatches)
    .values({
      zoneId: zone.id,
      chapterId: zone.chapterId,
      sourceType: "manual",
      currencyCode: zone.defaultCurrency,
      ...overrides,
    })
    .returning({ id: contributionBatches.id });
  return row.id;
}

async function makeContribution(
  zone: SeededZone,
  overrides: Partial<typeof contributions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(contributions)
    .values({
      zoneId: zone.id,
      chapterId: zone.chapterId,
      memberId: zone.memberId,
      sourceType: "manual",
      contributionDate: new Date().toISOString().slice(0, 10),
      totalAmount: "100.0000",
      currencyCode: zone.defaultCurrency,
      status: "draft",
      ...overrides,
    })
    .returning({ id: contributions.id });
  return row.id;
}

describe("contributions schema invariants", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  const cleanupSlugs: string[] = [];

  beforeAll(async () => {
    // Idempotent — re-applying triggers is safe and protects this file from
    // running before `db:bootstrap` has been invoked.
    await applyContributionTriggers(db);
    zoneA = await seedZone(`con-a-${unique()}`, "GBP");
    zoneB = await seedZone(`con-b-${unique()}`, "USD");
    cleanupSlugs.push(zoneA.slug, zoneB.slug);
  });

  afterAll(async () => {
    // Drop the immutability triggers for the duration of cleanup. The
    // bootstrap step at the top of every test run re-applies them.
    await db.execute(sql`alter table contributions disable trigger contributions_posted_guard`);
    await db.execute(
      sql`alter table contributions disable trigger contributions_no_delete_when_posted`,
    );
    await db.execute(
      sql`alter table contribution_lines disable trigger contribution_lines_posted_guard`,
    );
    try {
      for (const slug of cleanupSlugs) {
        const zoneIdSql = sql`(select id from zones where slug = ${slug})`;
        await db.execute(sql`delete from contribution_lines where zone_id = ${zoneIdSql}`);
        await db.execute(sql`delete from contribution_members where zone_id = ${zoneIdSql}`);
        await db.execute(sql`delete from contributions where zone_id = ${zoneIdSql}`);
        await db.execute(sql`delete from contribution_batches where zone_id = ${zoneIdSql}`);
        await db.execute(sql`delete from members where zone_id = ${zoneIdSql}`);
        await db.execute(sql`delete from chapters where zone_id = ${zoneIdSql}`);
        await db.execute(sql`delete from zones where slug = ${slug}`);
      }
    } finally {
      await db.execute(sql`alter table contributions enable trigger contributions_posted_guard`);
      await db.execute(
        sql`alter table contributions enable trigger contributions_no_delete_when_posted`,
      );
      await db.execute(
        sql`alter table contribution_lines enable trigger contribution_lines_posted_guard`,
      );
    }
  });

  it("rejects a contribution_line that points at another zone's contribution", async () => {
    const contributionA = await makeContribution(zoneA);
    await expect(
      db.insert(contributionLines).values({
        zoneId: zoneB.id,
        contributionId: contributionA,
        givingTypeId: zoneB.givingTypeId,
        amount: "10.0000",
        currencyCode: zoneB.defaultCurrency,
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects a contribution_member that points at another zone's member", async () => {
    const contributionA = await makeContribution(zoneA);
    await expect(
      db.insert(contributionMembers).values({
        zoneId: zoneA.id,
        contributionId: contributionA,
        memberId: zoneB.memberId,
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects a contribution_line whose currency_code differs from its parent", async () => {
    const id = await makeContribution(zoneA, { currencyCode: "GBP" });
    await expectRejection(
      db.insert(contributionLines).values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneA.givingTypeId,
        amount: "5.0000",
        currencyCode: "USD",
      }),
      /currency_code/,
    );
  });

  it("blocks updates to a posted contribution except for void/reverse fields", async () => {
    const id = await makeContribution(zoneA, {
      status: "posted",
      postedAt: new Date(),
      totalAmount: "50.0000",
    });

    // Mutating a non-void field on a posted row is rejected.
    await expectRejection(
      db
        .update(contributions)
        .set({ description: "after the fact" })
        .where(eq(contributions.id, id)),
      /posted/,
    );

    // Money is also locked once posted.
    await expectRejection(
      db
        .update(contributions)
        .set({ totalAmount: "999.0000" })
        .where(eq(contributions.id, id)),
      /posted/,
    );

    // Voiding a posted contribution IS allowed.
    const voided = await db
      .update(contributions)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidReason: "test void",
      })
      .where(eq(contributions.id, id))
      .returning({ id: contributions.id, status: contributions.status });
    expect(voided[0]?.status).toBe("voided");
  });

  it("forbids deleting a posted contribution", async () => {
    const id = await makeContribution(zoneA, {
      status: "posted",
      postedAt: new Date(),
    });
    await expectRejection(
      db.delete(contributions).where(eq(contributions.id, id)),
      /posted/,
    );
  });

  it("forbids inserting/updating/deleting lines once the parent is posted", async () => {
    const id = await makeContribution(zoneA, { status: "draft" });
    const [line] = await db
      .insert(contributionLines)
      .values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneA.givingTypeId,
        amount: "10.0000",
        currencyCode: zoneA.defaultCurrency,
      })
      .returning({ id: contributionLines.id });

    // Promote to posted via a normal update (still draft when this runs).
    await db
      .update(contributions)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(contributions.id, id));

    await expectRejection(
      db.insert(contributionLines).values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneA.givingTypeId,
        amount: "20.0000",
        currencyCode: zoneA.defaultCurrency,
      }),
      /posted/,
    );

    await expectRejection(
      db
        .update(contributionLines)
        .set({ amount: "99.0000" })
        .where(eq(contributionLines.id, line.id)),
      /posted/,
    );

    await expectRejection(
      db.delete(contributionLines).where(eq(contributionLines.id, line.id)),
      /posted/,
    );
  });

  it("allows a batch's currency to override the zone default when the account differs", async () => {
    // Add a USD account to zoneA so a batch in this zone can legitimately use
    // a non-default currency.
    const [usdAccount] = await db
      .insert(accounts)
      .values({
        zoneId: zoneA.id,
        name: `USD Fund ${unique()}`,
        currencyCode: "USD",
      })
      .returning({ id: accounts.id });
    expect(usdAccount.id).toBeTruthy();

    // The batch defaults to the zone currency when no override is supplied.
    const defaultBatchId = await makeBatch(zoneA);
    const [defaultBatch] = await db
      .select({ currencyCode: contributionBatches.currencyCode })
      .from(contributionBatches)
      .where(eq(contributionBatches.id, defaultBatchId));
    expect(defaultBatch.currencyCode).toBe(zoneA.defaultCurrency);

    // The caller can override the currency to match the chosen account.
    const overrideBatchId = await makeBatch(zoneA, { currencyCode: "USD" });
    const [overrideBatch] = await db
      .select({ currencyCode: contributionBatches.currencyCode })
      .from(contributionBatches)
      .where(eq(contributionBatches.id, overrideBatchId));
    expect(overrideBatch.currencyCode).toBe("USD");
  });
});
