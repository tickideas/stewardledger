// packages/api/src/routes/tenant.test.ts
// Cross-tenant fuzz tests for the Phase 2 tenant routes. We stand up two real
// zones in the test DB, then drive the Hono app via `app.fetch`, faking
// Better Auth sessions with `vi.spyOn(auth.api, "getSession")`. Every test
// asserts that user-A bound to zone-A cannot read or mutate zone-B \u2014 either
// directly (Host=zone-B with no binding) or transitively (Host=zone-A but
// crafting a request that references zone-B's chapter or invitation id).
// RELEVANT FILES: ../middleware/tenant.ts, ../middleware/auth.ts, ./tenant.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  chapters,
  invitations,
  members,
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
  chapterTreasurerRoleId: string;
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
    chapterTreasurerRoleId: seeded.get(CHAPTER_ROLES.CHAPTER_TREASURER)!,
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

async function callApiHostWithZoneHeader(
  slug: string,
  path: string,
  opts: FetchOptions = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://${HOST_DOMAIN}:3000${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body ? { "content-type": "application/json" } : {}),
        host: `${HOST_DOMAIN}:3000`,
        "x-stewardledger-zone-slug": slug,
      },
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
        sql`delete from members where zone_id = (select id from zones where slug = ${slug})`,
      );
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
    await db.insert(members).values([
      {
        zoneId: zoneA.id,
        referenceCode: `M${unique()}`,
        firstName: "Active",
        lastName: "Member",
        chapterId: chapterA,
      },
      {
        zoneId: zoneA.id,
        referenceCode: `M${unique()}`,
        firstName: "Inactive",
        lastName: "Member",
        chapterId: chapterA,
        isActive: false,
      },
    ]);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/chapters");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; name: string; activeMemberCount: number }>;
    };
    expect(body.items.map((c) => c.id)).toContain(chapterA);
    expect(body.items.map((c) => c.id)).not.toContain(chapterB);
    expect(body.items.find((c) => c.id === chapterA)?.activeMemberCount).toBeGreaterThanOrEqual(1);
  });

  it("GET /chapters resolves the tenant from the split API host zone header", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await callApiHostWithZoneHeader(zoneA.slug, "/api/tenant/chapters");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; name: string }> };
    expect(body.items.map((c) => c.id)).toContain(chapterA);
    expect(body.items.map((c) => c.id)).not.toContain(chapterB);
  });

  it("does not resolve a soft-deleted zone as a tenant", async () => {
    const removed = await seedZone(`removed-${unique()}`, `Removed Zone ${unique()}`);
    cleanupSlugs.push(removed.slug);
    await db
      .update(zones)
      .set({ deletedAt: new Date() })
      .where(sql`${zones.id} = ${removed.id}`);

    const res = await call(removed.slug, "/api/tenant/me");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("tenant_not_found");

    const viaApiHost = await callApiHostWithZoneHeader(removed.slug, "/api/tenant/me");
    expect(viaApiHost.status).toBe(404);
  });

  it("GET /invitations from zone A only returns zone A's invitations", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/invitations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(invA);
    expect(body.items.map((i) => i.id)).not.toContain(invB);
  });

  it("GET /administrators returns active bindings for this zone only", async () => {
    const chapterAdmin = await seedUser(`admin-roster+${unique()}@example.com`);
    cleanupUserIds.push(chapterAdmin);
    await db.insert(userRoleBindings).values({
      userId: chapterAdmin,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterAdminRoleId,
    });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/administrators");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ userId: string; roleCode: string; chapterId: string | null }>;
    };
    expect(body.items).toContainEqual(
      expect.objectContaining({
        userId: userA,
        roleCode: ZONE_ROLES.ZONE_OWNER,
        chapterId: null,
      }),
    );
    expect(body.items).toContainEqual(
      expect.objectContaining({
        userId: chapterAdmin,
        roleCode: CHAPTER_ROLES.CHAPTER_ADMIN,
        chapterId: chapterA,
      }),
    );
    expect(body.items.some((item) => item.userId === userBOwner)).toBe(false);
  });

  it("DELETE /administrators/:bindingId revokes in-zone binding and rejects self-lockout", async () => {
    const chapterAdmin = await seedUser(`admin-revoke+${unique()}@example.com`);
    const zoneAdmin = await seedUser(`zone-admin-revoke+${unique()}@example.com`);
    cleanupUserIds.push(chapterAdmin);
    cleanupUserIds.push(zoneAdmin);
    const [binding] = await db
      .insert(userRoleBindings)
      .values({
        userId: chapterAdmin,
        zoneId: zoneA.id,
        chapterId: chapterA,
        roleId: zoneA.chapterAdminRoleId,
      })
      .returning({ id: userRoleBindings.id });
    const [zoneAdminRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(sql`${roles.zoneId} = ${zoneA.id} and ${roles.code} = ${ZONE_ROLES.ZONE_ADMIN}`)
      .limit(1);
    await db.insert(userRoleBindings).values({
      userId: zoneAdmin,
      zoneId: zoneA.id,
      roleId: zoneAdminRole.id,
    });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const revoked = await call(zoneA.slug, `/api/tenant/administrators/${binding.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    const [row] = await db
      .select({ revokedAt: userRoleBindings.revokedAt })
      .from(userRoleBindings)
      .where(sql`${userRoleBindings.id} = ${binding.id}`);
    expect(row.revokedAt).toBeInstanceOf(Date);

    const [ownBinding] = await db
      .select({ id: userRoleBindings.id })
      .from(userRoleBindings)
      .where(
        sql`${userRoleBindings.userId} = ${userA} and ${userRoleBindings.zoneId} = ${zoneA.id} and ${userRoleBindings.roleId} = ${zoneA.ownerRoleId} and ${userRoleBindings.revokedAt} is null`,
      )
      .limit(1);
    const self = await call(zoneA.slug, `/api/tenant/administrators/${ownBinding.id}`, {
      method: "DELETE",
    });
    expect(self.status).toBe(409);

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(zoneAdmin, "za@x"));
    const soleOwner = await call(zoneA.slug, `/api/tenant/administrators/${ownBinding.id}`, {
      method: "DELETE",
    });
    expect(soleOwner.status).toBe(409);
    const soleOwnerBody = (await soleOwner.json()) as { error: { code: string } };
    expect(soleOwnerBody.error.code).toBe("sole_owner");
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

  it("GET /chapters/:id with another zone's chapter id → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/chapters/${chapterB}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

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

  // ─── Chapter settings: banking + roster + chapter-admin invites ───

  it("GET /chapters/:id returns banking defaults for fresh chapters", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chapter: {
        id: string;
        banking: { primaryCurrency: string | null; references: unknown[] };
        profile: { pastorName: string | null; address: { line1: string | null } };
      };
    };
    expect(body.chapter.id).toBe(chapterA);
    expect(body.chapter.banking.primaryCurrency).toBeNull();
    expect(body.chapter.banking.references).toEqual([]);
    expect(body.chapter.profile.pastorName).toBeNull();
    expect(body.chapter.profile.address.line1).toBeNull();
  });

  it("PATCH /chapters/:id/banking persists references + currency; GET reads them back", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const patch = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/banking`, {
      method: "PATCH",
      body: {
        primaryCurrency: "GBP",
        references: [
          { label: "Main current", value: "12-34-56 / 12345678" },
          { label: "Online giving", value: "stripe:acct_abc", note: "clears T+2" },
        ],
      },
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as { banking: { references: { label: string }[] } };
    expect(patchBody.banking.references.map((r) => r.label)).toEqual(["Main current", "Online giving"]);

    const get = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}`);
    const getBody = (await get.json()) as {
      chapter: { banking: { primaryCurrency: string | null; references: { label: string }[] } };
    };
    expect(getBody.chapter.banking.primaryCurrency).toBe("GBP");
    expect(getBody.chapter.banking.references).toHaveLength(2);
  });

  it("PATCH /chapters/:id/banking against another zone's chapter → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/chapters/${chapterB}/banking`, {
      method: "PATCH",
      body: { primaryCurrency: "USD" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("PATCH /chapters/:id/profile persists address, pastor, and contact details", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const patch = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/profile`, {
      method: "PATCH",
      body: {
        address: {
          line1: "1 Church Street",
          city: "Derby",
          postcode: "DE1 1AA",
          countryCode: "GB",
        },
        pastorName: "Pastor Jane Able",
        pastorEmail: "pastor@example.com",
        pastorPhone: "+44 7000 000000",
        officeEmail: "office@example.com",
        officePhone: "+44 7000 111111",
        website: "https://example.com",
      },
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as {
      profile: { pastorName: string | null; address: { city: string | null } };
    };
    expect(patchBody.profile.pastorName).toBe("Pastor Jane Able");
    expect(patchBody.profile.address.city).toBe("Derby");

    const get = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}`);
    const getBody = (await get.json()) as {
      chapter: { profile: { officeEmail: string | null; address: { countryCode: string | null } } };
    };
    expect(getBody.chapter.profile.officeEmail).toBe("office@example.com");
    expect(getBody.chapter.profile.address.countryCode).toBe("GB");
  });

  it("PATCH /chapters/:id/profile rejects unsafe website URLs", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/profile`, {
      method: "PATCH",
      body: { website: "javascript:alert(1)" },
    });
    expect(res.status).toBe(400);
  });

  it("chapter profile and banking updates preserve each other's metadata", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const banking = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/banking`, {
      method: "PATCH",
      body: {
        primaryCurrency: "GBP",
        references: [{ label: "Offering account", value: "12-34-56 / 12345678" }],
      },
    });
    expect(banking.status).toBe(200);

    const profile = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/profile`, {
      method: "PATCH",
      body: { pastorName: "Pastor Jane Able", website: "https://example.com" },
    });
    expect(profile.status).toBe(200);

    const get = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}`);
    const body = (await get.json()) as {
      chapter: {
        banking: { primaryCurrency: string | null; references: { label: string }[] };
        profile: { pastorName: string | null; website: string | null };
      };
    };
    expect(body.chapter.profile.pastorName).toBe("Pastor Jane Able");
    expect(body.chapter.profile.website).toBe("https://example.com");
    expect(body.chapter.banking.primaryCurrency).toBe("GBP");
    expect(body.chapter.banking.references.map((r) => r.label)).toEqual(["Offering account"]);
  });

  it("PATCH /chapters/:id/profile against another zone's chapter → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/chapters/${chapterB}/profile`, {
      method: "PATCH",
      body: { pastorName: "Hidden" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("chapter admin can only update profiles for chapters where that exact role is bound", async () => {
    const otherChapter = await seedChapter(zoneA.id, "Chapter A Profile Other");
    const mixedRoleUser = await seedUser(`mixed-chapter+${unique()}@example.com`);
    cleanupUserIds.push(mixedRoleUser);
    await db.insert(userRoleBindings).values([
      {
        userId: mixedRoleUser,
        zoneId: zoneA.id,
        chapterId: chapterA,
        roleId: zoneA.chapterAdminRoleId,
      },
      {
        userId: mixedRoleUser,
        zoneId: zoneA.id,
        chapterId: otherChapter,
        roleId: zoneA.chapterTreasurerRoleId,
      },
    ]);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(mixedRoleUser, "mixed@x"));

    const ownPatch = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/profile`, {
      method: "PATCH",
      body: { pastorName: "Pastor Own Chapter" },
    });
    expect(ownPatch.status).toBe(200);

    const otherPatch = await call(zoneA.slug, `/api/tenant/chapters/${otherChapter}/profile`, {
      method: "PATCH",
      body: { pastorName: "Pastor Other Chapter" },
    });
    expect(otherPatch.status).toBe(403);
  });

  it("chapter admin can read + write their own chapter's banking but not another", async () => {
    // Stand up a fresh chapter B-prime in zone A so we have two chapters
    // for the chapter-admin scope test, then bind a new user as
    // chapter_admin on chapterA only.
    const otherChapter = await seedChapter(zoneA.id, "Chapter A Other");
    const chapAdmin = await seedUser(`chap-admin+${unique()}@example.com`);
    cleanupUserIds.push(chapAdmin);
    await db.insert(userRoleBindings).values({
      userId: chapAdmin,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterAdminRoleId,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(chapAdmin, "ca@x"));

    const ownPatch = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/banking`, {
      method: "PATCH",
      body: { primaryCurrency: "GBP", references: [] },
    });
    expect(ownPatch.status).toBe(200);

    const foreignPatch = await call(zoneA.slug, `/api/tenant/chapters/${otherChapter}/banking`, {
      method: "PATCH",
      body: { primaryCurrency: "USD", references: [] },
    });
    expect(foreignPatch.status).toBe(403);
  });

  it("GET /chapters/:id/roster lists active chapter-scope bindings", async () => {
    // Seed a chapter admin for chapterA and confirm they show up.
    const treasurer = await seedUser(`treasurer+${unique()}@example.com`);
    cleanupUserIds.push(treasurer);
    await db.insert(userRoleBindings).values({
      userId: treasurer,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterAdminRoleId,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/roster`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { userId: string; roleCode: string }[] };
    expect(body.items.find((r) => r.userId === treasurer)?.roleCode).toBe(
      CHAPTER_ROLES.CHAPTER_ADMIN,
    );
  });

  it("chapter admin can invite into their own chapter; foreign chapter → 403", async () => {
    const otherChapter = await seedChapter(zoneA.id, `C-${unique()}`);
    const chapAdmin = await seedUser(`chap-admin2+${unique()}@example.com`);
    cleanupUserIds.push(chapAdmin);
    await db.insert(userRoleBindings).values({
      userId: chapAdmin,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterAdminRoleId,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(chapAdmin, "ca@x"));

    const own = await call(zoneA.slug, "/api/tenant/invitations", {
      method: "POST",
      body: {
        email: `cap-own+${unique()}@example.com`,
        roleCode: CHAPTER_ROLES.CHAPTER_TREASURER,
        chapterId: chapterA,
      },
    });
    expect(own.status).toBe(201);

    const foreign = await call(zoneA.slug, "/api/tenant/invitations", {
      method: "POST",
      body: {
        email: `cap-foreign+${unique()}@example.com`,
        roleCode: CHAPTER_ROLES.CHAPTER_TREASURER,
        chapterId: otherChapter,
      },
    });
    expect(foreign.status).toBe(403);

    // And zone-scope invites are forbidden full stop.
    const zoneScope = await call(zoneA.slug, "/api/tenant/invitations", {
      method: "POST",
      body: {
        email: `cap-zonescope+${unique()}@example.com`,
        roleCode: ZONE_ROLES.ZONE_ADMIN,
      },
    });
    expect(zoneScope.status).toBe(403);
  });

  it("GET /invitations?chapterId= clamps zone-admin and chapter-admin to that chapter", async () => {
    // Use the existing invA (zone-scope) plus a fresh chapter-scope invite
    // pinned to chapterA. The ?chapterId=chapterA filter should exclude
    // invA (no chapterId) and include the chapter one.
    const [pinned] = await db
      .insert(invitations)
      .values({
        zoneId: zoneA.id,
        email: `pinned+${unique()}@example.com`,
        roleCode: CHAPTER_ROLES.CHAPTER_TREASURER,
        chapterId: chapterA,
        tokenHash: `hash-pinned-${unique()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: invitations.id });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/invitations?chapterId=${chapterA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    const ids = new Set(body.items.map((i) => i.id));
    expect(ids.has(pinned.id)).toBe(true);
    expect(ids.has(invA)).toBe(false);
  });

  // ─── Batch templates ──────────────────────────────────────────

  it("POST /chapters/:id/batch-templates round-trips through list + delete", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const payload = {
      sourceType: "envelope",
      defaultCurrency: "GBP",
      referenceCode: "sunday",
      notes: "cash + cheque",
    };
    const create = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/batch-templates`, {
      method: "POST",
      body: { name: `Sunday close ${unique()}`, payload },
    });
    expect(create.status).toBe(201);
    const { template } = (await create.json()) as { template: { id: string; name: string } };

    const list = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/batch-templates`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { items: { id: string }[] };
    expect(listed.items.some((t) => t.id === template.id)).toBe(true);

    const del = await call(
      zoneA.slug,
      `/api/tenant/chapters/${chapterA}/batch-templates/${template.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);

    const afterDelete = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/batch-templates`);
    const afterBody = (await afterDelete.json()) as { items: { id: string }[] };
    expect(afterBody.items.some((t) => t.id === template.id)).toBe(false);
  });

  it("POST /chapters/:id/batch-templates rejects duplicate names with 409", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const name = `Dup ${unique()}`;
    const first = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/batch-templates`, {
      method: "POST",
      body: { name, payload: { sourceType: "envelope" } },
    });
    expect(first.status).toBe(201);
    const second = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/batch-templates`, {
      method: "POST",
      body: { name, payload: { sourceType: "manual" } },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("template_name_exists");
  });

  it("chapter-templates routes reject cross-zone chapter ids with 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/chapters/${chapterB}/batch-templates`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("chapter-admin can create templates in their own chapter; finance admin cannot", async () => {
    // Stand up two fresh users: a chapter admin bound to chapterA, and a
    // chapter bookkeeper bound to the same chapter (which is in the
    // CHAPTER_READ list but NOT in the write bucket).
    const chapAdmin = await seedUser(`tpl-chap-admin+${unique()}@example.com`);
    const bookkeeper = await seedUser(`tpl-bookkeeper+${unique()}@example.com`);
    cleanupUserIds.push(chapAdmin, bookkeeper);
    // Look up the chapter_bookkeeper role for zone A (seedZoneRoles created them).
    const [bkRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        sql`${roles.zoneId} = ${zoneA.id} and ${roles.code} = ${CHAPTER_ROLES.CHAPTER_BOOKKEEPER}`,
      )
      .limit(1);
    await db.insert(userRoleBindings).values([
      { userId: chapAdmin, zoneId: zoneA.id, chapterId: chapterA, roleId: zoneA.chapterAdminRoleId },
      { userId: bookkeeper, zoneId: zoneA.id, chapterId: chapterA, roleId: bkRole.id },
    ]);

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(chapAdmin, "ca@x"));
    const allowed = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/batch-templates`, {
      method: "POST",
      body: { name: `CA ${unique()}`, payload: { sourceType: "envelope" } },
    });
    expect(allowed.status).toBe(201);

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(bookkeeper, "bk@x"));
    const denied = await call(zoneA.slug, `/api/tenant/chapters/${chapterA}/batch-templates`, {
      method: "POST",
      body: { name: `BK ${unique()}`, payload: { sourceType: "envelope" } },
    });
    expect(denied.status).toBe(403);
  });
});
