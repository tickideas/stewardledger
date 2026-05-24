// packages/api/src/routes/tenant-groups.test.ts
// Phase 4 — tenant-scoped groups router: CRUD + move-group + group-history.
// Covers HTTP wiring, role gates, cross-zone safety, and zod rejection.
// RELEVANT FILES: packages/api/src/routes/tenant-groups.ts, packages/api/src/services/groups.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHAPTER_ROLES,
  GROUP_ROLES,
  ZONE_ROLES,
} from "@stewardledger/shared";
import {
  chapters,
  groups,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { seedZoneGivingSetup } from "../services/giving-setup-seed";
import { seedZonePeriods } from "../services/period-seed";
import { seedZoneRoles } from "../services/role-seed";
import { enableGroupsForZone } from "../services/groups";

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
      name: `Groups Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const seededRoles = await seedZoneRoles(db, zone.id);
  await seedZoneGivingSetup(db, zone.id, "GBP");
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });
  return {
    id: zone.id,
    slug: zone.slug,
    ownerRoleId: seededRoles.get(ZONE_ROLES.ZONE_OWNER)!,
    zoneAdminRoleId: seededRoles.get(ZONE_ROLES.ZONE_ADMIN)!,
    groupAdminRoleId: seededRoles.get(GROUP_ROLES.GROUP_ADMIN)!,
    chapterAdminRoleId: seededRoles.get(CHAPTER_ROLES.CHAPTER_ADMIN)!,
  };
}

async function seedChapter(
  zoneId: string,
  name: string,
  opts: { groupId?: string; dateFrom?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name,
      groupId: opts.groupId ?? null,
      dateFrom: opts.dateFrom ?? new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  return row.id;
}

async function seedGroup(zoneId: string, name: string, slug: string): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ zoneId, name, slug })
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

describe("tenant-groups router", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let ownerA: string;
  let zoneAdminA: string;
  let groupAdminA: string;
  let chapterAdminA: string;
  let chapterA1: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-groups.test.ts requires a *_test DATABASE_URL");
    }
    zoneA = await seedZone(`grp-a-${unique()}`);
    zoneB = await seedZone(`grp-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    chapterA1 = await seedChapter(zoneA.id, "Chapter A1");

    ownerA = await seedUser(`grp-owner+${unique()}@example.com`);
    zoneAdminA = await seedUser(`grp-zadm+${unique()}@example.com`);
    groupAdminA = await seedUser(`grp-gadm+${unique()}@example.com`);
    chapterAdminA = await seedUser(`grp-chadm+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, zoneAdminA, groupAdminA, chapterAdminA);

    await bindUser(ownerA, zoneA.id, zoneA.ownerRoleId, { scope: "zone" });
    await bindUser(zoneAdminA, zoneA.id, zoneA.zoneAdminRoleId, { scope: "zone" });
    await bindUser(chapterAdminA, zoneA.id, zoneA.chapterAdminRoleId, {
      scope: "chapter",
      chapterId: chapterA1,
    });
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

  // Bind group_admin lazily once we have a group to scope to.
  async function ensureGroupAdminBinding(groupId: string) {
    const [existing] = await db
      .select({ id: userRoleBindings.id })
      .from(userRoleBindings)
      .where(
        sql`${userRoleBindings.userId} = ${groupAdminA} and ${userRoleBindings.zoneId} = ${zoneA.id} and ${userRoleBindings.groupId} = ${groupId}`,
      )
      .limit(1);
    if (existing) return;
    await bindUser(groupAdminA, zoneA.id, zoneA.groupAdminRoleId, {
      scope: "group",
      groupId,
    });
  }

  describe("POST /api/tenant/groups", () => {
    it("zone_owner creates a group", async () => {
      asUser(ownerA, "owner@example.com");
      const res = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: `North ${unique()}`, slug: `north-${unique()}` },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { group: { id: string; slug: string; name: string } };
      expect(body.group.id).toBeTruthy();
      expect(body.group.slug).toMatch(/^north-/);
    });

    it("zone_admin creates a group", async () => {
      asUser(zoneAdminA, "zadm@example.com");
      const res = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: `South ${unique()}`, slug: `south-${unique()}` },
      });
      expect(res.status).toBe(201);
    });

    it("group_admin gets 403 on create", async () => {
      // Use a freshly-seeded group to bind group_admin to.
      const gid = await seedGroup(zoneA.id, `Tmp ${unique()}`, `tmp-${unique()}`);
      await ensureGroupAdminBinding(gid);
      asUser(groupAdminA, "gadm@example.com");
      const res = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: `X ${unique()}`, slug: `x-${unique()}` },
      });
      expect(res.status).toBe(403);
    });

    it("chapter_admin gets 403 on create", async () => {
      asUser(chapterAdminA, "chadm@example.com");
      const res = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: `Y ${unique()}`, slug: `y-${unique()}` },
      });
      expect(res.status).toBe(403);
    });

    it("rejects invalid slug", async () => {
      asUser(ownerA, "owner@example.com");
      const res = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: "Bad", slug: "BAD_SLUG" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 on duplicate name", async () => {
      asUser(ownerA, "owner@example.com");
      const name = `Dup ${unique()}`;
      const r1 = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name, slug: `dup-${unique()}` },
      });
      expect(r1.status).toBe(201);
      const r2 = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name, slug: `dup-${unique()}` },
      });
      expect(r2.status).toBe(409);
      const body = (await r2.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_name_taken");
    });

    it("returns 409 on duplicate slug", async () => {
      asUser(ownerA, "owner@example.com");
      const slug = `dups-${unique()}`;
      const r1 = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: `S1 ${unique()}`, slug },
      });
      expect(r1.status).toBe(201);
      const r2 = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: `S2 ${unique()}`, slug },
      });
      expect(r2.status).toBe(409);
      const body = (await r2.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_slug_taken");
    });
  });

  describe("GET /api/tenant/groups", () => {
    it("lists groups in the zone", async () => {
      asUser(ownerA, "owner@example.com");
      const slug = `list-${unique()}`;
      const created = await call(zoneA.slug, "/api/tenant/groups", {
        method: "POST",
        body: { name: `List ${unique()}`, slug },
      });
      const { group } = (await created.json()) as { group: { id: string } };

      const res = await call(zoneA.slug, "/api/tenant/groups");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string; slug: string; chapterCount: number }>;
      };
      const found = body.items.find((g) => g.id === group.id);
      expect(found).toBeTruthy();
      expect(found?.slug).toBe(slug);
      expect(typeof found?.chapterCount).toBe("number");
    });

    it("excludes soft-deleted groups", async () => {
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneA.id, `Del ${unique()}`, `del-${unique()}`);
      const del = await call(zoneA.slug, `/api/tenant/groups/${gid}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      const res = await call(zoneA.slug, "/api/tenant/groups");
      const body = (await res.json()) as { items: Array<{ id: string }> };
      expect(body.items.some((g) => g.id === gid)).toBe(false);
    });

    it("group_admin sees only their bound group(s)", async () => {
      const mine = await seedGroup(zoneA.id, `Mine ${unique()}`, `mine-${unique()}`);
      const other = await seedGroup(zoneA.id, `Other ${unique()}`, `other-${unique()}`);
      await ensureGroupAdminBinding(mine);
      asUser(groupAdminA, "gadm@example.com");
      const res = await call(zoneA.slug, "/api/tenant/groups");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      const ids = body.items.map((g) => g.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(other);
    });

    it("chapter_admin without any group binding sees empty list", async () => {
      await seedGroup(zoneA.id, `Foo ${unique()}`, `foo-${unique()}`);
      asUser(chapterAdminA, "chadm@example.com");
      const res = await call(zoneA.slug, "/api/tenant/groups");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; total: number };
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("filters by q (name or slug, case-insensitive)", async () => {
      asUser(ownerA, "owner@example.com");
      // Two groups: one with a unique slug, one with a unique name. The
      // search should hit each by the right needle without bleeding into
      // the other zone's seed data. (Cleaned up by the suite-level
      // afterAll — `delete from groups where zone_id = ...`.)
      const matchSlug = `match-slug-${unique()}`;
      const matchName = `Match Name ${unique()}`;
      const byName = await seedGroup(zoneA.id, matchName, `other-${unique()}`);
      const bySlug = await seedGroup(zoneA.id, `Other ${unique()}`, matchSlug);

      const slugRes = await call(zoneA.slug, `/api/tenant/groups?q=${matchSlug}`);
      const slugBody = (await slugRes.json()) as { items: Array<{ id: string }> };
      expect(slugBody.items.map((g) => g.id)).toEqual([bySlug]);

      const nameRes = await call(zoneA.slug, `/api/tenant/groups?q=${encodeURIComponent(matchName.toLowerCase())}`);
      const nameBody = (await nameRes.json()) as { items: Array<{ id: string }> };
      expect(nameBody.items.map((g) => g.id)).toEqual([byName]);
    });

    it("paginates with limit + offset and reports total", async () => {
      asUser(ownerA, "owner@example.com");
      // Seed four groups in zone A so two-per-page pagination meaningfully
      // splits them; assert total counts every group in the zone.
      // (Cleaned up by the suite-level afterAll.)
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        ids.push(
          await seedGroup(zoneA.id, `Page ${i} ${unique()}`, `page-${i}-${unique()}`),
        );
      }
      const page1 = await call(zoneA.slug, "/api/tenant/groups?limit=2&offset=0");
      const page1Body = (await page1.json()) as {
        items: Array<{ id: string }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(page1Body.items.length).toBe(2);
      expect(page1Body.limit).toBe(2);
      expect(page1Body.offset).toBe(0);
      expect(page1Body.total).toBeGreaterThanOrEqual(ids.length);

      const page2 = await call(zoneA.slug, "/api/tenant/groups?limit=2&offset=2");
      const page2Body = (await page2.json()) as { items: Array<{ id: string }> };
      const overlap = page1Body.items.filter((p1) =>
        page2Body.items.some((p2) => p2.id === p1.id),
      );
      expect(overlap).toEqual([]);
    });

    it("with no limit returns every row the caller can see", async () => {
      // Regression test for the silent-truncation risk in the original
      // PR #54 review — picker call sites (chapter→group dropdowns,
      // contributions filter, batches) call /groups without a limit and
      // expect every row in scope.
      asUser(ownerA, "owner@example.com");
      // Make sure there's a baseline of rows in the zone before we ask.
      await seedGroup(zoneA.id, `Cap ${unique()}`, `cap-${unique()}`);
      const res = await call(zoneA.slug, "/api/tenant/groups");
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        total: number;
        limit: number | undefined;
      };
      expect(body.limit).toBeUndefined();
      expect(body.items.length).toBe(body.total);
    });

    it("escapes SQL LIKE wildcards in the q needle", async () => {
      // A slug containing an underscore should only match that literal
      // slug, not the underscore-as-wildcard interpretation.
      asUser(ownerA, "owner@example.com");
      const literalSlug = `north_${unique()}`;
      const wildCandidate = literalSlug.replace(/_/g, "x");
      const literal = await seedGroup(zoneA.id, `Literal ${unique()}`, literalSlug);
      const decoy = await seedGroup(zoneA.id, `Decoy ${unique()}`, wildCandidate);
      const res = await call(zoneA.slug, `/api/tenant/groups?q=${encodeURIComponent(literalSlug)}`);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      const ids = body.items.map((g) => g.id);
      expect(ids).toContain(literal);
      expect(ids).not.toContain(decoy);
    });
  });

  describe("GET /api/tenant/groups/:id", () => {
    it("returns group detail with chapterCount", async () => {
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneA.id, `Detail ${unique()}`, `detail-${unique()}`);
      const res = await call(zoneA.slug, `/api/tenant/groups/${gid}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { group: { id: string; chapterCount: number } };
      expect(body.group.id).toBe(gid);
      expect(body.group.chapterCount).toBe(0);
    });

    it("404 for cross-zone group id", async () => {
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneB.id, `B ${unique()}`, `b-${unique()}`);
      const res = await call(zoneA.slug, `/api/tenant/groups/${gid}`);
      expect(res.status).toBe(404);
    });

    it("group_admin gets 404 for a group they're not bound to", async () => {
      const mine = await seedGroup(zoneA.id, `MineD ${unique()}`, `mined-${unique()}`);
      const other = await seedGroup(zoneA.id, `OtherD ${unique()}`, `otherd-${unique()}`);
      await ensureGroupAdminBinding(mine);
      asUser(groupAdminA, "gadm@example.com");
      const res = await call(zoneA.slug, `/api/tenant/groups/${other}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/tenant/groups/:id", () => {
    it("renames a group", async () => {
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneA.id, `Ren ${unique()}`, `ren-${unique()}`);
      const newName = `Renamed ${unique()}`;
      const res = await call(zoneA.slug, `/api/tenant/groups/${gid}`, {
        method: "PATCH",
        body: { name: newName },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { group: { name: string } };
      expect(body.group.name).toBe(newName);
    });

    it("returns 409 on duplicate name (excluding self)", async () => {
      asUser(ownerA, "owner@example.com");
      const nameA = `DupA ${unique()}`;
      const g1 = await seedGroup(zoneA.id, nameA, `dupa-${unique()}`);
      const g2 = await seedGroup(zoneA.id, `DupB ${unique()}`, `dupb-${unique()}`);
      // Renaming g1 to its own name is fine (no-op).
      const self = await call(zoneA.slug, `/api/tenant/groups/${g1}`, {
        method: "PATCH",
        body: { name: nameA },
      });
      expect(self.status).toBe(200);
      // Renaming g2 to g1's name conflicts.
      const conflict = await call(zoneA.slug, `/api/tenant/groups/${g2}`, {
        method: "PATCH",
        body: { name: nameA },
      });
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_name_taken");
    });

    it("group_admin gets 403", async () => {
      const gid = await seedGroup(zoneA.id, `GA ${unique()}`, `ga-${unique()}`);
      await ensureGroupAdminBinding(gid);
      asUser(groupAdminA, "gadm@example.com");
      const res = await call(zoneA.slug, `/api/tenant/groups/${gid}`, {
        method: "PATCH",
        body: { name: `Nope ${unique()}` },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/tenant/groups/:id", () => {
    it("soft-deletes an empty group", async () => {
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneA.id, `Empty ${unique()}`, `empty-${unique()}`);
      const res = await call(zoneA.slug, `/api/tenant/groups/${gid}`, { method: "DELETE" });
      expect(res.status).toBe(200);
    });

    it("404 for cross-zone group id on delete", async () => {
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneB.id, `XZ ${unique()}`, `xz-${unique()}`);
      const res = await call(zoneA.slug, `/api/tenant/groups/${gid}`, { method: "DELETE" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });

    it("404 for non-existent group id on delete", async () => {
      asUser(ownerA, "owner@example.com");
      const res = await call(
        zoneA.slug,
        `/api/tenant/groups/00000000-0000-0000-0000-000000000000`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });

    it("returns 409 when group has chapters", async () => {
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneA.id, `Full ${unique()}`, `full-${unique()}`);
      await seedChapter(zoneA.id, `Ch ${unique()}`, { groupId: gid });
      const res = await call(zoneA.slug, `/api/tenant/groups/${gid}`, { method: "DELETE" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; details?: { chapterCount: number } };
      };
      expect(body.error.code).toBe("group_not_empty");
      expect(body.error.details?.chapterCount).toBe(1);
    });
  });

  describe("POST /api/tenant/chapters/:id/move-group", () => {
    // Build an isolated zone that has been "enabled" so post-enable
    // semantics apply. Avoids contaminating shared state for other tests.
    let moveZone: SeededZone;
    let moveOwner: string;
    let moveAdmin: string;
    let moveChapter: string;
    let groupOld: string;
    let groupNew: string;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    beforeAll(async () => {
      moveZone = await seedZone(`grp-mv-${unique()}`);
      cleanupSlugs.push(moveZone.slug);
      moveOwner = await seedUser(`grp-mvo+${unique()}@example.com`);
      moveAdmin = await seedUser(`grp-mvchadm+${unique()}@example.com`);
      cleanupUserIds.push(moveOwner, moveAdmin);
      await bindUser(moveOwner, moveZone.id, moveZone.ownerRoleId, { scope: "zone" });

      groupOld = await seedGroup(moveZone.id, `Old ${unique()}`, `old-${unique()}`);
      groupNew = await seedGroup(moveZone.id, `New ${unique()}`, `new-${unique()}`);
      moveChapter = await seedChapter(moveZone.id, "MoveCh", {
        groupId: groupOld,
        dateFrom: yesterday,
      });
      await bindUser(moveAdmin, moveZone.id, moveZone.chapterAdminRoleId, {
        scope: "chapter",
        chapterId: moveChapter,
      });
      await enableGroupsForZone(db, { zoneId: moveZone.id, actorUserId: moveOwner });
    });

    it("moves a chapter and writes history (post-enable)", async () => {
      asUser(moveOwner, "mvo@example.com");
      const today = new Date().toISOString().slice(0, 10);
      const res = await call(
        moveZone.slug,
        `/api/tenant/chapters/${moveChapter}/move-group`,
        { method: "POST", body: { groupId: groupNew, effectiveDate: today } },
      );
      expect(res.status).toBe(200);
      const [chap] = await db
        .select({ groupId: chapters.groupId })
        .from(chapters)
        .where(sql`${chapters.id} = ${moveChapter}`)
        .limit(1);
      expect(chap.groupId).toBe(groupNew);

      const histRes = await call(
        moveZone.slug,
        `/api/tenant/chapters/${moveChapter}/group-history`,
      );
      const hist = (await histRes.json()) as { items: unknown[] };
      expect(hist.items.length).toBe(2);
    });

    it("403 when chapter_admin tries to move", async () => {
      asUser(moveAdmin, "mvchadm@example.com");
      const res = await call(
        moveZone.slug,
        `/api/tenant/chapters/${moveChapter}/move-group`,
        { method: "POST", body: { groupId: groupOld } },
      );
      expect(res.status).toBe(403);
    });

    it("404 for cross-zone group on move", async () => {
      asUser(moveOwner, "mvo@example.com");
      const crossGroup = await seedGroup(zoneB.id, `Cross ${unique()}`, `cross-${unique()}`);
      const res = await call(
        moveZone.slug,
        `/api/tenant/chapters/${moveChapter}/move-group`,
        { method: "POST", body: { groupId: crossGroup } },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("group_not_found");
    });

    it("400 when backdating before current segment", async () => {
      asUser(moveOwner, "mvo@example.com");
      // The current open segment was opened "today" by the previous test's
      // move; backdate to yesterday to trigger history_violation.
      const res = await call(
        moveZone.slug,
        `/api/tenant/chapters/${moveChapter}/move-group`,
        { method: "POST", body: { groupId: groupOld, effectiveDate: "2000-01-01" } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("history_violation");
    });

    it("409 when groups not enabled", async () => {
      // zoneA's groups are NOT enabled. Build a chapter with a group_id
      // there and attempt a move — service should refuse.
      asUser(ownerA, "owner@example.com");
      const gid = await seedGroup(zoneA.id, `NE ${unique()}`, `ne-${unique()}`);
      const ch = await seedChapter(zoneA.id, `NE ${unique()}`, { groupId: gid });
      const gid2 = await seedGroup(zoneA.id, `NE2 ${unique()}`, `ne2-${unique()}`);
      const res = await call(
        zoneA.slug,
        `/api/tenant/chapters/${ch}/move-group`,
        { method: "POST", body: { groupId: gid2 } },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("groups_not_enabled");
    });
  });

  describe("GET /api/tenant/chapters/:id/group-history", () => {
    let histZone: SeededZone;
    let histOwner: string;
    let histChapter: string;
    let histOtherChapter: string;
    let histGroupAdmin: string;

    beforeAll(async () => {
      histZone = await seedZone(`grp-hist-${unique()}`);
      cleanupSlugs.push(histZone.slug);
      histOwner = await seedUser(`grp-hist+${unique()}@example.com`);
      histGroupAdmin = await seedUser(`grp-hist-group+${unique()}@example.com`);
      cleanupUserIds.push(histOwner, histGroupAdmin);
      await bindUser(histOwner, histZone.id, histZone.ownerRoleId, { scope: "zone" });

      const g1 = await seedGroup(histZone.id, `H1 ${unique()}`, `h1-${unique()}`);
      const g2 = await seedGroup(histZone.id, `H2 ${unique()}`, `h2-${unique()}`);
      await bindUser(histGroupAdmin, histZone.id, histZone.groupAdminRoleId, { scope: "group", groupId: g1 });
      histChapter = await seedChapter(histZone.id, "HistCh", {
        groupId: g1,
        dateFrom: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      });
      histOtherChapter = await seedChapter(histZone.id, "HistOther", {
        groupId: g2,
        dateFrom: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      });
      await enableGroupsForZone(db, { zoneId: histZone.id, actorUserId: histOwner });
      const today = new Date().toISOString().slice(0, 10);
      // perform a move via service (router tested elsewhere)
      const { moveChapterToGroup } = await import("../services/groups");
      await moveChapterToGroup(db, {
        zoneId: histZone.id,
        chapterId: histChapter,
        newGroupId: g2,
        effectiveDate: today,
        actorUserId: histOwner,
      });
    });

    it("returns segments ordered by date_from", async () => {
      asUser(histOwner, "hist@example.com");
      const res = await call(
        histZone.slug,
        `/api/tenant/chapters/${histChapter}/group-history`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ dateFrom: string; dateTo: string | null }>;
      };
      expect(body.items.length).toBe(2);
      expect(body.items[0].dateFrom <= body.items[1].dateFrom).toBe(true);
      expect(body.items[1].dateTo).toBeNull();
    });

    it("group admins cannot read another group's chapter history", async () => {
      asUser(histGroupAdmin, "hist-group@example.com");
      const res = await call(
        histZone.slug,
        `/api/tenant/chapters/${histOtherChapter}/group-history`,
      );
      expect(res.status).toBe(403);
    });

    it("404 for cross-zone chapter id", async () => {
      asUser(ownerA, "owner@example.com");
      const res = await call(
        zoneA.slug,
        `/api/tenant/chapters/${histChapter}/group-history`,
      );
      expect(res.status).toBe(404);
    });
  });
});
