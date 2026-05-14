// packages/api/src/routes/tenant-dashboard.test.ts
// Phase 7 — route-layer coverage for /api/tenant/dashboard/zone.
// Asserts the access tier (zone reader allowed; chapter-only denied;
// cross-tenant denied) and the payload shape.
// RELEVANT FILES: packages/api/src/routes/tenant-dashboard.ts, packages/api/src/services/dashboards/zone-dashboard.ts, packages/api/src/routes/tenant-reports.test.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyContributionTriggers,
  chapters,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db";
import { ZONE_ROLES } from "@stewardledger/shared";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { seedZoneGivingSetup } from "../services/giving-setup-seed";
import { seedZonePeriods } from "../services/period-seed";
import { seedZoneRoles } from "../services/role-seed";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const HOST_DOMAIN = "localhost";

interface SeededZone {
  id: string;
  slug: string;
  chapterId: string;
  otherChapterId: string;
  ownerRoleId: string;
  treasurerRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Dashboard Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const roleIds = await seedZoneRoles(db, zone.id);
  await seedZoneGivingSetup(db, zone.id, "GBP");
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });
  const [chapter, otherChapter] = await db
    .insert(chapters)
    .values([
      {
        zoneId: zone.id,
        referenceCode: `CD${unique()}`.slice(0, 12),
        name: `Dashboard Chapter ${unique()}`,
        dateFrom: "2024-01-01",
      },
      {
        zoneId: zone.id,
        referenceCode: `CD${unique()}`.slice(0, 12),
        name: `Dashboard Other Chapter ${unique()}`,
        dateFrom: "2024-01-01",
      },
    ])
    .returning({ id: chapters.id });
  return {
    id: zone.id,
    slug: zone.slug,
    chapterId: chapter.id,
    otherChapterId: otherChapter.id,
    ownerRoleId: roleIds.get(ZONE_ROLES.ZONE_OWNER)!,
    treasurerRoleId: roleIds.get("chapter_treasurer")!,
  };
}

async function seedUser(email: string): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({ id, email, emailVerified: true });
  return id;
}

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

const app = createApp();

async function get(slug: string, path: string): Promise<Response> {
  return app.fetch(
    new Request(`http://${slug}.${HOST_DOMAIN}${path}`, {
      method: "GET",
      headers: { host: `${slug}.${HOST_DOMAIN}` },
    }),
  );
}

describe("tenant dashboard routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let ownerA: string;
  let treasurerA: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-dashboard.test.ts requires a *_test DATABASE_URL");
    }
    await applyContributionTriggers(db);

    zoneA = await seedZone(`dash-a-${unique()}`);
    zoneB = await seedZone(`dash-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    ownerA = await seedUser(`dash-owner+${unique()}@example.com`);
    treasurerA = await seedUser(`dash-tre+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, treasurerA);

    await db.insert(userRoleBindings).values([
      { userId: ownerA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId },
      {
        userId: treasurerA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        roleId: zoneA.treasurerRoleId,
      },
    ]);
  });

  afterAll(async () => {
    await db.transaction(async (tx) => {
      for (const slug of cleanupSlugs) {
        const z = sql`(select id from zones where slug = ${slug})`;
        await tx.execute(sql`delete from chapters where zone_id = ${z}`);
        await tx.execute(sql`delete from zones where slug = ${slug}`);
      }
      for (const id of cleanupUserIds) {
        await tx.execute(sql`delete from "user" where id = ${id}`);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asUser(userId: string, email: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userId, email));
  }

  it("returns the zone dashboard payload for an owner", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await get(zoneA.slug, "/api/tenant/dashboard/zone");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.asOf).toBe("string");
    expect(typeof body.timeZone).toBe("string");
    expect(body.chapters).toMatchObject({ total: expect.any(Number), active: expect.any(Number) });
    expect(body.members).toMatchObject({
      total: expect.any(Number),
      active: expect.any(Number),
      inactive: expect.any(Number),
    });
    expect(Array.isArray((body.monthlyGiving as { perCurrency: unknown[] }).perCurrency)).toBe(
      true,
    );
    expect(Array.isArray(body.topChapters)).toBe(true);
    expect(Array.isArray(body.topPartners)).toBe(true);
    expect(Array.isArray(body.recentImports)).toBe(true);
    // Phase-8 placeholder lands as `{ available: false, reason }`.
    expect(body.partnershipProgress).toMatchObject({ available: false });
    // The endpoint must never be cached: payload includes member-level
    // totals that are PII-adjacent.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("denies a chapter-only treasurer with 403", async () => {
    asUser(treasurerA, "tre@example.com");
    const res = await get(zoneA.slug, "/api/tenant/dashboard/zone");
    expect(res.status).toBe(403);
  });

  it("denies a cross-tenant attempt", async () => {
    // ownerA has no binding in zoneB; requireTenantAuth returns 403
    // before the dashboard handler runs.
    asUser(ownerA, "owner@example.com");
    const res = await get(zoneB.slug, "/api/tenant/dashboard/zone");
    expect(res.status).toBe(403);
  });

  it("chapter dashboard: owner can drill into any chapter", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await get(
      zoneA.slug,
      `/api/tenant/dashboard/chapter/${zoneA.chapterId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.chapter as { id: string }).id).toBe(zoneA.chapterId);
    expect(body.timeZone).toBe("Europe/London");
    expect(Array.isArray(body.topGivingTypes)).toBe(true);
    expect(Array.isArray(body.topPartners)).toBe(true);
    expect(Array.isArray(body.recentContributions)).toBe(true);
    expect(body.pendingBatches).toMatchObject({ count: expect.any(Number) });
    expect(body.partnershipProgress).toMatchObject({ available: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("chapter dashboard: chapter treasurer can read their bound chapter", async () => {
    asUser(treasurerA, "tre@example.com");
    const res = await get(
      zoneA.slug,
      `/api/tenant/dashboard/chapter/${zoneA.chapterId}`,
    );
    expect(res.status).toBe(200);
  });

  it("chapter dashboard: chapter treasurer is denied on a chapter they don't own", async () => {
    asUser(treasurerA, "tre@example.com");
    const res = await get(
      zoneA.slug,
      `/api/tenant/dashboard/chapter/${zoneA.otherChapterId}`,
    );
    expect(res.status).toBe(403);
  });

  it("chapter dashboard: 404 for an unknown chapter id (zone reader)", async () => {
    asUser(ownerA, "owner@example.com");
    const phantom = "00000000-0000-4000-8000-000000000000";
    const res = await get(zoneA.slug, `/api/tenant/dashboard/chapter/${phantom}`);
    expect(res.status).toBe(404);
  });

  it("chapter dashboard: cross-tenant attempt is denied", async () => {
    asUser(ownerA, "owner@example.com");
    // ownerA has no binding in zoneB; requireTenantAuth blocks first.
    const res = await get(
      zoneB.slug,
      `/api/tenant/dashboard/chapter/${zoneB.chapterId}`,
    );
    expect(res.status).toBe(403);
  });
});
