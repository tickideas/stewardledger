// packages/api/src/services/contributions-service.test.ts
// Service-level tests for the Phase 5 contribution write paths. These
// complement the schema/trigger-level cases in `contributions.test.ts`:
//   • happy path create → post → read.
//   • currency defaults from the zone when omitted.
//   • cross-tenant rejection at the service layer surfaces a typed
//     `ContributionError` (never leaks an SQLSTATE to the caller).
//   • draft update replaces lines + members atomically.
//   • posting/voiding/reversing follow the documented state machine.
//   • batch lifecycle + currency invariants.

import {
  accounts,
  applyContributionTriggers,
  chapters,
  contributionLines,
  contributions,
  givingTypes,
  members,
  payingInBooks,
  paymentMethods,
  serviceEvents,
  serviceTypes,
  user as userTable,
  zones,
} from "@stewardledger/db";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db";
import {
  approveBatch,
  createBatch,listBatches, 
  postBatch,
  submitBatch,
  updateDraftBatch,
  voidBatch
} from "./contribution-batches";
import {
  ContributionError,
  createContribution,
  deleteDraftContribution,
  listContributions,
  postContribution,
  reverseContribution,
  updateDraftContribution,
  voidContribution,
} from "./contributions";
import { seedZoneGivingSetup } from "./giving-setup-seed";
import { seedZonePeriods } from "./period-seed";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SeededZone {
  id: string;
  slug: string;
  defaultCurrency: string;
  chapterId: string;
  otherChapterId: string;
  memberId: string;
  givingTypeId: string;
  generalFundAccountId: string;
  cashPaymentMethodId: string;
  zoneWideServiceEventId: string;
  chapterServiceEventId: string;
}

async function seedZone(slug: string, currency: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Service Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: currency,
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  await seedZoneGivingSetup(db, zone.id, currency);
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });
  const insertedChapters = await db
    .insert(chapters)
    .values([
      {
        zoneId: zone.id,
        referenceCode: `C${unique()}`,
        name: `Chapter ${unique()}`,
        dateFrom: new Date().toISOString().slice(0, 10),
      },
      {
        zoneId: zone.id,
        referenceCode: `C${unique()}`,
        name: `Other ${unique()}`,
        dateFrom: new Date().toISOString().slice(0, 10),
      },
    ])
    .returning({ id: chapters.id });
  const chapter = insertedChapters[0];
  const otherChapter = insertedChapters[1];
  const [member] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chapter.id,
      referenceCode: `M${unique()}`,
      firstName: "Service",
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
  const [cashPm] = await db
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(sql`${paymentMethods.zoneId} = ${zone.id} and ${paymentMethods.code} = 'cash'`)
    .limit(1);
  // Seed two service events: one zone-wide (chapterId = null) and one
  // chapter-scoped, so cross-chapter tests have something concrete to
  // refuse without leaning on a foreign-zone trick.
  const [serviceType] = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(eq(serviceTypes.zoneId, zone.id))
    .limit(1);
  if (!serviceType) {
    throw new Error("seedZone: zone giving setup did not seed service_types");
  }
  const serviceTypeId = serviceType.id;
  const inserted = await db
    .insert(serviceEvents)
    .values([
      {
        zoneId: zone.id,
        chapterId: null,
        serviceTypeId,
        serviceDate: new Date().toISOString().slice(0, 10),
      },
      {
        zoneId: zone.id,
        chapterId: chapter.id,
        serviceTypeId,
        serviceDate: new Date().toISOString().slice(0, 10),
      },
    ])
    .returning({ id: serviceEvents.id, chapterId: serviceEvents.chapterId });
  const zoneWideServiceEvent = inserted.find((r) => r.chapterId === null);
  const chapterServiceEvent = inserted.find((r) => r.chapterId !== null);
  if (!zoneWideServiceEvent || !chapterServiceEvent) {
    throw new Error("seedZone: failed to seed service events");
  }
  return {
    id: zone.id,
    slug: zone.slug,
    defaultCurrency: currency,
    chapterId: chapter.id,
    otherChapterId: otherChapter.id,
    memberId: member.id,
    givingTypeId: givingType.id,
    generalFundAccountId: generalFund.id,
    cashPaymentMethodId: cashPm.id,
    zoneWideServiceEventId: zoneWideServiceEvent.id,
    chapterServiceEventId: chapterServiceEvent.id,
  };
}

