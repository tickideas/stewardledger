// packages/api/src/services/groups.test.ts
// Integration tests for the groups service module: assertions, pre-enable
// assignment, post-enable moves, zone enable, and soft-delete invariants.
// RELEVANT FILES: ./groups.ts, packages/db/src/schema/groups.ts, packages/db/src/schema/chapters.ts

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  chapterGroupHistory,
  chapters,
  groups,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";
import {
  GroupNameTakenError,
  GroupSlugTakenError,
  GroupsNotEnabledError,
  GroupsEnableBlockedError,
  GroupNotEmptyError,
  HistoryViolationError,
  assertGroupNameAvailable,
  assertGroupSlugAvailable,
  assignChapterToGroupPreEnable,
  enableGroupsForZone,
  moveChapterToGroup,
  softDeleteGroup,
} from "./groups";

function unique() { return Math.random().toString(36).slice(2, 10); }

async function makeZone(): Promise<string> {
  const [z] = await db.insert(zones).values({
    slug: `gz-${unique()}`,
    name: `GZ ${unique()}`,
    countryCode: "GB",
    defaultCurrencyCode: "GBP",
    defaultTimeZone: "Europe/London",
    regionNameUnverified: `Inbox ${unique()}`,
  }).returning({ id: zones.id });
  return z.id;
}

async function makeGroup(zoneId: string, name = `G ${unique()}`, slug = `g-${unique()}`): Promise<string> {
  const [g] = await db.insert(groups).values({ zoneId, name, slug }).returning({ id: groups.id });
  return g.id;
}

async function makeChapter(zoneId: string, opts: { groupId?: string; dateFrom?: string } = {}): Promise<string> {
  const [c] = await db.insert(chapters).values({
    zoneId,
    groupId: opts.groupId,
    referenceCode: `C-${unique()}`,
    name: "C",
    dateFrom: opts.dateFrom ?? "2020-01-01",
  }).returning({ id: chapters.id });
  return c.id;
}

describe("assertGroupNameAvailable", () => {
  it("passes when name is unused in the zone", async () => {
    const z = await makeZone();
    await expect(assertGroupNameAvailable(db, z, "Fresh Name")).resolves.toBeUndefined();
  });

  it("rejects case-insensitive duplicate in same zone", async () => {
    const z = await makeZone();
    await makeGroup(z, "Region East", `re-${unique()}`);
    await expect(assertGroupNameAvailable(db, z, "REGION EAST")).rejects.toBeInstanceOf(GroupNameTakenError);
  });

  it("allows the same name in a different zone", async () => {
    const z1 = await makeZone();
    const z2 = await makeZone();
    await makeGroup(z1, "Region East", `re-${unique()}`);
    await expect(assertGroupNameAvailable(db, z2, "Region East")).resolves.toBeUndefined();
  });

  it("ignores a self-reference via excludeGroupId", async () => {
    const z = await makeZone();
    const gid = await makeGroup(z, "Region East", `re-${unique()}`);
    await expect(assertGroupNameAvailable(db, z, "Region East", { excludeGroupId: gid })).resolves.toBeUndefined();
  });
});

describe("assertGroupSlugAvailable", () => {
  it("rejects duplicate slug in same zone", async () => {
    const z = await makeZone();
    await makeGroup(z, `G ${unique()}`, "shared-slug");
    await expect(assertGroupSlugAvailable(db, z, "shared-slug")).rejects.toBeInstanceOf(GroupSlugTakenError);
  });
});

describe("assignChapterToGroupPreEnable", () => {
  it("sets chapters.group_id and writes no history", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z);
    await assignChapterToGroupPreEnable(db, { zoneId: z, chapterId: c, groupId: g, actorUserId: null });
    const [row] = await db.select({ groupId: chapters.groupId }).from(chapters).where(eq(chapters.id, c));
    expect(row.groupId).toBe(g);
    const hist = await db.select().from(chapterGroupHistory).where(eq(chapterGroupHistory.chapterId, c));
    expect(hist).toHaveLength(0);
  });

  it("refuses when groups already enabled", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await expect(
      assignChapterToGroupPreEnable(db, { zoneId: z, chapterId: c, groupId: g, actorUserId: null }),
    ).rejects.toBeInstanceOf(GroupsNotEnabledError);
  });

  it("rejects cross-zone group", async () => {
    const z1 = await makeZone();
    const z2 = await makeZone();
    const gOtherZone = await makeGroup(z2);
    const c = await makeChapter(z1);
    await expect(
      assignChapterToGroupPreEnable(db, { zoneId: z1, chapterId: c, groupId: gOtherZone, actorUserId: null }),
    ).rejects.toThrow();
  });
});

