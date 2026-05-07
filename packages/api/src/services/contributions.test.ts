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

/**
 * Asserts that a Drizzle query rejects with a postgres error whose SQLSTATE
 * matches `code`. Pattern matching on the message text alone is too loose —
 * a stray rejection that happens to contain the substring would pass — so we
 * pin to SQLSTATE and optionally tighten with a message regex.
 *
 * Common codes: `23514` = check_violation (our trigger raises),
 * `23505` = unique_violation, `23503` = foreign_key_violation,
 * `23502` = not_null_violation, `42830` = no unique constraint matching FK.
 */
async function expectRejection(
  promise: Promise<unknown>,
  code: string,
  pattern?: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const actualCode = cause?.code;
    expect(actualCode, `expected SQLSTATE ${code}, got ${String(actualCode)}`).toBe(code);
    if (pattern) {
      const message =
        cause?.message ?? (err as { message?: string }).message ?? String(err);
      expect(message).toMatch(pattern);
    }
    return;
  }
  throw new Error(`expected rejection with SQLSTATE ${code}, got resolution`);
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
    // Hard-fail if the suite is pointed at a non-test database. The cleanup
    // step disables triggers, and we never want that running on a real DB.
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!/_test\b/.test(databaseUrl)) {
      throw new Error(
        "contributions.test.ts requires DATABASE_URL to reference a *_test database",
      );
    }
    // Idempotent — re-applying triggers is safe and protects this file from
    // running before `db:bootstrap` has been invoked.
    await applyContributionTriggers(db);
    zoneA = await seedZone(`con-a-${unique()}`, "GBP");
    zoneB = await seedZone(`con-b-${unique()}`, "USD");
    cleanupSlugs.push(zoneA.slug, zoneB.slug);
  });

  afterAll(async () => {
    // Disable the immutability triggers for the duration of cleanup. If this
    // suite is interrupted between disable and enable, the next run's
    // `db:bootstrap` re-enables them via `installTrigger` in
    // `bootstrap-triggers.ts` (it issues `enable trigger` after recreating).
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    for (const [table, name] of guards) {
      await db.execute(sql.raw(`alter table ${table} disable trigger ${name}`));
    }
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
      for (const [table, name] of guards) {
        await db.execute(sql.raw(`alter table ${table} enable trigger ${name}`));
      }
    }
  });

  // ─── Cross-tenant FK guards ─────────────────────────────────────────

  it("rejects a contribution_line that points at another zone's contribution", async () => {
    const contributionA = await makeContribution(zoneA);
    await expectRejection(
      db.insert(contributionLines).values({
        zoneId: zoneB.id,
        contributionId: contributionA,
        givingTypeId: zoneB.givingTypeId,
        amount: "10.0000",
        currencyCode: zoneB.defaultCurrency,
      }),
      "23503",
    );
  });

  it("rejects a contribution_line whose giving_type belongs to another zone", async () => {
    const id = await makeContribution(zoneA);
    await expectRejection(
      db.insert(contributionLines).values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneB.givingTypeId,
        amount: "5.0000",
        currencyCode: zoneA.defaultCurrency,
      }),
      "23503",
    );
  });

  it("rejects a contribution_line whose account belongs to another zone", async () => {
    const id = await makeContribution(zoneA);
    const [zoneBAccount] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.zoneId} = ${zoneB.id}`)
      .limit(1);
    await expectRejection(
      db.insert(contributionLines).values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneA.givingTypeId,
        accountId: zoneBAccount.id,
        amount: "5.0000",
        currencyCode: zoneA.defaultCurrency,
      }),
      "23503",
    );
  });

  it("rejects a contribution_member that points at another zone's member", async () => {
    const contributionA = await makeContribution(zoneA);
    await expectRejection(
      db.insert(contributionMembers).values({
        zoneId: zoneA.id,
        contributionId: contributionA,
        memberId: zoneB.memberId,
      }),
      "23503",
    );
  });

  it("rejects reversal_of_contribution_id pointing at another zone's contribution", async () => {
    const zoneBContribution = await makeContribution(zoneB);
    await expectRejection(
      db.insert(contributions).values({
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        memberId: zoneA.memberId,
        sourceType: "manual",
        contributionDate: "2025-01-01",
        totalAmount: "1.0000",
        currencyCode: zoneA.defaultCurrency,
        reversalOfContributionId: zoneBContribution,
      }),
      "23503",
    );
  });

  it("rejects parent_contribution_id pointing at another zone's contribution", async () => {
    const zoneBContribution = await makeContribution(zoneB);
    await expectRejection(
      db.insert(contributions).values({
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        memberId: zoneA.memberId,
        sourceType: "manual",
        contributionDate: "2025-01-01",
        totalAmount: "1.0000",
        currencyCode: zoneA.defaultCurrency,
        parentContributionId: zoneBContribution,
      }),
      "23503",
    );
  });

  // ─── CHECK constraints ─────────────────────────────────────────────

  it("rejects posting a contribution without postedAt", async () => {
    await expectRejection(
      db.insert(contributions).values({
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        memberId: zoneA.memberId,
        sourceType: "manual",
        contributionDate: "2025-01-01",
        totalAmount: "1.0000",
        currencyCode: zoneA.defaultCurrency,
        status: "posted",
      }),
      "23514",
      /contributions_posted_requires_timestamp/,
    );
  });

  it("rejects voiding a contribution without voidedAt", async () => {
    const id = await makeContribution(zoneA);
    await expectRejection(
      db
        .update(contributions)
        .set({ status: "voided" })
        .where(eq(contributions.id, id)),
      "23514",
      /contributions_voided_requires_timestamp/,
    );
  });

  it("rejects negative totalAmount on a contribution", async () => {
    await expectRejection(
      db.insert(contributions).values({
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        memberId: zoneA.memberId,
        sourceType: "manual",
        contributionDate: "2025-01-01",
        totalAmount: "-1.0000",
        currencyCode: zoneA.defaultCurrency,
      }),
      "23514",
      /contributions_total_nonneg/,
    );
  });

  it("rejects negative amount on a contribution_line", async () => {
    const id = await makeContribution(zoneA);
    await expectRejection(
      db.insert(contributionLines).values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneA.givingTypeId,
        amount: "-1.0000",
        currencyCode: zoneA.defaultCurrency,
      }),
      "23514",
      /contribution_lines_amount_nonneg/,
    );
  });

  it("rejects a contribution that names itself as its own reversal", async () => {
    const id = crypto.randomUUID();
    await expectRejection(
      db.insert(contributions).values({
        id,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        memberId: zoneA.memberId,
        sourceType: "manual",
        contributionDate: "2025-01-01",
        totalAmount: "1.0000",
        currencyCode: zoneA.defaultCurrency,
        reversalOfContributionId: id,
      }),
      "23514",
      /contributions_reversal_not_self/,
    );
  });

  it("accepts allocation_percent at the [0,100] boundary and rejects out-of-range", async () => {
    const id = await makeContribution(zoneA);
    // 0 and 100 are accepted.
    await db.insert(contributionMembers).values({
      zoneId: zoneA.id,
      contributionId: id,
      memberId: zoneA.memberId,
      allocationPercent: "0.00",
    });
    const id2 = await makeContribution(zoneA);
    await db.insert(contributionMembers).values({
      zoneId: zoneA.id,
      contributionId: id2,
      memberId: zoneA.memberId,
      allocationPercent: "100.00",
    });
    // 101 is rejected.
    const id3 = await makeContribution(zoneA);
    await expectRejection(
      db.insert(contributionMembers).values({
        zoneId: zoneA.id,
        contributionId: id3,
        memberId: zoneA.memberId,
        allocationPercent: "101.00",
      }),
      "23514",
      /contribution_members_allocation_range/,
    );
  });

  // ─── Currency-cohesion trigger ─────────────────────────────────────

  it("rejects a contribution_line whose currency_code differs from its parent on INSERT", async () => {
    const id = await makeContribution(zoneA, { currencyCode: "GBP" });
    await expectRejection(
      db.insert(contributionLines).values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneA.givingTypeId,
        amount: "5.0000",
        currencyCode: "USD",
      }),
      "23514",
      /currency_code/,
    );
  });

  it("rejects updating a draft line's currency to a value that no longer matches the parent", async () => {
    const id = await makeContribution(zoneA, { currencyCode: "GBP" });
    const [line] = await db
      .insert(contributionLines)
      .values({
        zoneId: zoneA.id,
        contributionId: id,
        givingTypeId: zoneA.givingTypeId,
        amount: "5.0000",
        currencyCode: "GBP",
      })
      .returning({ id: contributionLines.id });
    await expectRejection(
      db
        .update(contributionLines)
        .set({ currencyCode: "USD" })
        .where(eq(contributionLines.id, line.id)),
      "23514",
      /currency_code/,
    );
  });

  // ─── Posted-immutability triggers ─────────────────────────────────

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
      "23514",
      /immutable except for void/,
    );

    // Money is also locked once posted.
    await expectRejection(
      db
        .update(contributions)
        .set({ totalAmount: "999.0000" })
        .where(eq(contributions.id, id)),
      "23514",
      /immutable except for void/,
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

  it("allows posted → reversed transitions", async () => {
    const id = await makeContribution(zoneA, {
      status: "posted",
      postedAt: new Date(),
    });
    const [row] = await db
      .update(contributions)
      .set({ status: "reversed" })
      .where(eq(contributions.id, id))
      .returning({ status: contributions.status });
    expect(row.status).toBe("reversed");
  });

  it("rejects posted → draft (or any other non-void/reverse status)", async () => {
    const id = await makeContribution(zoneA, {
      status: "posted",
      postedAt: new Date(),
    });
    await expectRejection(
      db
        .update(contributions)
        .set({ status: "draft" })
        .where(eq(contributions.id, id)),
      "23514",
      /status may only become voided or reversed/,
    );
  });

  it("forbids deleting a posted contribution", async () => {
    const id = await makeContribution(zoneA, {
      status: "posted",
      postedAt: new Date(),
    });
    await expectRejection(
      db.delete(contributions).where(eq(contributions.id, id)),
      "23514",
      /posted; delete is forbidden/,
    );
  });

  it("forbids TRUNCATE on contributions and contribution_lines", async () => {
    await expectRejection(
      db.execute(sql`truncate table contributions cascade`),
      "23514",
      /truncate on contributions is forbidden/,
    );
    await expectRejection(
      db.execute(sql`truncate table contribution_lines`),
      "23514",
      /truncate on contribution_lines is forbidden/,
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
      "23514",
      /lines are immutable/,
    );

    await expectRejection(
      db
        .update(contributionLines)
        .set({ amount: "99.0000" })
        .where(eq(contributionLines.id, line.id)),
      "23514",
      /lines are immutable/,
    );

    await expectRejection(
      db.delete(contributionLines).where(eq(contributionLines.id, line.id)),
      "23514",
      /lines are immutable/,
    );
  });

  it("cascades line and member deletion when a draft contribution is deleted", async () => {
    const id = await makeContribution(zoneA, { status: "draft" });
    await db.insert(contributionLines).values({
      zoneId: zoneA.id,
      contributionId: id,
      givingTypeId: zoneA.givingTypeId,
      amount: "10.0000",
      currencyCode: zoneA.defaultCurrency,
    });
    await db.insert(contributionMembers).values({
      zoneId: zoneA.id,
      contributionId: id,
      memberId: zoneA.memberId,
    });

    await db.delete(contributions).where(eq(contributions.id, id));

    const [lineCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contributionLines)
      .where(eq(contributionLines.contributionId, id));
    expect(lineCount.count).toBe(0);
    const [memberCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contributionMembers)
      .where(eq(contributionMembers.contributionId, id));
    expect(memberCount.count).toBe(0);
  });

  // ─── Currency override at batch level ──────────────────────────────

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