let USER_ID: string;

describe("contributions service", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("contributions-service.test.ts requires a *_test DATABASE_URL");
    }
    await applyContributionTriggers(db);
    USER_ID = `svc-${unique()}`;
    cleanupUserIds.push(USER_ID);
    await db
      .insert(userTable)
      .values({ id: USER_ID, email: `${USER_ID}@example.test`, emailVerified: true });
    zoneA = await seedZone(`svc-a-${unique()}`, "GBP");
    zoneB = await seedZone(`svc-b-${unique()}`, "USD");
    cleanupSlugs.push(zoneA.slug, zoneB.slug);
  });

  afterAll(async () => {
    // Wrap the disable / delete / re-enable in one transaction so the
    // pool can't route the DELETE to a different connection where the
    // trigger is still active. The advisory lock serialises against
    // any parallel suite calling `applyContributionTriggers` in its
    // own bootstrap. Mirrors the safe pattern in imports.test.ts.
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
      );
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
      }
      for (const slug of cleanupSlugs) {
        const z = sql`(select id from zones where slug = ${slug})`;
        await tx.execute(sql`delete from contribution_lines where zone_id = ${z}`);
        await tx.execute(sql`delete from contribution_members where zone_id = ${z}`);
        await tx.execute(sql`delete from contributions where zone_id = ${z}`);
        await tx.execute(sql`delete from contribution_batches where zone_id = ${z}`);
        await tx.execute(sql`delete from service_events where zone_id = ${z}`);
        // paying_in_books.chapter_id is FK ON DELETE RESTRICT.
        await tx.execute(sql`delete from paying_in_books where zone_id = ${z}`);
        await tx.execute(sql`delete from members where zone_id = ${z}`);
        await tx.execute(sql`delete from chapters where zone_id = ${z}`);
        await tx.execute(sql`delete from zones where slug = ${slug}`);
      }
      for (const id of cleanupUserIds) {
        await tx.execute(sql`delete from "user" where id = ${id}`);
      }
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
      }
    });
  });

  // ─── createContribution ─────────────────────────────────────────────

  it("creates a draft contribution and defaults currency from the zone", async () => {
    // Use a date inside the seeded calendar year (anchorDate=now() in
    // seedZonePeriods seeds the *current* year). This keeps the
    // giving_period auto-derivation working under the test fixture.
    const seededDate = `${new Date().getUTCFullYear()}-03-15`;
    const detail = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      memberId: zoneA.memberId,
      sourceType: "manual",
      contributionDate: seededDate,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "25.5000" }],
    });
    expect(detail.contribution.currencyCode).toBe(zoneA.defaultCurrency);
    expect(detail.contribution.totalAmount).toBe("25.5000");
    expect(detail.contribution.status).toBe("draft");
    expect(detail.contribution.givingPeriodId).not.toBeNull();
    expect(detail.lines).toHaveLength(1);
  });

  it("rejects createContribution when totalAmount mismatches the line sum", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: "2025-03-15",
        totalAmount: "100.0000",
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "25.0000" }],
      }),
    ).rejects.toBeInstanceOf(ContributionError);
  });

  it("rejects createContribution with no lines", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: "2025-03-15",
        lines: [],
      }),
    ).rejects.toThrow();
  });

  it("rejects createContribution with a chapter from another zone", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneB.chapterId,
        sourceType: "manual",
        contributionDate: "2025-03-15",
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "10.0000" }],
      }),
    ).rejects.toMatchObject({ code: "chapter_not_found" });
  });

  it("rejects createContribution with a giving_type from another zone", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: "2025-03-15",
        lines: [{ givingTypeId: zoneB.givingTypeId, amount: "10.0000" }],
      }),
    ).rejects.toMatchObject({ code: "giving_type_not_found" });
  });

  it("rejects createContribution when batch currency differs from contribution currency", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      currencyCode: "USD",
    });
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        batchId: batch.id,
        sourceType: "manual",
        contributionDate: "2025-03-15",
        currencyCode: "GBP",
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "10.0000" }],
      }),
    ).rejects.toMatchObject({ code: "batch_currency_mismatch" });
  });

  // ─── update / post / void / reverse ────────────────────────────────

  it("updateDraftContribution replaces lines and recomputes total", async () => {
    const created = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: "2025-04-01",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "10.0000" }],
    });
    const updated = await updateDraftContribution(
      db,
      { zoneId: zoneA.id, userId: USER_ID },
      created.contribution.id,
      {
        lines: [
          { givingTypeId: zoneA.givingTypeId, amount: "20.0000" },
          { givingTypeId: zoneA.givingTypeId, amount: "30.0000" },
        ],
      },
    );
    expect(updated.lines).toHaveLength(2);
    expect(updated.contribution.totalAmount).toBe("50.0000");
  });

  it("postContribution flips draft → posted with postedAt and rejects non-draft", async () => {
    const created = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: "2025-04-02",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "5.0000" }],
    });
    const posted = await postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id);
    expect(posted.status).toBe("posted");
    expect(posted.postedAt).not.toBeNull();
    await expect(
      postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id),
    ).rejects.toMatchObject({ code: "not_draft" });
  });

  it("voidContribution rejects when not posted; voids when posted", async () => {
    const draft = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: "2025-04-03",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
    });
    await expect(
      voidContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id, {
        voidReason: "test",
      }),
    ).rejects.toMatchObject({ code: "not_posted" });
    await postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id);
    const voided = await voidContribution(
      db,
      { zoneId: zoneA.id, userId: USER_ID },
      draft.contribution.id,
      { voidReason: "duplicate entry" },
    );
    expect(voided.status).toBe("voided");
    expect(voided.voidReason).toBe("duplicate entry");
  });

  it("reverseContribution emits a corrective contribution with negated amounts and flips original to reversed", async () => {
    const created = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      memberId: zoneA.memberId,
      sourceType: "manual",
      contributionDate: "2025-05-01",
      lines: [
        { givingTypeId: zoneA.givingTypeId, amount: "40.0000" },
        { givingTypeId: zoneA.givingTypeId, amount: "10.0000" },
      ],
    });
    await postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id);

    const reversal = await reverseContribution(
      db,
      { zoneId: zoneA.id, userId: USER_ID },
      created.contribution.id,
      { reason: "wrong member" },
    );
    expect(reversal.contribution.status).toBe("posted");
    expect(reversal.contribution.totalAmount).toBe("-50.0000");
    expect(reversal.contribution.reversalOfContributionId).toBe(created.contribution.id);
    expect(reversal.contribution.parentContributionId).toBe(created.contribution.id);
    const reversalLineAmounts = reversal.lines.map((l) => l.amount).sort();
    expect(reversalLineAmounts).toEqual(["-10.0000", "-40.0000"]);

    const [original] = await db
      .select({ status: contributions.status })
      .from(contributions)
      .where(eq(contributions.id, created.contribution.id));
    expect(original.status).toBe("reversed");

    // The original cannot be reversed twice.
    await expect(
      reverseContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id, {
        reason: "again",
      }),
    ).rejects.toMatchObject({ code: "not_posted" });
  });

  it("deleteDraftContribution removes a draft and cascades; rejects posted", async () => {
    const detail = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      memberId: zoneA.memberId,
      sourceType: "manual",
      contributionDate: "2025-05-02",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      members: [{ memberId: zoneA.memberId, allocationPercent: "100.00" }],
    });
    await deleteDraftContribution(db, { zoneId: zoneA.id, userId: USER_ID }, detail.contribution.id);
    const [count] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(contributions)
      .where(eq(contributions.id, detail.contribution.id));
    expect(count.c).toBe(0);

    const posted = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: "2025-05-03",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
    });
    await postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, posted.contribution.id);
    await expect(
      deleteDraftContribution(db, { zoneId: zoneA.id, userId: USER_ID }, posted.contribution.id),
    ).rejects.toMatchObject({ code: "not_draft" });
  });

  // ─── Batch lifecycle ───────────────────────────────────────────────

  it("batch lifecycle: draft → submitted → approved → posted promotes embedded contributions", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "envelope",
    });
    const c1 = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      batchId: batch.id,
      sourceType: "envelope",
      contributionDate: "2025-06-01",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "12.0000" }],
    });
    const c2 = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      batchId: batch.id,
      sourceType: "envelope",
      contributionDate: "2025-06-01",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "8.0000" }],
    });

    const submitted = await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    expect(submitted.status).toBe("submitted");
    const approved = await approveBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    expect(approved.status).toBe("approved");
    const result = await postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    expect(result.batch.status).toBe("posted");
    expect(result.postedCount).toBe(2);

    const rows = await db
      .select({ id: contributions.id, status: contributions.status })
      .from(contributions)
      .where(sql`${contributions.id} in (${c1.contribution.id}, ${c2.contribution.id})`);
    expect(rows.every((r) => r.status === "posted")).toBe(true);
  });

  it("voidBatch refuses on a posted batch but allows draft/submitted/approved", async () => {
    const draft = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    const voided = await voidBatch(db, { zoneId: zoneA.id, userId: USER_ID }, draft.id, {
      voidReason: "abandoned",
    });
    expect(voided.status).toBe("voided");

    const posted = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, posted.id);
    await approveBatch(db, { zoneId: zoneA.id, userId: USER_ID }, posted.id);
    await postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, posted.id);
    await expect(
      voidBatch(db, { zoneId: zoneA.id, userId: USER_ID }, posted.id, { voidReason: "x" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("postBatch rejects when a contained contribution has a mismatched currency", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      currencyCode: "GBP",
    });
    const c = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      batchId: batch.id,
      sourceType: "manual",
      contributionDate: "2025-07-01",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "10.0000" }],
    });
    // Tamper directly via SQL to simulate a mismatched-currency row that
    // bypassed createContribution. Triggers re-disable for the duration of
    // this test only.
    await db.execute(sql.raw("alter table contribution_lines disable trigger contribution_lines_posted_guard"));
    try {
      await db
        .update(contributions)
        .set({ currencyCode: "USD" })
        .where(eq(contributions.id, c.contribution.id));
      await db
        .update(contributionLines)
        .set({ currencyCode: "USD" })
        .where(eq(contributionLines.contributionId, c.contribution.id));
    } finally {
      await db.execute(sql.raw("alter table contribution_lines enable trigger contribution_lines_posted_guard"));
    }
    await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await approveBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await expect(
      postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id),
    ).rejects.toMatchObject({ code: "batch_currency_mismatch" });
  });

  // ─── Sign convention (AGENTS rule #1) ──────────────────────────────

  it("rejects creating a contribution with a non-positive line amount", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "-5.0000" }],
      }),
    ).rejects.toMatchObject({ code: "non_positive_amount" });
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "0.0000" }],
      }),
    ).rejects.toMatchObject({ code: "non_positive_amount" });
  });

  it("rejects updating a draft with a non-positive line amount", async () => {
    const created = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-03-15`,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
    });
    await expect(
      updateDraftContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id, {
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "-1.0000" }],
      }),
    ).rejects.toMatchObject({ code: "non_positive_amount" });
  });

  it("reverseContribution: |reversal lines| equal |original lines| and |totals| match", async () => {
    const seededDate = `${new Date().getUTCFullYear()}-04-15`;
    const created = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: seededDate,
      lines: [
        { givingTypeId: zoneA.givingTypeId, amount: "7.0001" },
        { givingTypeId: zoneA.givingTypeId, amount: "13.9999" },
        { givingTypeId: zoneA.givingTypeId, amount: "0.0001" },
      ],
    });
    await postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id);
    const rev = await reverseContribution(
      db,
      { zoneId: zoneA.id, userId: USER_ID },
      created.contribution.id,
      { reason: "audit-symmetry" },
    );

    const origAbs = created.lines
      .map((l) => new Decimal(l.amount).abs().toFixed(4))
      .sort();
    const revAbs = rev.lines
      .map((l) => new Decimal(l.amount).abs().toFixed(4))
      .sort();
    expect(revAbs).toEqual(origAbs);
    expect(rev.contribution.totalAmount.startsWith("-")).toBe(true);
    const totalSum = new Decimal(created.contribution.totalAmount).plus(
      rev.contribution.totalAmount,
    );
    expect(totalSum.toFixed(4)).toBe("0.0000");
  });

  // ─── Cross-tenant fuzz on remaining FKs ────────────────────────────

  it("rejects createContribution with batchId from another zone", async () => {
    const foreignBatch = await createBatch(db, { zoneId: zoneB.id, userId: USER_ID }, {
      chapterId: zoneB.chapterId,
      sourceType: "manual",
      currencyCode: zoneA.defaultCurrency,
    });
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        batchId: foreignBatch.id,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      }),
    ).rejects.toMatchObject({ code: "batch_not_found" });
  });

  it("rejects createContribution with accountId from another zone", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [
          {
            givingTypeId: zoneA.givingTypeId,
            accountId: zoneB.generalFundAccountId,
            amount: "1.0000",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("rejects createContribution with members[] memberId from another zone", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
        members: [{ memberId: zoneB.memberId, allocationPercent: "100.00" }],
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("rejects createContribution with paymentMethodId from another zone", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        paymentMethodId: zoneB.cashPaymentMethodId,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      }),
    ).rejects.toMatchObject({ code: "payment_method_not_found" });
  });

  it("rejects createContribution with serviceEventId from another zone", async () => {
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        serviceEventId: zoneB.zoneWideServiceEventId,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      }),
    ).rejects.toMatchObject({ code: "service_event_not_found" });
  });

  // ─── Chapter-scope guards within a zone ────────────────────────────

  it("rejects attaching a batch belonging to a different chapter in the same zone", async () => {
    const otherBatch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.otherChapterId,
      sourceType: "manual",
      currencyCode: zoneA.defaultCurrency,
    });
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        batchId: otherBatch.id,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      }),
    ).rejects.toMatchObject({ code: "batch_chapter_mismatch" });
  });

  it("accepts a zone-wide service event but rejects a foreign-chapter one", async () => {
    // zoneWide: chapterId=null on serviceEvent -> accepted regardless of contribution chapter.
    const ok = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      serviceEventId: zoneA.zoneWideServiceEventId,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-03-15`,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
    });
    expect(ok.contribution.serviceEventId).toBe(zoneA.zoneWideServiceEventId);

    // Service event scoped to the *other* chapter in this zone -> reject.
    const [stForZoneA] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(eq(serviceTypes.zoneId, zoneA.id))
      .limit(1);
    if (!stForZoneA) {
      throw new Error("test setup: zone A is missing service_types");
    }
    const [otherEvent] = await db
      .insert(serviceEvents)
      .values({
        zoneId: zoneA.id,
        chapterId: zoneA.otherChapterId,
        serviceTypeId: stForZoneA.id,
        serviceDate: new Date().toISOString().slice(0, 10),
      })
      .returning({ id: serviceEvents.id });
    const otherEvtId = otherEvent.id;
    await expect(
      createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        serviceEventId: otherEvtId,
        sourceType: "manual",
        contributionDate: `${new Date().getUTCFullYear()}-03-15`,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      }),
    ).rejects.toMatchObject({ code: "service_event_chapter_mismatch" });
  });

  // ─── Currency-only patches re-check batch cohesion ────────────────

  it("re-checks batch currency on a currency-only patch", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      currencyCode: "GBP",
    });
    const draft = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      batchId: batch.id,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-03-15`,
      currencyCode: "GBP",
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
    });
    await expect(
      updateDraftContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id, {
        currencyCode: "USD",
      }),
    ).rejects.toMatchObject({ code: "batch_currency_mismatch" });
  });

  it("rejects updating totalAmount alone without supplying lines", async () => {
    const draft = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-03-15`,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "5.0000" }],
    });
    await expect(
      updateDraftContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id, {
        totalAmount: "10.0000",
      }),
    ).rejects.toMatchObject({ code: "total_without_lines" });
  });

  // ─── updateDraftBatch ──────────────────────────────────────────────

  it("updateDraftBatch patches whitelisted columns and audits", async () => {
    // Phase 8 reference-code validator fires on patch as well, so
    // we seed a wide-open paying-in book for the chapter first.
    await db.insert(payingInBooks).values({
      zoneId: zoneA.id,
      chapterId: zoneA.chapterId,
      referenceCodeStart: "ENV-0000-000",
      referenceCodeEnd: "ENV-9999-999",
      dateFrom: "2000-01-01",
      dateTo: null,
    });
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    const updated = await updateDraftBatch(
      db,
      { zoneId: zoneA.id, userId: USER_ID },
      batch.id,
      { notes: "evening service", referenceCode: "ENV-2025-001" },
    );
    expect(updated.notes).toBe("evening service");
    expect(updated.referenceCode).toBe("ENV-2025-001");
  });

  it("updateDraftBatch refuses non-draft batches", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await expect(
      updateDraftBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id, {
        notes: "too late",
      }),
    ).rejects.toMatchObject({ code: "not_draft" });
  });

  it("updateDraftBatch rejects cross-zone serviceEventId", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await expect(
      updateDraftBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id, {
        serviceEventId: zoneB.zoneWideServiceEventId,
      }),
    ).rejects.toMatchObject({ code: "service_event_not_found" });
  });

  // ─── listContributions / listBatches ──────────────────────────────

  it("listContributions filters by status and respects scope.chapterIds", async () => {
    // Drop an extra chapter entry into zone A and seed two contributions
    // — one in `zoneA.chapterId`, one in `zoneA.otherChapterId`.
    const seededDate = `${new Date().getUTCFullYear()}-08-01`;
    const a = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: seededDate,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
    });
    await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.otherChapterId,
      sourceType: "manual",
      contributionDate: seededDate,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "2.0000" }],
    });

    // No scope ⇒ both visible.
    const both = await listContributions(db, zoneA.id, {
      limit: 50,
      offset: 0,
      status: "draft",
      dateFrom: seededDate,
      dateTo: seededDate,
    });
    const idsBoth = both.items.map((i) => i.id);
    expect(idsBoth).toContain(a.contribution.id);

    // Scope to chapter A only ⇒ only chapter-A row.
    const only = await listContributions(
      db,
      zoneA.id,
      { limit: 50, offset: 0, dateFrom: seededDate, dateTo: seededDate },
      { chapterIds: [zoneA.chapterId] },
    );
    expect(only.items.every((i) => i.chapterId === zoneA.chapterId)).toBe(true);

    // Empty allow-list ⇒ explicit no-rows shortcut.
    const empty = await listContributions(
      db,
      zoneA.id,
      { limit: 50, offset: 0 },
      { chapterIds: [] },
    );
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
  });

  it("listBatches scopes by chapterIds (parameterised IN, not array-as-scalar)", async () => {
    // Two batches in different chapters; listBatches with scope to one
    // chapter should return only that one. This case caught a real bug
    // where the previous implementation passed `${array}` directly into
    // a sql template, binding the array as a single parameter.
    //
    // Phase 8 reference-code validator fires on create, so seed a
    // wide-open paying-in book for each chapter first.
    await db.insert(payingInBooks).values([
      {
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        referenceCodeStart: "LIST-A-",
        referenceCodeEnd: "LIST-A-zzzzzzzz",
        dateFrom: "2000-01-01",
        dateTo: null,
      },
      {
        zoneId: zoneA.id,
        chapterId: zoneA.otherChapterId,
        referenceCodeStart: "LIST-O-",
        referenceCodeEnd: "LIST-O-zzzzzzzz",
        dateFrom: "2000-01-01",
        dateTo: null,
      },
    ]);
    await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      referenceCode: `LIST-A-${unique()}`,
    });
    await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.otherChapterId,
      sourceType: "manual",
      referenceCode: `LIST-O-${unique()}`,
    });
    const scoped = await listBatches(
      db,
      zoneA.id,
      { limit: 50, offset: 0 },
      { chapterIds: [zoneA.chapterId] },
    );
    expect(scoped.items.every((b) => b.chapterId === zoneA.chapterId)).toBe(true);
    expect(scoped.items.length).toBeGreaterThan(0);
  });

  // ─── State-machine negatives ──────────────────────────────────────

  it("approveBatch on a draft batch returns invalid_transition", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await expect(
      approveBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("submitBatch on a non-draft is rejected", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await expect(
      submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("voidBatch on already-voided returns invalid_transition", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await voidBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id, {
      voidReason: "first",
    });
    await expect(
      voidBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id, { voidReason: "again" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("postBatch with no attached contributions sets postedCount=0 but flips status", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await approveBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    const result = await postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    expect(result.postedCount).toBe(0);
    expect(result.batch.status).toBe("posted");
  });

  it("postBatch on already-posted batch returns invalid_transition", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await approveBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await expect(
      postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  // ─── Concurrency ──────────────────────────────────────────────────

  it("two concurrent postContribution calls — exactly one succeeds", async () => {
    const draft = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-09-15`,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "9.0000" }],
    });
    const results = await Promise.allSettled([
      postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id),
      postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContributionError);
    expect(((rejected[0] as PromiseRejectedResult).reason as ContributionError).code).toBe(
      "not_draft",
    );
  });

  it("two concurrent postBatch calls — exactly one succeeds", async () => {
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
    });
    await submitBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    await approveBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id);
    const results = await Promise.allSettled([
      postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id),
      postBatch(db, { zoneId: zoneA.id, userId: USER_ID }, batch.id),
    ]);
    // The conditional UPDATE on `contribution_batches.status='approved'`
    // ensures exactly one tx flips the batch row; the loser sees zero
    // affected rows and re-classifies as a typed `invalid_transition`.
    // The tolerant `>=1, <=2` assertions from before predated the race
    // fix — we can now assert the strict invariant.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContributionError);
    expect(((rejected[0] as PromiseRejectedResult).reason as ContributionError).code).toBe(
      "invalid_transition",
    );
  });

  it("two concurrent voidContribution calls — exactly one succeeds", async () => {
    const created = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-09-16`,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "11.0000" }],
    });
    await postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id);
    const results = await Promise.allSettled([
      voidContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id, {
        voidReason: "first",
      }),
      voidContribution(db, { zoneId: zoneA.id, userId: USER_ID }, created.contribution.id, {
        voidReason: "second",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContributionError);
    expect(((rejected[0] as PromiseRejectedResult).reason as ContributionError).code).toBe(
      "not_posted",
    );
  });

  it("two concurrent reverseContribution calls — exactly one corrective contribution lands", async () => {
    const created = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-09-17`,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "13.0000" }],
    });
    const originalId = created.contribution.id;
    await postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, originalId);

    const results = await Promise.allSettled([
      reverseContribution(db, { zoneId: zoneA.id, userId: USER_ID }, originalId, {
        reason: "first",
      }),
      reverseContribution(db, { zoneId: zoneA.id, userId: USER_ID }, originalId, {
        reason: "second",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as ContributionError).code).toBe(
      "not_posted",
    );
    // Hard invariant: the original must NOT have two reversal
    // contributions linked to it. Pre-fix, both calls inserted a
    // corrective entry; this asserts the worst-case data race is gone.
    const reversals = await db
      .select({ id: contributions.id })
      .from(contributions)
      .where(
        and(
          eq(contributions.zoneId, zoneA.id),
          eq(contributions.reversalOfContributionId, originalId),
        ),
      );
    expect(reversals).toHaveLength(1);
  });

  it("concurrent postContribution + deleteDraftContribution — only one wins", async () => {
    const draft = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: `${new Date().getUTCFullYear()}-09-18`,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "7.0000" }],
    });
    const results = await Promise.allSettled([
      postContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id),
      deleteDraftContribution(db, { zoneId: zoneA.id, userId: USER_ID }, draft.contribution.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser surfaces a typed ContributionError with one of the
    // expected codes; which one depends on who won the race.
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ContributionError);
    const code = (reason as ContributionError).code;
    expect(["not_draft", "not_found"]).toContain(code);
  });

  // ─── Boundary amounts ─────────────────────────────────────────────

  it("round-trips a near-max-precision numeric(19,4) amount", async () => {
    const big = "12345678901234.5678"; // 14 left + 4 right, well inside numeric(19,4).
    const seededDate = `${new Date().getUTCFullYear()}-10-01`;
    const detail = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      contributionDate: seededDate,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: big }],
    });
    expect(detail.contribution.totalAmount).toBe(big);
    expect(detail.lines[0].amount).toBe(big);
  });

  it("preserves allocation_percent string formatting through create + load", async () => {
    const seededDate = `${new Date().getUTCFullYear()}-10-02`;
    const detail = await createContribution(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      memberId: zoneA.memberId,
      sourceType: "manual",
      contributionDate: seededDate,
      lines: [{ givingTypeId: zoneA.givingTypeId, amount: "10.0000" }],
      members: [{ memberId: zoneA.memberId, allocationPercent: "33.33" }],
    });
    expect(detail.members[0].allocationPercent).toBe("33.33");
  });

  it("rejects createBatch with a reference code that doesn't match any paying-in book", async () => {
    // No paying-in book seeded for zoneA's chapter, so any
    // non-null referenceCode at create time must reject.
    await expect(
      createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        referenceCode: "NO-MATCH-9999",
      }),
    ).rejects.toMatchObject({ code: "reference_code_not_in_book" });
  });

  it("accepts createBatch when a paying-in book covers the reference code", async () => {
    // Seed a book that covers the code, then assert the batch
    // create succeeds.
    const { payingInBooks } = await import("@stewardledger/db/schema");
    await db.insert(payingInBooks).values({
      zoneId: zoneA.id,
      chapterId: zoneA.chapterId,
      referenceCodeStart: "PIB-0001",
      referenceCodeEnd: "PIB-9999",
      dateFrom: "2020-01-01",
      dateTo: null,
    });
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      referenceCode: "PIB-0042",
    });
    expect(batch.referenceCode).toBe("PIB-0042");
  });

  it("normalises an empty-string referenceCode to null on createBatch (no bypass, no empty persisted)", async () => {
    // "" must be treated as 'no code attached' — the validator is
    // skipped (it would otherwise reject because no book covers
    // ""), AND the persisted column lands as null rather than "".
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      referenceCode: "",
    });
    expect(batch.referenceCode).toBeNull();
  });

  it("normalises an empty-string referenceCode to null on updateDraftBatch", async () => {
    // First create a batch with a real, validated reference code.
    const { payingInBooks } = await import("@stewardledger/db/schema");
    await db.insert(payingInBooks).values({
      zoneId: zoneA.id,
      chapterId: zoneA.chapterId,
      referenceCodeStart: "CLR-0000",
      referenceCodeEnd: "CLR-9999",
      dateFrom: "2020-01-01",
      dateTo: null,
    });
    const batch = await createBatch(db, { zoneId: zoneA.id, userId: USER_ID }, {
      chapterId: zoneA.chapterId,
      sourceType: "manual",
      referenceCode: "CLR-0042",
    });
    expect(batch.referenceCode).toBe("CLR-0042");
    // Patch with "": column is cleared to null.
    const updated = await updateDraftBatch(
      db,
      { zoneId: zoneA.id, userId: USER_ID },
      batch.id,
      { referenceCode: "" },
    );
    expect(updated.referenceCode).toBeNull();
  });
});