describe("enableGroupsForZone", () => {
  it("refuses when any chapter has null group_id", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await makeChapter(z, { groupId: g });
    await makeChapter(z); // unassigned
    await expect(enableGroupsForZone(db, { zoneId: z, actorUserId: null })).rejects.toBeInstanceOf(GroupsEnableBlockedError);
  });

  it("flips flag and opens initial history segments", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g, dateFrom: "2018-05-01" });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    const [zRow] = await db.select({ enabled: zones.groupsEnabled }).from(zones).where(eq(zones.id, z));
    expect(zRow.enabled).toBe(true);
    const segs = await db.select().from(chapterGroupHistory).where(eq(chapterGroupHistory.chapterId, c));
    expect(segs).toHaveLength(1);
    expect(segs[0].dateFrom).toBe("2018-05-01");
    expect(segs[0].dateTo).toBeNull();
    expect(segs[0].groupId).toBe(g);
  });

  it("is idempotent when already enabled", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await makeChapter(z, { groupId: g });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await expect(enableGroupsForZone(db, { zoneId: z, actorUserId: null })).resolves.toBeUndefined();
  });
});

describe("moveChapterToGroup", () => {
  it("closes open segment and opens a new one", async () => {
    const z = await makeZone();
    const gA = await makeGroup(z);
    const gB = await makeGroup(z);
    const c = await makeChapter(z, { groupId: gA, dateFrom: "2020-01-01" });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await moveChapterToGroup(db, {
      zoneId: z,
      chapterId: c,
      newGroupId: gB,
      effectiveDate: "2026-05-22",
      actorUserId: null,
    });
    const segs = await db
      .select()
      .from(chapterGroupHistory)
      .where(eq(chapterGroupHistory.chapterId, c))
      .orderBy(chapterGroupHistory.dateFrom);
    expect(segs).toHaveLength(2);
    expect(segs[0].groupId).toBe(gA);
    expect(segs[0].dateFrom).toBe("2020-01-01");
    expect(segs[0].dateTo).toBe("2026-05-21");
    expect(segs[1].groupId).toBe(gB);
    expect(segs[1].dateFrom).toBe("2026-05-22");
    expect(segs[1].dateTo).toBeNull();
    const [chap] = await db.select({ groupId: chapters.groupId }).from(chapters).where(eq(chapters.id, c));
    expect(chap.groupId).toBe(gB);
  });

  it("refuses when groups disabled", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g });
    await expect(
      moveChapterToGroup(db, { zoneId: z, chapterId: c, newGroupId: g, effectiveDate: "2026-05-22", actorUserId: null }),
    ).rejects.toBeInstanceOf(GroupsNotEnabledError);
  });

  it("refuses backdating before the open segment's date_from", async () => {
    const z = await makeZone();
    const gA = await makeGroup(z);
    const gB = await makeGroup(z);
    const c = await makeChapter(z, { groupId: gA, dateFrom: "2020-01-01" });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await expect(
      moveChapterToGroup(db, { zoneId: z, chapterId: c, newGroupId: gB, effectiveDate: "2019-12-31", actorUserId: null }),
    ).rejects.toBeInstanceOf(HistoryViolationError);
  });

  it("refuses same-day move (would produce inverted history)", async () => {
    const z = await makeZone();
    const gA = await makeGroup(z);
    const gB = await makeGroup(z);
    const c = await makeChapter(z, { groupId: gA, dateFrom: "2026-05-22" });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await expect(
      moveChapterToGroup(db, { zoneId: z, chapterId: c, newGroupId: gB, effectiveDate: "2026-05-22", actorUserId: null }),
    ).rejects.toBeInstanceOf(HistoryViolationError);
  });

  it("no-ops when newGroupId equals current group_id", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await moveChapterToGroup(db, { zoneId: z, chapterId: c, newGroupId: g, effectiveDate: "2026-05-22", actorUserId: null });
    const segs = await db.select().from(chapterGroupHistory).where(eq(chapterGroupHistory.chapterId, c));
    expect(segs).toHaveLength(1);
  });
});

describe("softDeleteGroup", () => {
  it("refuses when group has active chapters", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await makeChapter(z, { groupId: g });
    await expect(softDeleteGroup(db, { zoneId: z, groupId: g, actorUserId: null })).rejects.toBeInstanceOf(GroupNotEmptyError);
  });

  it("succeeds when empty", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await softDeleteGroup(db, { zoneId: z, groupId: g, actorUserId: null });
    const [row] = await db.select({ deletedAt: groups.deletedAt }).from(groups).where(eq(groups.id, g));
    expect(row.deletedAt).not.toBeNull();
  });
});
