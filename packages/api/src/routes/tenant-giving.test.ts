// packages/api/src/routes/tenant-giving.test.ts
// Cross-tenant and happy-path coverage for Phase 4 giving setup APIs.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZONE_ROLES } from "@stewardledger/shared";
import {
  givingCategories,
  paymentMethods,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { seedZoneGivingSetup } from "../services/giving-setup-seed";
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

async function seedZone(slug: string, currencyCode: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Giving Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: currencyCode,
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const seededRoles = await seedZoneRoles(db, zone.id);
  await seedZoneGivingSetup(db, zone.id, currencyCode);
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

describe("tenant giving setup routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let userA: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    zoneA = await seedZone(`give-a-${unique()}`, "GBP");
    zoneB = await seedZone(`give-b-${unique()}`, "USD");
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    userA = await seedUser(`giving-a+${unique()}@example.com`);
    cleanupUserIds.push(userA);
    await db.insert(userRoleBindings).values({
      userId: userA,
      zoneId: zoneA.id,
      roleId: zoneA.ownerRoleId,
    });
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists only this zone's seeded giving categories", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const res = await call(zoneA.slug, "/api/tenant/giving/categories");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; name: string }> };
    expect(body.items.map((item) => item.name)).toContain("Tithes");

    const zoneBCategoryIds = await db
      .select({ id: givingCategories.id })
      .from(givingCategories)
      .where(sql`${givingCategories.zoneId} = ${zoneB.id}`);
    expect(body.items.map((item) => item.id)).not.toContain(zoneBCategoryIds[0].id);
  });

  it("creates an account using the zone default currency when currencyCode is omitted", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const res = await call(zoneA.slug, "/api/tenant/giving/accounts", {
      method: "POST",
      body: { name: `Building Fund ${unique()}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { account: { currencyCode: string } };
    expect(body.account.currencyCode).toBe("GBP");
  });

  it("rejects duplicate seeded category names", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const res = await call(zoneA.slug, "/api/tenant/giving/categories", {
      method: "POST",
      body: { name: "Tithes" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("category_exists");
  });

  it("rejects creating a giving type with another zone's category", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const [zoneBCategory] = await db
      .select({ id: givingCategories.id })
      .from(givingCategories)
      .where(sql`${givingCategories.zoneId} = ${zoneB.id}`)
      .limit(1);
    const res = await call(zoneA.slug, "/api/tenant/giving/types", {
      method: "POST",
      body: { name: `Cross Zone ${unique()}`, categoryId: zoneBCategory.id },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("category_not_found");
  });

  it("does not patch another zone's payment method", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const [zoneBMethod] = await db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(sql`${paymentMethods.zoneId} = ${zoneB.id}`)
      .limit(1);
    const res = await call(zoneA.slug, `/api/tenant/giving/payment-methods/${zoneBMethod.id}`, {
      method: "PATCH",
      body: { isActive: false },
    });
    expect(res.status).toBe(404);
  });

  it("creates and deactivates a service type", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const create = await call(zoneA.slug, "/api/tenant/giving/service-types", {
      method: "POST",
      body: { name: `Special Service ${unique()}`, shortCode: `SS_${unique().toUpperCase()}` },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { serviceType: { id: string } };

    const patch = await call(zoneA.slug, `/api/tenant/giving/service-types/${created.serviceType.id}`, {
      method: "PATCH",
      body: { isActive: false },
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { serviceType: { isActive: boolean } };
    expect(patched.serviceType.isActive).toBe(false);
  });

  it("requires a tenant role", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const res = await call(zoneB.slug, "/api/tenant/giving/accounts");
    expect(res.status).toBe(403);
  });
});
