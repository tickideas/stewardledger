// packages/api/src/routes/tenant-zones.test.ts
// Phase 4 — tenant-zones router: groups-enabled toggle endpoint.
// Covers HTTP wiring, role gate (zone_owner only), and error translation.
// RELEVANT FILES: packages/api/src/routes/tenant-zones.ts, packages/api/src/services/groups.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHAPTER_ROLES,
  DEFAULT_RETENTION_POLICY,
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
import { seedZoneGivingSetup } from "../services/giving-setup-seed";
import { seedZonePeriods } from "../services/period-seed";
import { seedZoneRoles } from "../services/role-seed";
import { assignChapterToGroupPreEnable } from "../services/groups";

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
      name: `Zones Zone ${unique()}`,
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

describe("POST /api/tenant/zones/groups-enabled", () => {
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-zones.test.ts requires a *_test DATABASE_URL");
    }
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

  it("zone_owner enables when every chapter is assigned to a group", async () => {
    const zone = await seedZone(`zn-ok-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-ok+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    const g = await seedGroup(zone.id, `G ${unique()}`, `g-${unique()}`);
    const c1 = await seedChapter(zone.id, "Ch1");
    const c2 = await seedChapter(zone.id, "Ch2");
    await assignChapterToGroupPreEnable(db, {
      zoneId: zone.id,
      chapterId: c1,
      groupId: g,
      actorUserId: owner,
    });
    await assignChapterToGroupPreEnable(db, {
      zoneId: zone.id,
      chapterId: c2,
      groupId: g,
      actorUserId: owner,
    });

    asUser(owner, "owner@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("enabled");

    const [z] = await db
      .select({ groupsEnabled: zones.groupsEnabled })
      .from(zones)
      .where(sql`${zones.id} = ${zone.id}`)
      .limit(1);
    expect(z.groupsEnabled).toBe(true);

    const hist = await db
      .select({ chapterId: chapterGroupHistory.chapterId })
      .from(chapterGroupHistory)
      .where(sql`${chapterGroupHistory.zoneId} = ${zone.id}`);
    expect(hist.length).toBe(2);
  });

  it("returns 409 groups_enable_blocked when any chapter has null group_id", async () => {
    const zone = await seedZone(`zn-blk-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-blk+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    const g = await seedGroup(zone.id, `G ${unique()}`, `g-${unique()}`);
    const c1 = await seedChapter(zone.id, "Ch1");
    const c2 = await seedChapter(zone.id, "Ch2"); // left unassigned
    await assignChapterToGroupPreEnable(db, {
      zoneId: zone.id,
      chapterId: c1,
      groupId: g,
      actorUserId: owner,
    });

    asUser(owner, "owner@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: true },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { unassignedChapterIds: string[] } };
    };
    expect(body.error.code).toBe("groups_enable_blocked");
    expect(body.error.details?.unassignedChapterIds).toEqual([c2]);
  });

  it("is idempotent — returns 200 status:enabled when already enabled", async () => {
    const zone = await seedZone(`zn-idem-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-idem+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    const g = await seedGroup(zone.id, `G ${unique()}`, `g-${unique()}`);
    const c1 = await seedChapter(zone.id, "Ch1");
    await assignChapterToGroupPreEnable(db, {
      zoneId: zone.id,
      chapterId: c1,
      groupId: g,
      actorUserId: owner,
    });

    asUser(owner, "owner@example.com");
    const r1 = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: true },
    });
    expect(r1.status).toBe(200);
    const r2 = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: true },
    });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { status: string };
    expect(body.status).toBe("enabled");
  });

  it("zone_admin gets 403 (only zone_owner can flip)", async () => {
    const zone = await seedZone(`zn-za-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const u = await seedUser(`zn-za+${unique()}@example.com`);
    cleanupUserIds.push(u);
    await bindUser(u, zone.id, zone.zoneAdminRoleId, { scope: "zone" });
    asUser(u, "zadm@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: true },
    });
    expect(res.status).toBe(403);
  });

  it("group_admin gets 403", async () => {
    const zone = await seedZone(`zn-ga-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const u = await seedUser(`zn-ga+${unique()}@example.com`);
    cleanupUserIds.push(u);
    const g = await seedGroup(zone.id, `G ${unique()}`, `g-${unique()}`);
    await bindUser(u, zone.id, zone.groupAdminRoleId, { scope: "group", groupId: g });
    asUser(u, "gadm@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: true },
    });
    expect(res.status).toBe(403);
  });

  it("chapter_admin gets 403", async () => {
    const zone = await seedZone(`zn-ca-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const u = await seedUser(`zn-ca+${unique()}@example.com`);
    cleanupUserIds.push(u);
    const ch = await seedChapter(zone.id, "Ch1");
    await bindUser(u, zone.id, zone.chapterAdminRoleId, { scope: "chapter", chapterId: ch });
    asUser(u, "chadm@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: true },
    });
    expect(res.status).toBe(403);
  });

  it("rejects body { enabled: false } with 400", async () => {
    const zone = await seedZone(`zn-bf-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-bf+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    asUser(owner, "owner@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: { enabled: false },
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty body with 400", async () => {
    const zone = await seedZone(`zn-eb-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-eb+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    asUser(owner, "owner@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/groups-enabled", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("/api/tenant/zones/retention-policy", () => {
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-zones.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
      await db.execute(sql`delete from audit_events where zone_id = ${zoneIdSubq}`);
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

  it("GET returns hydrated defaults for a fresh zone", async () => {
    const zone = await seedZone(`zn-rp-get-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-rp-get+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    asUser(owner, "owner@example.com");

    const res = await call(zone.slug, "/api/tenant/zones/retention-policy");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policy: typeof DEFAULT_RETENTION_POLICY };
    expect(body.policy.audit_events.retainDays).toBe(
      DEFAULT_RETENTION_POLICY.audit_events.retainDays,
    );
    expect(body.policy.report_jobs.retainDays).toBe(
      DEFAULT_RETENTION_POLICY.report_jobs.retainDays,
    );
  });

  it("PUT as zone_owner writes the policy and audits the change", async () => {
    const zone = await seedZone(`zn-rp-put-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-rp-put+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    asUser(owner, "owner@example.com");

    const res = await call(zone.slug, "/api/tenant/zones/retention-policy", {
      method: "PUT",
      body: { audit_events: { retainDays: 365 } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policy: { audit_events: { retainDays: number } };
    };
    expect(body.policy.audit_events.retainDays).toBe(365);

    const [audit] = await db.execute<{ action: string }>(
      sql`select action from audit_events where zone_id = ${zone.id} and action = 'zone.retention_policy.update' limit 1`,
    );
    expect(audit?.action).toBe("zone.retention_policy.update");
  });

  it("PUT is a no-op when the policy matches the prior effective shape (no audit row)", async () => {
    const zone = await seedZone(`zn-rp-noop-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-rp-noop+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    asUser(owner, "owner@example.com");

    // Two identical writes — the second should not produce a second audit row.
    const body = { audit_events: { retainDays: 90 } };
    await call(zone.slug, "/api/tenant/zones/retention-policy", {
      method: "PUT",
      body,
    });
    await call(zone.slug, "/api/tenant/zones/retention-policy", {
      method: "PUT",
      body,
    });
    const auditCount = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from audit_events where zone_id = ${zone.id} and action = 'zone.retention_policy.update'`,
    );
    expect(Number(auditCount[0]?.count ?? 0)).toBe(1);
  });

  it("PUT as zone_admin returns 403 (owner-only write)", async () => {
    const zone = await seedZone(`zn-rp-403-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const u = await seedUser(`zn-rp-403+${unique()}@example.com`);
    cleanupUserIds.push(u);
    await bindUser(u, zone.id, zone.zoneAdminRoleId, { scope: "zone" });
    asUser(u, "zadm@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/retention-policy", {
      method: "PUT",
      body: { audit_events: { retainDays: 30 } },
    });
    expect(res.status).toBe(403);
  });

  it("PUT validates: retainDays cannot be negative", async () => {
    const zone = await seedZone(`zn-rp-bad-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`zn-rp-bad+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId, { scope: "zone" });
    asUser(owner, "owner@example.com");
    const res = await call(zone.slug, "/api/tenant/zones/retention-policy", {
      method: "PUT",
      body: { audit_events: { retainDays: -1 } },
    });
    expect(res.status).toBe(400);
  });
});
