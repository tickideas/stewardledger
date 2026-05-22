// packages/api/src/middleware/auth.test.ts
// Integration tests for the visibleChapterIds chokepoint that narrows
// tenant reads to the chapters a group-tier session can legitimately see.
// RELEVANT FILES: ./auth.ts, packages/shared/src/types.ts, packages/db/src/schema/roles.ts

import { beforeAll, describe, expect, it } from "vitest";
import {
  chapters,
  groups,
  zones,
} from "@stewardledger/db/schema";
import {
  GROUP_ROLES,
  ZONE_ROLES,
  CHAPTER_ROLES,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { db } from "../db";
import { requireChapterScope, visibleChapterIds } from "./auth";

const ZONE_WIDE = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

function unique() {
  return Math.random().toString(36).slice(2, 10);
}

async function createZoneWithChapters(): Promise<{
  zoneId: string;
  groupAId: string;
  groupBId: string;
  chap1: string;
  chap2: string;
  chap3: string;
  chap4: string;
}> {
  const slug = `tz-${unique()}`;
  const [z] = await db
    .insert(zones)
    .values({
      slug,
      name: `Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Inbox ${unique()}`,
    })
    .returning({ id: zones.id });
  const [gA] = await db.insert(groups).values({ zoneId: z.id, name: `GA-${unique()}`, slug: `ga-${unique()}` }).returning({ id: groups.id });
  const [gB] = await db.insert(groups).values({ zoneId: z.id, name: `GB-${unique()}`, slug: `gb-${unique()}` }).returning({ id: groups.id });
  const [c1] = await db.insert(chapters).values({ zoneId: z.id, groupId: gA.id, referenceCode: `C-${unique()}`, name: "C1", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  const [c2] = await db.insert(chapters).values({ zoneId: z.id, groupId: gA.id, referenceCode: `C-${unique()}`, name: "C2", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  const [c3] = await db.insert(chapters).values({ zoneId: z.id, groupId: gB.id, referenceCode: `C-${unique()}`, name: "C3", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  const [c4] = await db.insert(chapters).values({ zoneId: z.id, referenceCode: `C-${unique()}`, name: "C4", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  return { zoneId: z.id, groupAId: gA.id, groupBId: gB.id, chap1: c1.id, chap2: c2.id, chap3: c3.id, chap4: c4.id };
}

function ctxFor(opts: { zoneId: string; roleCodes: string[]; chapterIds?: string[]; groupIds?: string[]; isPlatformAdmin?: boolean }): AuthorizedContext {
  return {
    userId: "test-user",
    zoneId: opts.zoneId,
    regionId: null,
    roleCodes: opts.roleCodes,
    chapterIds: opts.chapterIds ?? [],
    groupIds: opts.groupIds ?? [],
    isPlatformAdmin: opts.isPlatformAdmin ?? false,
  };
}

describe("visibleChapterIds", () => {
  let z: Awaited<ReturnType<typeof createZoneWithChapters>>;

  beforeAll(async () => {
    z = await createZoneWithChapters();
  });

  it("returns 'all' for zone-tier sessions", async () => {
    const out = await visibleChapterIds(
      ctxFor({ zoneId: z.zoneId, roleCodes: [ZONE_ROLES.ZONE_ADMIN] }),
      ZONE_WIDE,
    );
    expect(out).toEqual({ kind: "all" });
  });

  it("returns 'all' for platform super-admins", async () => {
    const out = await visibleChapterIds(
      ctxFor({ zoneId: z.zoneId, roleCodes: [], isPlatformAdmin: true }),
      ZONE_WIDE,
    );
    expect(out).toEqual({ kind: "all" });
  });

  it("returns only the bound chapters for a chapter-tier session", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [CHAPTER_ROLES.CHAPTER_ADMIN],
        chapterIds: [z.chap2],
      }),
      ZONE_WIDE,
    );
    expect(out).toEqual({ kind: "list", ids: [z.chap2] });
  });

  it("returns the group's chapters for a single group binding", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN],
        groupIds: [z.groupAId],
      }),
      ZONE_WIDE,
    );
    expect(out.kind).toBe("list");
    if (out.kind !== "list") throw new Error();
    expect(out.ids.sort()).toEqual([z.chap1, z.chap2].sort());
  });

  it("unions two group bindings", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN],
        groupIds: [z.groupAId, z.groupBId],
      }),
      ZONE_WIDE,
    );
    expect(out.kind).toBe("list");
    if (out.kind !== "list") throw new Error();
    expect(out.ids.sort()).toEqual([z.chap1, z.chap2, z.chap3].sort());
  });

  it("requireChapterScope allows a chapter whose group_id is in ctx.groupIds", async () => {
    const res = await requireChapterScope(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN],
        groupIds: [z.groupAId],
      }),
      z.chap1,
      ZONE_WIDE,
    );
    expect(res).toEqual({ ok: true });
  });

  it("requireChapterScope forbids a chapter outside the caller's groups and chapters", async () => {
    const res = await requireChapterScope(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN],
        groupIds: [z.groupAId],
      }),
      z.chap3,
      ZONE_WIDE,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.status).toBe(403);
  });

  it("unions group + chapter bindings", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN, CHAPTER_ROLES.CHAPTER_ADMIN],
        groupIds: [z.groupAId],
        chapterIds: [z.chap4],
      }),
      ZONE_WIDE,
    );
    expect(out.kind).toBe("list");
    if (out.kind !== "list") throw new Error();
    expect(out.ids.sort()).toEqual([z.chap1, z.chap2, z.chap4].sort());
  });
});
