// packages/api/src/routes/tenant.test.ts
// Cross-tenant fuzz tests for the Phase 2 tenant routes. We stand up two real
// zones in the test DB, then drive the Hono app via `app.fetch`, faking
// Better Auth sessions with `vi.spyOn(auth.api, "getSession")`. Every test
// asserts that user-A bound to zone-A cannot read or mutate zone-B \u2014 either
// directly (Host=zone-B with no binding) or transitively (Host=zone-A but
// crafting a request that references zone-B's chapter or invitation id).

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  chapters,
  invitations,
  roles,
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

const HOST_DOMAIN = "localhost"; // matches PUBLIC_TENANT_DOMAIN in .env.test

interface SeededZone {
  id: string;
  slug: string;
  name: string;
  ownerRoleId: string;
  chapterAdminRoleId: string;
}

async function seedZone(slug: string, name: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug, name: zones.name });
  const seeded = await seedZoneRoles(db, zone.id);
  return {
    id: zone.id,
    slug: zone.slug,
    name: zone.name,
    ownerRoleId: seeded.get(ZONE_ROLES.ZONE_OWNER)!,
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

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

const app = createApp();

function tenantUrl(slug: string, path: string): string {
  return `http://${slug}.${HOST_DOMAIN}${path}`;
}

interface FetchOptions {
  method?: string;
  body?: unknown;
}

async function call(slug: string, path: string, opts: FetchOptions = {}): Promise<Response> {
  return app.fetch(
    new Request(tenantUrl(slug, path), {
      method: opts.method ?? "GET",
      headers: opts.body
        ? { "content-type": "application/json", host: `${slug}.${HOST_DOMAIN}` }
        : { host: `${slug}.${HOST_DOMAIN}` },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

describe("tenant routes — cross-tenant fuzz", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let userA: string;
  let userBOwner: string;
  let chapterA: string;
  let chapterB: string;
  let invA: string; // an open invitation in zone A
  let invB: string; // an open invitation in zone B
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    zoneA = await seedZone(`a-${unique()}`, `Zone A ${unique()}`);
    zoneB = await seedZone(`b-${unique()}`, `Zone B ${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    userA = await seedUser(`user-a+${unique()}@example.com`);
    userBOwner = await seedUser(`user-b+${unique()}@example.com`);
    cleanupUserIds.push(userA, userBOwner);

    // Bind user A as owner of zone A.
    await db.insert(userRoleBindings).values({
      userId: userA,
      zoneId: zoneA.id,
      roleId: zoneA.ownerRoleId,
    });
    // Bind userBOwner as owner of zone B (so we can verify zone B has its own data).
    await db.insert(userRoleBindings).values({
      userId: userBOwner,
      zoneId: zoneB.id,
      roleId: zoneB.ownerRoleId,
    });

    chapterA = await seedChapter(zoneA.id, "Chapter A");
    chapterB = await seedChapter(zoneB.id, "Chapter B");

    const [invARow] = await db
      .insert(invitations)
      .values({
        zoneId: zoneA.id,
        email: `invitee-a+${unique()}@example.com`,
        roleCode: ZONE_ROLES.ZONE_ADMIN,
        tokenHash: `hash-a-${unique()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: invitations.id });
    invA = invARow.id;

    const [invBRow] = await db
      .insert(invitations)
      .values({
        zoneId: zoneB.id,
        email: `invitee-b+${unique()}@example.com`,
        roleCode: ZONE_ROLES.ZONE_ADMIN,
        tokenHash: `hash-b-${unique()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: invitations.id });
    invB = invBRow.id;
  });

  afterAll(async () => {
    // chapters.zone_id is ON DELETE RESTRICT — clear chapters first.
    for (const slug of cleanupSlugs) {
      await db.execute(
        sql`delete from chapters where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Listing isolation ──────────────────────────────────────────────

  it("GET /chapters from zone A only returns zone A's chapters", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/chapters");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; name: string }> };
    expect(body.items.map((c) => c.id)).toContain(chapterA);
    expect(body.items.map((c) => c.id)).not.toContain(chapterB);
  });

  it("GET /invitations from zone A only returns zone A's invitations", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/invitations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(invA);
    expect(body.items.map((i) => i.id)).not.toContain(invB);
  });

  // ─── Forbidden zone access ──────────────────────────────────────────

  it("user A cannot read zone B (Host=zone B without a binding) → 403", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneB.slug, "/api/tenant/chapters");
    expect(res.status).toBe(403);
  });

  it("an unbound user is rejected from any tenant route → 403", async () => {
    const orphan = await seedUser(`orphan+${unique()}@example.com`);
    cleanupUserIds.push(orphan);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(orphan, "o@x"));
    const res = await call(zoneA.slug, "/api/tenant/me");
    expect(res.status).toBe(403);
  });

  it("missing session → 401", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);
    const res = await call(zoneA.slug, "/api/tenant/me");
    expect(res.status).toBe(401);
  });

  // ─── Cross-tenant id smuggling ──────────────────────────────────────

  it("POST /invitations with another zone's chapter_id → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/invitations", {
      method: "POST",
      body: {
        email: `x+${unique()}@example.com`,
        roleCode: CHAPTER_ROLES.CHAPTER_TREASURER,
        chapterId: chapterB, // chapter belongs to zone B
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("POST /invitations/:id/revoke against another zone's invitation → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/invitations/${invB}/revoke`, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(404);
    // And the target invitation in zone B is still open.
    const [stillOpen] = await db
      .select({ revokedAt: invitations.revokedAt })
      .from(invitations)
      .where(sql`${invitations.id} = ${invB}`);
    expect(stillOpen.revokedAt).toBeNull();
  });

  // ─── Role/payload validation ────────────────────────────────────────

  it("POST /invitations with role_code=zone_owner → 400", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/invitations", {
      method: "POST",
      body: {
        email: `x+${unique()}@example.com`,
        roleCode: ZONE_ROLES.ZONE_OWNER,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("owner_invite_forbidden");
  });

  it("POST /invitations with chapter role and no chapter_id → 400 (zod)", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/invitations", {
      method: "POST",
      body: {
        email: `x+${unique()}@example.com`,
        roleCode: CHAPTER_ROLES.CHAPTER_TREASURER,
      },
    });
    expect(res.status).toBe(400);
  });

  it("POST /invitations with zone role and a chapter_id → 400 (zod)", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/invitations", {
      method: "POST",
      body: {
        email: `x+${unique()}@example.com`,
        roleCode: ZONE_ROLES.ZONE_ADMIN,
        chapterId: chapterA,
      },
    });
    expect(res.status).toBe(400);
  });

  // ─── /me ───────────────────────────────────────────────────────────

  it("GET /me returns the resolved zone and the user's role codes", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      zone: { id: string; slug: string };
      auth: { roleCodes: string[]; zoneId: string; chapterIds: string[] };
    };
    expect(body.zone.id).toBe(zoneA.id);
    expect(body.auth.zoneId).toBe(zoneA.id);
    expect(body.auth.roleCodes).toContain(ZONE_ROLES.ZONE_OWNER);
    expect(body.auth.chapterIds).toEqual([]);
  });

  // ─── Lockdown: roles table is also tenant-scoped ────────────────────

  it("zone A's seeded roles are not visible to zone B via the ORM filter pattern", async () => {
    const aRoles = await db
      .select({ code: roles.code })
      .from(roles)
      .where(sql`${roles.zoneId} = ${zoneA.id}`);
    const bRoles = await db
      .select({ code: roles.code })
      .from(roles)
      .where(sql`${roles.zoneId} = ${zoneB.id}`);
    expect(aRoles.length).toBe(9);
    expect(bRoles.length).toBe(9);
    // Same role codes, different ids.
    expect(new Set(aRoles.map((r) => r.code))).toEqual(new Set(bRoles.map((r) => r.code)));
  });
});
