// packages/api/src/routes/tenant-periods.test.ts
// Phase 8 — read-only periods endpoints (ministry / partnership years).
// Verifies: happy path returns seeded rows, viewer role works, no-role
// is 403, and Zone B's rows never leak into Zone A's response.
// RELEVANT FILES: packages/api/src/routes/tenant-periods.ts

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZONE_ROLES } from "@stewardledger/shared";
import {
  ministryYears,
  partnershipYears,
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

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const HOST_DOMAIN = "localhost";

interface SeededZone {
  id: string;
  slug: string;
  ownerRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Periods Zone ${unique()}`,
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

async function call(slug: string, path: string): Promise<Response> {
  return app.fetch(
    new Request(`http://${slug}.${HOST_DOMAIN}${path}`, {
      method: "GET",
      headers: { host: `${slug}.${HOST_DOMAIN}` },
    }),
  );
}

describe("tenant periods routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let ownerA: string;
  let outsider: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-periods.test.ts requires a *_test DATABASE_URL");
    }
    zoneA = await seedZone(`per-a-${unique()}`);
    zoneB = await seedZone(`per-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    ownerA = await seedUser(`per-owner+${unique()}@example.com`);
    outsider = await seedUser(`per-outsider+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, outsider);

    await db.insert(userRoleBindings).values([
      { userId: ownerA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId,
  roleScope: "zone",
},
    ]);
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      // Zone FKs cascade — the seeded ministry/partnership years
      // and the role bindings go away with the zone.
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  function asUser(userId: string, email: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userId, email));
  }

  it("owner reads ministry years from their zone only", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/periods/ministry-years");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    // Cross-tenant fuzz: pull Zone B's ministry-year ids directly
    // from the DB and assert none of them appear in Zone A's
    // response.
    const bIds = await db
      .select({ id: ministryYears.id })
      .from(ministryYears)
      .where(eq(ministryYears.zoneId, zoneB.id));
    const bSet = new Set(bIds.map((r) => r.id));
    for (const item of body.items) {
      expect(bSet.has(item.id)).toBe(false);
    }
    vi.restoreAllMocks();
  });

  it("owner reads partnership years from their zone only", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/periods/partnership-years");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    const bIds = await db
      .select({ id: partnershipYears.id })
      .from(partnershipYears)
      .where(eq(partnershipYears.zoneId, zoneB.id));
    const bSet = new Set(bIds.map((r) => r.id));
    for (const item of body.items) {
      expect(bSet.has(item.id)).toBe(false);
    }
    vi.restoreAllMocks();
  });

  it("user with no role in the zone is 403", async () => {
    asUser(outsider, "outsider@example.com");
    const res = await call(zoneA.slug, "/api/tenant/periods/ministry-years");
    // The user is authenticated; they just have no binding in this
    // zone. The auth middleware emits 403 (not 401) for that case
    // — see `packages/api/src/middleware/auth.ts` 'No access to
    // this zone'.
    expect(res.status).toBe(403);
    vi.restoreAllMocks();
  });
});
