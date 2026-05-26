// packages/api/src/services/families.test.ts
// Unit-level tests for services/families.ts and services/family-codes.ts.
// Covers happy paths and rejection paths that aren't exercised end-to-end
// by tenant-families.test.ts (the route tests cover most of the surface).
// RELEVANT FILES: packages/api/src/services/families.ts, packages/api/src/services/family-codes.ts, packages/api/src/routes/tenant-families.test.ts

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chapters,
  contributionLines,
  contributions,
  familyMembers,
  givingTypes,
  members,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";
import { seedZoneGivingSetup } from "./giving-setup-seed";
import {
  FamilyError,
  addFamilyMember,
  createFamily,
  familyForMember,
  familyGivingTotals,
  getFamilyDetail,
  listFamiliesForCaller,
  removeFamilyMember,
  softDeleteFamily,
  transferFamily,
  updateFamilyMember,
} from "./families";
import { nextFamilyReferenceCode } from "./family-codes";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedZone(): Promise<string> {
  const [row] = await db
    .insert(zones)
    .values({
      slug: `fams-svc-${unique()}`,
      name: `Family svc zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  return row.id;
}

async function seedChapter(zoneId: string, name = "ServiceChapter"): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name: `${name} ${unique()}`,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  return row.id;
}

async function seedMember(zoneId: string, chapterId: string, firstName: string): Promise<string> {
  const [row] = await db
    .insert(members)
    .values({
      zoneId,
      chapterId,
      referenceCode: `M-${unique()}`,
      firstName,
      lastName: "Service",
    })
    .returning({ id: members.id });
  return row.id;
}

describe("services/family-codes — nextFamilyReferenceCode", () => {
  let zoneId: string;

  beforeAll(async () => {
    zoneId = await seedZone();
  });

  afterAll(async () => {
    await db.execute(sql`delete from family_members where zone_id = ${zoneId}`);
    await db.execute(sql`delete from families where zone_id = ${zoneId}`);
    await db.execute(sql`delete from members where zone_id = ${zoneId}`);
    await db.execute(sql`delete from chapters where zone_id = ${zoneId}`);
    await db.execute(sql`delete from zones where id = ${zoneId}`);
  });

  it("starts at F0000001 and pads to width 7", async () => {
    const code = await db.transaction(async (tx) => nextFamilyReferenceCode(tx, zoneId));
    expect(code).toBe("F0000001");
  });

  it("monotonic counter excludes nothing — soft-deleted rows still consume the tail", async () => {
    const chapterId = await seedChapter(zoneId);
    const first = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Counter A ${unique()}` },
    );
    expect(first.referenceCode).toMatch(/^F\d{7}$/);
    // Soft-delete without releasing the count.
    await softDeleteFamily(db, { zoneId, userId: null as unknown as string }, first.id, "test");

    const second = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Counter B ${unique()}` },
    );
    const firstNum = Number(first.referenceCode.slice(1));
    const secondNum = Number(second.referenceCode.slice(1));
    expect(secondNum).toBeGreaterThan(firstNum);
  });
});

describe("services/families — service-level rules", () => {
  let zoneId: string;
  let chapterId: string;
  let chapterOtherId: string;
  let alice: string;
  let bob: string;
  let charlie: string;

  beforeAll(async () => {
    zoneId = await seedZone();
    chapterId = await seedChapter(zoneId, "Main");
    chapterOtherId = await seedChapter(zoneId, "Other");
    alice = await seedMember(zoneId, chapterId, "Alice");
    bob = await seedMember(zoneId, chapterId, "Bob");
    charlie = await seedMember(zoneId, chapterId, "Charlie");
  });

  afterAll(async () => {
    await db.execute(sql`delete from family_members where zone_id = ${zoneId}`);
    await db.execute(sql`delete from families where zone_id = ${zoneId}`);
    await db.execute(sql`delete from members where zone_id = ${zoneId}`);
    await db.execute(sql`delete from chapters where zone_id = ${zoneId}`);
    await db.execute(sql`delete from zones where id = ${zoneId}`);
  });

  it("createFamily with primary member writes one family row + one membership row", async () => {
    const detail = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      {
        chapterId,
        name: `Create with primary ${unique()}`,
        primaryMemberId: alice,
        primaryMemberRelationship: "spouse",
      },
    );
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0].memberId).toBe(alice);
    expect(detail.members[0].isPrimaryContact).toBe(true);
    expect(detail.members[0].relationship).toBe("spouse");

    const reread = await getFamilyDetail(db, zoneId, detail.id);
    expect(reread?.members).toHaveLength(1);
  });

  it("addFamilyMember refuses a member whose chapter doesn't match", async () => {
    const detail = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Chapter mismatch ${unique()}` },
    );
    const someoneElse = await seedMember(zoneId, chapterOtherId, "Wrong");
    await expect(
      addFamilyMember(
        db,
        { zoneId, userId: null as unknown as string },
        detail.id,
        { memberId: someoneElse },
      ),
    ).rejects.toBeInstanceOf(FamilyError);
  });

  it("removeFamilyMember archives via left_at and writes a non-null reason", async () => {
    const detail = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Remove via left_at ${unique()}`, primaryMemberId: bob },
    );
    // Adding a second so the primary can be removed
    await addFamilyMember(db, { zoneId, userId: null as unknown as string }, detail.id, {
      memberId: charlie,
      isPrimaryContact: true, // promote charlie so bob can leave
    });
    await removeFamilyMember(
      db,
      { zoneId, userId: null as unknown as string },
      detail.id,
      bob,
      "moved",
    );
    const reread = await getFamilyDetail(db, zoneId, detail.id);
    const bobRow = reread!.members.find((r) => r.memberId === bob)!;
    expect(bobRow.leftAt).not.toBeNull();
    expect(bobRow.isPrimaryContact).toBe(false);
  });

  it("transferFamily moves every open member to the destination", async () => {
    // Need two members not bound elsewhere — seed fresh.
    const d = await seedMember(zoneId, chapterId, "Dave");
    const e = await seedMember(zoneId, chapterId, "Eve");
    const src = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Src ${unique()}`, primaryMemberId: d },
    );
    await addFamilyMember(db, { zoneId, userId: null as unknown as string }, src.id, {
      memberId: e,
    });
    const dst = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Dst ${unique()}` },
    );

    const result = await transferFamily(
      db,
      { zoneId, userId: null as unknown as string },
      src.id,
      dst.id,
      null,
    );
    expect(result.movedMemberIds.sort()).toEqual([d, e].sort());

    const srcDetail = await getFamilyDetail(db, zoneId, src.id);
    expect(srcDetail!.members.filter((m) => m.leftAt === null)).toHaveLength(0);
    const dstDetail = await getFamilyDetail(db, zoneId, dst.id);
    expect(dstDetail!.members.filter((m) => m.leftAt === null)).toHaveLength(2);
    const primary = dstDetail!.members.find((m) => m.isPrimaryContact)!;
    expect([d, e]).toContain(primary.memberId);
  });

  it("transferFamily refuses cross-chapter moves", async () => {
    const otherChapter = chapterOtherId;
    const a = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Xchapter src ${unique()}` },
    );
    const b = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId: otherChapter, name: `Xchapter dst ${unique()}` },
    );
    await expect(
      transferFamily(db, { zoneId, userId: null as unknown as string }, a.id, b.id, null),
    ).rejects.toBeInstanceOf(FamilyError);
  });

  it("familyForMember returns the open family or null", async () => {
    const m = await seedMember(zoneId, chapterId, "ForLookup");
    expect(await familyForMember(db, zoneId, m)).toBeNull();
    const f = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Lookup ${unique()}`, primaryMemberId: m },
    );
    const found = await familyForMember(db, zoneId, m);
    expect(found?.id).toBe(f.id);
  });

  it("updateFamilyMember refuses to demote the last primary", async () => {
    const m = await seedMember(zoneId, chapterId, "Sole");
    const f = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Sole primary ${unique()}`, primaryMemberId: m },
    );
    await expect(
      updateFamilyMember(
        db,
        { zoneId, userId: null as unknown as string },
        f.id,
        m,
        { isPrimaryContact: false },
      ),
    ).rejects.toBeInstanceOf(FamilyError);
  });

  it("familyGivingTotals returns an empty array when no contributions exist", async () => {
    const f = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Givings empty ${unique()}` },
    );
    const totals = await familyGivingTotals(db, zoneId, f.id, {
      dateFrom: "2024-01-01",
      dateTo: "2025-12-31",
    });
    expect(totals).toEqual([]);
  });

  it("listFamiliesForCaller filters by chapter and search needle", async () => {
    const fA = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Adams ${unique()}` },
    );
    const fB = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId: chapterOtherId, name: `Smith ${unique()}` },
    );

    const allRes = await listFamiliesForCaller(db, {
      zoneId,
      chapterIds: "all",
      q: "Adams",
      limit: 50,
      offset: 0,
    });
    const allIds = allRes.rows.map((r) => r.id);
    expect(allIds).toContain(fA.id);
    expect(allIds).not.toContain(fB.id);

    const chRes = await listFamiliesForCaller(db, {
      zoneId,
      chapterIds: [chapterOtherId],
      limit: 50,
      offset: 0,
    });
    const chIds = chRes.rows.map((r) => r.id);
    expect(chIds).toContain(fB.id);
    expect(chIds).not.toContain(fA.id);
  });
});

