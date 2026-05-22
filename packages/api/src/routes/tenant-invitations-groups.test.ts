// packages/api/src/routes/tenant-invitations-groups.test.ts
// Phase 4 — POST/Revoke /invitations with groupId + group_admin invite rules.
// Asserts the role gate and shape checks added in Task 14.
// RELEVANT FILES: packages/api/src/routes/tenant.ts, packages/api/src/services/invitations.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  chapters,
  groups,
  invitations,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { seedZoneRoles } from "../services/role-seed";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const HOST_DOMAIN = "localhost";

interface SeededZone {
  id: string;
  slug: string;
  ownerRoleId: string;
  zoneAdminRoleId: string;
  groupAdminRoleId: string;
  chapterAdminRoleId: string;
  chapterTreasurerRoleId: string;
  groupPastorViewerRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Invite Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const r = await seedZoneRoles(db, zone.id);
  return {
    id: zone.id,
    slug: zone.slug,
    ownerRoleId: r.get(ZONE_ROLES.ZONE_OWNER)!,
    zoneAdminRoleId: r.get(ZONE_ROLES.ZONE_ADMIN)!,
    groupAdminRoleId: r.get(GROUP_ROLES.GROUP_ADMIN)!,
    chapterAdminRoleId: r.get(CHAPTER_ROLES.CHAPTER_ADMIN)!,
    chapterTreasurerRoleId: r.get(CHAPTER_ROLES.CHAPTER_TREASURER)!,
    groupPastorViewerRoleId: r.get(GROUP_ROLES.GROUP_PASTOR_VIEWER)!,
  };
}

async function seedChapter(zoneId: string, groupId: string | null = null): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name: `Chapter ${unique()}`,
      groupId,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  return row.id;
}

async function seedGroup(zoneId: string): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ zoneId, name: `Group ${unique()}`, slug: `g-${unique()}` })
    .returning({ id: groups.id });
  return row.id;
}

async function seedUser(email: string): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({ id, email, emailVerified: true });
  return id;
}

async function bindUser(
  userId: string,
  zoneId: string,
  roleId: string,
  opts: { chapterId?: string; groupId?: string; scope: "zone" | "chapter" | "group" },
): Promise<void> {
  await db.insert(userRoleBindings).values({
    userId,
    zoneId,
    roleId,
    chapterId: opts.chapterId ?? null,
    groupId: opts.groupId ?? null,
    roleScope: opts.scope,
  });
}

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

const app = createApp();

