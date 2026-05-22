// packages/api/src/routes/tenant-administrators-groups.test.ts
// Task 15 — GET /administrators now includes group bindings, and DELETE
// revokes group bindings just like zone/chapter ones.
// RELEVANT FILES: ./tenant.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "@stewardledger/shared";
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
      name: `Admins Zone ${unique()}`,
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

async function seedChapter(zoneId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name,
      dateFrom: new Date().toISOString().slice(0, 10),
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

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

const app = createApp();

async function call(slug: string, path: string, method = "GET"): Promise<Response> {
  return app.fetch(
    new Request(`http://${slug}.${HOST_DOMAIN}${path}`, {
      method,
      headers: { host: `${slug}.${HOST_DOMAIN}` },
    }),
  );
}

describe("administrators — group bindings", () => {
  let zone: SeededZone;
  let owner: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("this test requires a *_test DATABASE_URL");
    }
    zone = await seedZone(`adm-${unique()}`);
    cleanupSlugs.push(zone.slug);
    owner = await seedUser(`adm-owner+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await db.insert(userRoleBindings).values({
      userId: owner,
      zoneId: zone.id,
      roleId: zone.ownerRoleId,
      roleScope: "zone",
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

  it("GET /administrators includes group bindings with groupId/groupName/groupSlug", async () => {
    const user = await seedUser(`g-admin+${unique()}@example.com`);
    cleanupUserIds.push(user);
    const groupSlug = `grpa-${unique()}`;
    const groupName = `Group A ${unique()}`;
    const groupId = await seedGroup(zone.id, groupName, groupSlug);
    await db.insert(userRoleBindings).values({
      userId: user,
      zoneId: zone.id,
      groupId,
      roleId: zone.groupAdminRoleId,
      roleScope: "group",
    });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(owner, "o@x"));
    const res = await call(zone.slug, "/api/tenant/administrators");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        userId: string;
        roleCode: string;
        roleScope: string;
        chapterId: string | null;
        chapterName: string | null;
        groupId: string | null;
        groupName: string | null;
        groupSlug: string | null;
      }>;
    };
    const row = body.items.find((r) => r.userId === user && r.roleScope === "group");
    expect(row).toBeDefined();
    expect(row).toEqual(
      expect.objectContaining({
        roleCode: GROUP_ROLES.GROUP_ADMIN,
        roleScope: "group",
        groupId,
        groupName,
        groupSlug,
        chapterId: null,
        chapterName: null,
      }),
    );
  });

  it("orders rows by email, then scope (chapter, group, zone) lexically, then roleCode", async () => {
    const email = `multi+${unique()}@example.com`;
    const user = await seedUser(email);
    cleanupUserIds.push(user);
    const chapterId = await seedChapter(zone.id, `Ch ${unique()}`);
    const groupId = await seedGroup(zone.id, `G ${unique()}`, `g-${unique()}`);

    await db.insert(userRoleBindings).values([
      {
        userId: user,
        zoneId: zone.id,
        roleId: zone.zoneAdminRoleId,
        roleScope: "zone",
      },
      {
        userId: user,
        zoneId: zone.id,
        groupId,
        roleId: zone.groupAdminRoleId,
        roleScope: "group",
      },
      {
        userId: user,
        zoneId: zone.id,
        chapterId,
        roleId: zone.chapterAdminRoleId,
        roleScope: "chapter",
      },
    ]);

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(owner, "o@x"));
    const res = await call(zone.slug, "/api/tenant/administrators");
    const body = (await res.json()) as {
      items: Array<{ userId: string; roleScope: string }>;
    };
    const scopes = body.items.filter((r) => r.userId === user).map((r) => r.roleScope);
    expect(scopes).toEqual(["chapter", "group", "zone"]);
  });

  it("DELETE /administrators/:bindingId revokes a group binding", async () => {
    const user = await seedUser(`g-rev+${unique()}@example.com`);
    cleanupUserIds.push(user);
    const groupId = await seedGroup(zone.id, `Rev ${unique()}`, `rev-${unique()}`);
    const [binding] = await db
      .insert(userRoleBindings)
      .values({
        userId: user,
        zoneId: zone.id,
        groupId,
        roleId: zone.groupAdminRoleId,
        roleScope: "group",
      })
      .returning({ id: userRoleBindings.id });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(owner, "o@x"));
    const res = await call(zone.slug, `/api/tenant/administrators/${binding.id}`, "DELETE");
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ revokedAt: userRoleBindings.revokedAt })
      .from(userRoleBindings)
      .where(sql`${userRoleBindings.id} = ${binding.id}`);
    expect(row.revokedAt).toBeInstanceOf(Date);

    const auditRows = (await db.execute(
      sql`select action from audit_events where entity_id = ${binding.id} and action = 'administrator.role_binding.revoke'`,
    )) as unknown as { rows: Array<{ action: string }> } | Array<{ action: string }>;
    const list = Array.isArray(auditRows) ? auditRows : auditRows.rows;
    expect(list.length).toBeGreaterThan(0);
  });
});
