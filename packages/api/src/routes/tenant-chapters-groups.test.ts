// packages/api/src/routes/tenant-chapters-groups.test.ts
// Tests for the chapter create + assign flows that honour groupId
// and the pre/post-enable distinction enforced by the groups service.
// RELEVANT FILES: ./tenant.ts, ../services/groups.ts, ../../../shared/src/schemas.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHAPTER_ROLES,
  GROUP_ROLES,
  ZONE_ROLES,
} from "@stewardledger/shared";
import {
  chapterGroupHistory,
  chapters,
  groups,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { enableGroupsForZone } from "../services/groups";
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
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `CGZone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const seeded = await seedZoneRoles(db, zone.id);
  return {
    id: zone.id,
    slug: zone.slug,
    ownerRoleId: seeded.get(ZONE_ROLES.ZONE_OWNER)!,
    zoneAdminRoleId: seeded.get(ZONE_ROLES.ZONE_ADMIN)!,
    groupAdminRoleId: seeded.get(GROUP_ROLES.GROUP_ADMIN)!,
    chapterAdminRoleId: seeded.get(CHAPTER_ROLES.CHAPTER_ADMIN)!,
  };
}

async function seedUser(email: string): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({ id, email, emailVerified: true });
  return id;
}

async function seedGroup(zoneId: string, slug: string): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ zoneId, name: `G ${slug} ${unique()}`, slug: `${slug}-${unique()}` })
    .returning({ id: groups.id });
  return row.id;
}

async function seedChapter(zoneId: string, groupId: string | null = null): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name: `Ch ${unique()}`,
      groupId,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  return row.id;
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

interface FetchOptions {
  method?: string;
  body?: unknown;
}

async function call(slug: string, path: string, opts: FetchOptions = {}): Promise<Response> {
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

describe("chapters create+patch honour groupId / groups_enabled", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let owner: string;
  let zoneAdmin: string;
  let chapterAdmin: string;
  let groupAdmin: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-chapters-groups.test.ts requires a *_test DATABASE_URL");
    }
    zoneA = await seedZone(`cga-${unique()}`);
    zoneB = await seedZone(`cgb-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    owner = await seedUser(`cg-own+${unique()}@example.com`);
    zoneAdmin = await seedUser(`cg-zadm+${unique()}@example.com`);
    chapterAdmin = await seedUser(`cg-chadm+${unique()}@example.com`);
    groupAdmin = await seedUser(`cg-gadm+${unique()}@example.com`);
    cleanupUserIds.push(owner, zoneAdmin, chapterAdmin, groupAdmin);

    await bindUser(owner, zoneA.id, zoneA.ownerRoleId, { scope: "zone" });
    await bindUser(zoneAdmin, zoneA.id, zoneA.zoneAdminRoleId, { scope: "zone" });
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
      await db.execute(sql`delete from chapter_group_history where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`update chapters set group_id = null where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from groups where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from chapters where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from user_role_bindings where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asUser(userId: string, email: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userId, email));
  }

  describe("POST /chapters — groups", () => {
    it("creates chapter with groupId when groups disabled", async () => {
      asUser(owner, "o@example.com");
      const gid = await seedGroup(zoneA.id, "pre");
      const res = await call(zoneA.slug, "/api/tenant/chapters", {
        method: "POST",
        body: { name: `Pre ${unique()}`, groupId: gid },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { chapter: { id: string; groupId: string | null } };
      expect(body.chapter.groupId).toBe(gid);
      const hist = await db
        .select({ id: chapterGroupHistory.id })
        .from(chapterGroupHistory)
        .where(sql`${chapterGroupHistory.chapterId} = ${body.chapter.id}`);
      expect(hist).toHaveLength(0);
    });

    it("creates chapter without groupId when groups disabled", async () => {
      asUser(owner, "o@example.com");
      const res = await call(zoneA.slug, "/api/tenant/chapters", {
        method: "POST",
        body: { name: `NoGrp ${unique()}` },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { chapter: { id: string; groupId: string | null } };
      expect(body.chapter.groupId).toBeNull();
    });

    it("returns 404 group_not_found for cross-zone groupId on create", async () => {
      asUser(owner, "o@example.com");
      const crossGid = await seedGroup(zoneB.id, "cross");
      const res = await call(zoneA.slug, "/api/tenant/chapters", {
        method: "POST",
        body: { name: `X ${unique()}`, groupId: crossGid },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });

    it("returns 400 group_required when groups enabled and groupId missing", async () => {
      // Set up a dedicated zone so we can enable groups without polluting zoneA.
      const z = await seedZone(`cge1-${unique()}`);
      cleanupSlugs.push(z.slug);
      await bindUser(owner, z.id, z.ownerRoleId, { scope: "zone" });
      // Pre-assign existing chapters to a group so enable can succeed.
      const g = await seedGroup(z.id, "boot");
      await seedChapter(z.id, g);
      await enableGroupsForZone(db, { zoneId: z.id, actorUserId: owner });

      asUser(owner, "o@example.com");
      const res = await call(z.slug, "/api/tenant/chapters", {
        method: "POST",
        body: { name: `Need ${unique()}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_required");
    });

    it("creates chapter with groupId when groups enabled and writes one history segment", async () => {
      const z = await seedZone(`cge2-${unique()}`);
      cleanupSlugs.push(z.slug);
      await bindUser(owner, z.id, z.ownerRoleId, { scope: "zone" });
      const g = await seedGroup(z.id, "boot");
      await seedChapter(z.id, g);
      await enableGroupsForZone(db, { zoneId: z.id, actorUserId: owner });

      asUser(owner, "o@example.com");
      const dateFrom = "2025-06-01";
      const res = await call(z.slug, "/api/tenant/chapters", {
        method: "POST",
        body: { name: `WithGrp ${unique()}`, groupId: g, dateFrom },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { chapter: { id: string; groupId: string } };
      expect(body.chapter.groupId).toBe(g);
      const hist = await db
        .select({
          groupId: chapterGroupHistory.groupId,
          dateFrom: chapterGroupHistory.dateFrom,
          dateTo: chapterGroupHistory.dateTo,
        })
        .from(chapterGroupHistory)
        .where(sql`${chapterGroupHistory.chapterId} = ${body.chapter.id}`);
      expect(hist).toHaveLength(1);
      expect(hist[0].groupId).toBe(g);
      expect(hist[0].dateFrom).toBe(dateFrom);
      expect(hist[0].dateTo).toBeNull();
    });

    it("returns 404 group_not_found for cross-zone groupId when groups enabled", async () => {
      const z = await seedZone(`cge3-${unique()}`);
      cleanupSlugs.push(z.slug);
      await bindUser(owner, z.id, z.ownerRoleId, { scope: "zone" });
      const g = await seedGroup(z.id, "boot");
      await seedChapter(z.id, g);
      await enableGroupsForZone(db, { zoneId: z.id, actorUserId: owner });
      const cross = await seedGroup(zoneB.id, "cross2");

      asUser(owner, "o@example.com");
      const res = await call(z.slug, "/api/tenant/chapters", {
        method: "POST",
        body: { name: `XEn ${unique()}`, groupId: cross },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });
  });

  describe("PATCH /chapters/:id — assign group", () => {
    it("zone_owner assigns groupId to chapter when groups disabled", async () => {
      asUser(owner, "o@example.com");
      const cid = await seedChapter(zoneA.id);
      const gid = await seedGroup(zoneA.id, "asgn");
      const res = await call(zoneA.slug, `/api/tenant/chapters/${cid}`, {
        method: "PATCH",
        body: { groupId: gid },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("assigned");
      const [row] = await db
        .select({ groupId: chapters.groupId })
        .from(chapters)
        .where(sql`${chapters.id} = ${cid}`);
      expect(row.groupId).toBe(gid);
      const hist = await db
        .select({ id: chapterGroupHistory.id })
        .from(chapterGroupHistory)
        .where(sql`${chapterGroupHistory.chapterId} = ${cid}`);
      expect(hist).toHaveLength(0);
    });

    it("zone_admin can assign", async () => {
      asUser(zoneAdmin, "z@example.com");
      const cid = await seedChapter(zoneA.id);
      const gid = await seedGroup(zoneA.id, "zadm");
      const res = await call(zoneA.slug, `/api/tenant/chapters/${cid}`, {
        method: "PATCH",
        body: { groupId: gid },
      });
      expect(res.status).toBe(200);
    });

    it("chapter_admin gets 403", async () => {
      const cid = await seedChapter(zoneA.id);
      await bindUser(chapterAdmin, zoneA.id, zoneA.chapterAdminRoleId, {
        scope: "chapter",
        chapterId: cid,
      });
      const gid = await seedGroup(zoneA.id, "chadm");
      asUser(chapterAdmin, "c@example.com");
      const res = await call(zoneA.slug, `/api/tenant/chapters/${cid}`, {
        method: "PATCH",
        body: { groupId: gid },
      });
      expect(res.status).toBe(403);
    });

    it("group_admin gets 403", async () => {
      const gid = await seedGroup(zoneA.id, "gadmr");
      await bindUser(groupAdmin, zoneA.id, zoneA.groupAdminRoleId, {
        scope: "group",
        groupId: gid,
      });
      const cid = await seedChapter(zoneA.id);
      asUser(groupAdmin, "g@example.com");
      const res = await call(zoneA.slug, `/api/tenant/chapters/${cid}`, {
        method: "PATCH",
        body: { groupId: gid },
      });
      expect(res.status).toBe(403);
    });

    it("returns 404 group_not_found for cross-zone groupId on patch", async () => {
      asUser(owner, "o@example.com");
      const cid = await seedChapter(zoneA.id);
      const cross = await seedGroup(zoneB.id, "cross3");
      const res = await call(zoneA.slug, `/api/tenant/chapters/${cid}`, {
        method: "PATCH",
        body: { groupId: cross },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });

    it("returns 404 chapter_not_found for cross-zone chapter id", async () => {
      asUser(owner, "o@example.com");
      const otherCid = await seedChapter(zoneB.id);
      const gid = await seedGroup(zoneA.id, "okgrp");
      const res = await call(zoneA.slug, `/api/tenant/chapters/${otherCid}`, {
        method: "PATCH",
        body: { groupId: gid },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("chapter_not_found");
    });

    it("returns 400 use_move_group when groups already enabled", async () => {
      const z = await seedZone(`cgp-${unique()}`);
      cleanupSlugs.push(z.slug);
      await bindUser(owner, z.id, z.ownerRoleId, { scope: "zone" });
      const g = await seedGroup(z.id, "boot");
      const cid = await seedChapter(z.id, g);
      await enableGroupsForZone(db, { zoneId: z.id, actorUserId: owner });
      const g2 = await seedGroup(z.id, "other");

      asUser(owner, "o@example.com");
      const res = await call(z.slug, `/api/tenant/chapters/${cid}`, {
        method: "PATCH",
        body: { groupId: g2 },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("use_move_group");
    });

    it("validates body — empty body returns 400", async () => {
      asUser(owner, "o@example.com");
      const cid = await seedChapter(zoneA.id);
      const res = await call(zoneA.slug, `/api/tenant/chapters/${cid}`, {
        method: "PATCH",
        body: {},
      });
      expect(res.status).toBe(400);
    });
  });
});