async function call(
  slug: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://${slug}.${HOST_DOMAIN}${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body
        ? { "content-type": "application/json", host: `${slug}.${HOST_DOMAIN}` }
        : { host: `${slug}.${HOST_DOMAIN}` },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

describe("invitations — groups + group_admin rules", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let ownerA: string;
  let groupAdminA: string;
  let groupAId: string;
  let otherGroupAId: string;
  let groupBId: string;
  let chapterInGroup: string;
  let chapterOutsideGroup: string;
  let chapterInOtherGroup: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("requires *_test DATABASE_URL");
    }
    zoneA = await seedZone(`inv-a-${unique()}`);
    zoneB = await seedZone(`inv-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    groupAId = await seedGroup(zoneA.id);
    otherGroupAId = await seedGroup(zoneA.id);
    groupBId = await seedGroup(zoneB.id);

    chapterInGroup = await seedChapter(zoneA.id, groupAId);
    chapterOutsideGroup = await seedChapter(zoneA.id, null);
    chapterInOtherGroup = await seedChapter(zoneA.id, otherGroupAId);

    ownerA = await seedUser(`inv-owner+${unique()}@example.com`);
    groupAdminA = await seedUser(`inv-gadm+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, groupAdminA);

    await bindUser(ownerA, zoneA.id, zoneA.ownerRoleId, { scope: "zone" });
    await bindUser(groupAdminA, zoneA.id, zoneA.groupAdminRoleId, {
      scope: "group",
      groupId: groupAId,
    });
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      const z = sql`(select id from zones where slug = ${slug})`;
      await db.execute(sql`delete from invitations where zone_id = ${z}`);
      await db.execute(sql`update chapters set group_id = null where zone_id = ${z}`);
      await db.execute(sql`delete from groups where zone_id = ${z}`);
      await db.execute(sql`delete from chapters where zone_id = ${z}`);
      await db.execute(sql`delete from user_role_bindings where zone_id = ${z}`);
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asUser(id: string, email = "x@example.com") {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(id, email));
  }

  describe("POST /invitations — group support", () => {
    it("zone_owner can invite group_admin with groupId", async () => {
      asUser(ownerA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `g1+${unique()}@example.com`,
          roleCode: GROUP_ROLES.GROUP_ADMIN,
          groupId: groupAId,
        },
      });
      expect(res.status).toBe(201);
    });

    it("zone_owner can invite group_pastor_viewer with groupId", async () => {
      asUser(ownerA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `gpv+${unique()}@example.com`,
          roleCode: GROUP_ROLES.GROUP_PASTOR_VIEWER,
          groupId: groupAId,
        },
      });
      expect(res.status).toBe(201);
    });

    it("rejects group role without groupId (zod)", async () => {
      asUser(ownerA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `nope+${unique()}@example.com`,
          roleCode: GROUP_ROLES.GROUP_ADMIN,
        },
      });
      expect(res.status).toBe(400);
    });

    it("rejects cross-zone groupId (404 group_not_found)", async () => {
      asUser(ownerA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `xz+${unique()}@example.com`,
          roleCode: GROUP_ROLES.GROUP_ADMIN,
          groupId: groupBId,
        },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });

    it("rejects chapter role with both chapterId and groupId (zod 400)", async () => {
      asUser(ownerA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `both+${unique()}@example.com`,
          roleCode: CHAPTER_ROLES.CHAPTER_TREASURER,
          chapterId: chapterInGroup,
          groupId: groupAId,
        },
      });
      expect(res.status).toBe(400);
    });

    it("group_admin can invite chapter_admin into a chapter in their group", async () => {
      asUser(groupAdminA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `ga-ok+${unique()}@example.com`,
          roleCode: CHAPTER_ROLES.CHAPTER_ADMIN,
          chapterId: chapterInGroup,
        },
      });
      expect(res.status).toBe(201);
    });

    it("group_admin cannot invite into a chapter not in their group (403)", async () => {
      asUser(groupAdminA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `ga-bad+${unique()}@example.com`,
          roleCode: CHAPTER_ROLES.CHAPTER_ADMIN,
          chapterId: chapterInOtherGroup,
        },
      });
      expect(res.status).toBe(403);
    });

    it("group_admin cannot invite into an ungrouped chapter (403)", async () => {
      asUser(groupAdminA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `ga-null+${unique()}@example.com`,
          roleCode: CHAPTER_ROLES.CHAPTER_ADMIN,
          chapterId: chapterOutsideGroup,
        },
      });
      expect(res.status).toBe(403);
    });

    it("group_admin cannot invite zone roles (403)", async () => {
      asUser(groupAdminA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `ga-zone+${unique()}@example.com`,
          roleCode: ZONE_ROLES.ZONE_ADMIN,
        },
      });
      expect(res.status).toBe(403);
    });

    it("group_admin cannot invite group roles (403)", async () => {
      asUser(groupAdminA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `ga-grp+${unique()}@example.com`,
          roleCode: GROUP_ROLES.GROUP_PASTOR_VIEWER,
          groupId: groupAId,
        },
      });
      expect(res.status).toBe(403);
    });

    it("group_admin needs chapterId for a chapter role (zod 400)", async () => {
      asUser(groupAdminA);
      const res = await call(zoneA.slug, "/api/tenant/invitations", {
        method: "POST",
        body: {
          email: `ga-noch+${unique()}@example.com`,
          roleCode: CHAPTER_ROLES.CHAPTER_ADMIN,
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /invitations/:id/revoke — group support", () => {
    async function seedOpenInv(
      zoneId: string,
      roleCode: string,
      opts: { chapterId?: string; groupId?: string } = {},
    ): Promise<string> {
      const [row] = await db
        .insert(invitations)
        .values({
          zoneId,
          email: `inv+${unique()}@example.com`,
          roleCode,
          chapterId: opts.chapterId ?? null,
          groupId: opts.groupId ?? null,
          tokenHash: `h-${unique()}-${unique()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: invitations.id });
      return row.id;
    }

    it("group_admin can revoke chapter invite in their group", async () => {
      const id = await seedOpenInv(zoneA.id, CHAPTER_ROLES.CHAPTER_TREASURER, {
        chapterId: chapterInGroup,
      });
      asUser(groupAdminA);
      const res = await call(zoneA.slug, `/api/tenant/invitations/${id}/revoke`, {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(200);
    });

    it("group_admin cannot revoke chapter invite outside their group", async () => {
      const id = await seedOpenInv(zoneA.id, CHAPTER_ROLES.CHAPTER_TREASURER, {
        chapterId: chapterInOtherGroup,
      });
      asUser(groupAdminA);
      const res = await call(zoneA.slug, `/api/tenant/invitations/${id}/revoke`, {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(403);
    });

    it("group_admin cannot revoke group invites", async () => {
      const id = await seedOpenInv(zoneA.id, GROUP_ROLES.GROUP_PASTOR_VIEWER, {
        groupId: groupAId,
      });
      asUser(groupAdminA);
      const res = await call(zoneA.slug, `/api/tenant/invitations/${id}/revoke`, {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(403);
    });

    it("group_admin cannot revoke zone invites", async () => {
      const id = await seedOpenInv(zoneA.id, ZONE_ROLES.ZONE_ADMIN);
      asUser(groupAdminA);
      const res = await call(zoneA.slug, `/api/tenant/invitations/${id}/revoke`, {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(403);
    });
  });
});