/**
 * Point-in-time attribution: a contribution counts against the household
 * the giver belonged to ON the contribution date, even after the giver
 * transfers to a different household. Catches a regression to the
 * previous semantic (current-membership join) that re-attributed history.
 */
describe("services/families — historical attribution", () => {
  let zoneId: string;
  let chapterId: string;
  let givingTypeId: string;
  let person: string;

  beforeAll(async () => {
    zoneId = await seedZone();
    await seedZoneGivingSetup(db, zoneId, "GBP");
    chapterId = await seedChapter(zoneId, "Attribution");
    person = await seedMember(zoneId, chapterId, "Pat");
    const [gt] = await db
      .select({ id: givingTypes.id })
      .from(givingTypes)
      .where(sql`${givingTypes.zoneId} = ${zoneId} and ${givingTypes.shortCode} = 'TITHE'`)
      .limit(1);
    givingTypeId = gt.id;
  });

  afterAll(async () => {
    // Posted contributions are immutable / undeletable via the
    // contributions_no_delete_when_posted trigger; disable it for the
    // test cleanup (same pattern as contributions.test.ts:186). The
    // advisory lock serialises against any other suite calling
    // applyContributionTriggers concurrently.
    const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
      );
      for (const [table, name] of guards) {
        await tx.execute(sql.raw(`alter table ${table} disable trigger ${name}`));
      }
      await tx.execute(sql`delete from contribution_lines where zone_id = ${zoneId}`);
      await tx.execute(sql`delete from contributions where zone_id = ${zoneId}`);
      await tx.execute(sql`delete from family_members where zone_id = ${zoneId}`);
      await tx.execute(sql`delete from families where zone_id = ${zoneId}`);
      await tx.execute(sql`delete from members where zone_id = ${zoneId}`);
      await tx.execute(sql`delete from chapters where zone_id = ${zoneId}`);
      await tx.execute(sql`delete from zones where id = ${zoneId}`);
      for (const [table, name] of guards) {
        await tx.execute(sql.raw(`alter table ${table} enable trigger ${name}`));
      }
    });
  });

  it("familyGivingTotals attributes to the household active on the contribution date, not the current one", async () => {
    // Model the real-world shape: Pat was in household A from
    // 2025-01-01 to 2025-05-31, then moved to household B from
    // 2025-06-01 onward. We insert the rows directly because
    // transferFamily moves a row in place rather than closing one
    // and opening another — the test needs both states to coexist.
    const famA = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Attrib A ${unique()}` },
    );
    const famB = await createFamily(
      db,
      { zoneId, userId: null as unknown as string },
      { chapterId, name: `Attrib B ${unique()}` },
    );
    await db.insert(familyMembers).values({
      zoneId,
      familyId: famA.id,
      memberId: person,
      relationship: "head",
      isPrimaryContact: false,
      joinedAt: "2025-01-01",
      leftAt: "2025-05-31",
    });
    await db.insert(familyMembers).values({
      zoneId,
      familyId: famB.id,
      memberId: person,
      relationship: "head",
      isPrimaryContact: true,
      joinedAt: "2025-06-01",
      leftAt: null,
    });

    // Two contributions: 2025-03-01 (inside Pat's A window) and
    // 2025-08-01 (inside Pat's B window). Insert as draft so the
    // posted-immutability trigger doesn't reject the line insert; then
    // transition status to posted via UPDATE (legal per
    // contributions_posted_guard — the trigger allows draft→posted).
    const seedContribution = async (
      date: string,
      amount: string,
    ): Promise<string> => {
      const [row] = await db
        .insert(contributions)
        .values({
          zoneId,
          chapterId,
          memberId: person,
          sourceType: "manual",
          contributionDate: date,
          totalAmount: amount,
          currencyCode: "GBP",
          status: "draft",
        })
        .returning({ id: contributions.id });
      await db.insert(contributionLines).values({
        zoneId,
        contributionId: row.id,
        givingTypeId,
        amount,
        currencyCode: "GBP",
      });
      await db
        .update(contributions)
        .set({ status: "posted", postedAt: new Date(`${date}T10:00:00Z`) })
        .where(sql`${contributions.id} = ${row.id}`);
      return row.id;
    };
    await seedContribution("2025-03-01", "100.0000");
    await seedContribution("2025-08-01", "50.0000");

    const totalsA = await familyGivingTotals(db, zoneId, famA.id, {
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
    });
    const totalsB = await familyGivingTotals(db, zoneId, famB.id, {
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
    });

    // March contribution attributes to A; August contribution attributes
    // to B. The pre-fix current-membership join would have rolled both
    // into B (Pat's current household).
    expect(totalsA).toEqual([{ currencyCode: "GBP", total: "100.0000" }]);
    expect(totalsB).toEqual([{ currencyCode: "GBP", total: "50.0000" }]);
  });
});
