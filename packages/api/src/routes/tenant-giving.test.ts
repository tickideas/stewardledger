// packages/api/src/routes/tenant-giving.test.ts
// Cross-tenant and happy-path coverage for Phase 4 giving setup APIs.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  chapters,
  givingCategories,
  givingPeriods,
  paymentMethods,
  serviceEvents,
  serviceTypes,
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
  chapterTreasurerRoleId: string;
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
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });
  return {
    id: zone.id,
    slug: zone.slug,
    ownerRoleId: seededRoles.get(ZONE_ROLES.ZONE_OWNER)!,
    chapterTreasurerRoleId: seededRoles.get(CHAPTER_ROLES.CHAPTER_TREASURER)!,
  };
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
  let chapterUserA: string;
  let chapterA: string;
  let chapterB: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    zoneA = await seedZone(`give-a-${unique()}`, "GBP");
    zoneB = await seedZone(`give-b-${unique()}`, "USD");
    cleanupSlugs.push(zoneA.slug, zoneB.slug);
    chapterA = await seedChapter(zoneA.id, "Chapter A");
    chapterB = await seedChapter(zoneB.id, "Chapter B");

    userA = await seedUser(`giving-a+${unique()}@example.com`);
    chapterUserA = await seedUser(`giving-chapter-a+${unique()}@example.com`);
    cleanupUserIds.push(userA, chapterUserA);
    await db.insert(userRoleBindings).values({
      userId: userA,
      zoneId: zoneA.id,
      roleId: zoneA.ownerRoleId,
    });
    await db.insert(userRoleBindings).values({
      userId: chapterUserA,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterTreasurerRoleId,
    });
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      await db.execute(sql`delete from service_events where zone_id = (select id from zones where slug = ${slug})`);
      await db.execute(sql`delete from chapters where zone_id = (select id from zones where slug = ${slug})`);
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

  it("creates a service event and derives its giving period from serviceDate", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const [serviceType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zoneA.id}`)
      .limit(1);
    const serviceDate = `${new Date().getUTCFullYear()}-07-15`;

    const res = await call(zoneA.slug, "/api/tenant/giving/service-events", {
      method: "POST",
      body: { chapterId: chapterA, serviceTypeId: serviceType.id, serviceDate, notes: "Sunday close" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      serviceEvent: { id: string; givingPeriodId: string; serviceDate: string };
    };
    expect(body.serviceEvent.serviceDate).toBe(serviceDate);

    const [period] = await db
      .select({ id: givingPeriods.id, month: givingPeriods.month, quarter: givingPeriods.quarter })
      .from(givingPeriods)
      .where(sql`${givingPeriods.id} = ${body.serviceEvent.givingPeriodId}`);
    expect(period.month).toBe(7);
    expect(period.quarter).toBe(3);
  });

  it("updates a service event and re-derives the giving period when the date changes", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const [serviceType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zoneA.id}`)
      .limit(1);
    const originalDate = `${new Date().getUTCFullYear()}-02-10`;
    const nextDate = `${new Date().getUTCFullYear()}-11-12`;
    const create = await call(zoneA.slug, "/api/tenant/giving/service-events", {
      method: "POST",
      body: { chapterId: chapterA, serviceTypeId: serviceType.id, serviceDate: originalDate },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { serviceEvent: { id: string; givingPeriodId: string } };

    const patch = await call(zoneA.slug, `/api/tenant/giving/service-events/${created.serviceEvent.id}`, {
      method: "PATCH",
      body: { serviceDate: nextDate },
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { serviceEvent: { givingPeriodId: string; serviceDate: string } };
    expect(patched.serviceEvent.serviceDate).toBe(nextDate);
    expect(patched.serviceEvent.givingPeriodId).not.toBe(created.serviceEvent.givingPeriodId);

    const [period] = await db
      .select({ month: givingPeriods.month })
      .from(givingPeriods)
      .where(sql`${givingPeriods.id} = ${patched.serviceEvent.givingPeriodId}`);
    expect(period.month).toBe(11);
  });

  it("rejects service events using another zone's chapter or service type", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const [zoneAType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zoneA.id}`)
      .limit(1);
    const [zoneBType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zoneB.id}`)
      .limit(1);
    const serviceDate = `${new Date().getUTCFullYear()}-08-01`;

    const foreignChapter = await call(zoneA.slug, "/api/tenant/giving/service-events", {
      method: "POST",
      body: { chapterId: chapterB, serviceTypeId: zoneAType.id, serviceDate },
    });
    expect(foreignChapter.status).toBe(404);

    const foreignServiceType = await call(zoneA.slug, "/api/tenant/giving/service-events", {
      method: "POST",
      body: { chapterId: chapterA, serviceTypeId: zoneBType.id, serviceDate },
    });
    expect(foreignServiceType.status).toBe(404);
    const body = (await foreignServiceType.json()) as { error: { code: string } };
    expect(body.error.code).toBe("service_type_not_found");
  });

  it("chapter treasurers only see their chapter and zone-wide service events", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "giving-a@example.com"));
    const [serviceType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zoneA.id}`)
      .limit(1);
    const serviceDate = `${new Date().getUTCFullYear()}-09-03`;
    const zoneWide = await call(zoneA.slug, "/api/tenant/giving/service-events", {
      method: "POST",
      body: { serviceTypeId: serviceType.id, serviceDate },
    });
    expect(zoneWide.status).toBe(201);
    const chapterScoped = await call(zoneA.slug, "/api/tenant/giving/service-events", {
      method: "POST",
      body: { chapterId: chapterA, serviceTypeId: serviceType.id, serviceDate },
    });
    expect(chapterScoped.status).toBe(201);

    const [otherChapter] = await db
      .insert(chapters)
      .values({
        zoneId: zoneA.id,
        referenceCode: `C${unique()}`,
        name: "Other Chapter",
        dateFrom: new Date().toISOString().slice(0, 10),
      })
      .returning({ id: chapters.id });
    const period = await db
      .select({ id: givingPeriods.id })
      .from(givingPeriods)
      .where(sql`${givingPeriods.zoneId} = ${zoneA.id} and ${givingPeriods.date} = ${serviceDate}`)
      .limit(1);
    await db.insert(serviceEvents).values({
      zoneId: zoneA.id,
      chapterId: otherChapter.id,
      serviceTypeId: serviceType.id,
      serviceDate,
      givingPeriodId: period[0].id,
    });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(chapterUserA, "giving-chapter-a@example.com"),
    );
    const res = await call(zoneA.slug, "/api/tenant/giving/service-events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ chapterId: string | null }> };
    expect(body.items.some((item) => item.chapterId === null)).toBe(true);
    expect(body.items.some((item) => item.chapterId === chapterA)).toBe(true);
    expect(body.items.some((item) => item.chapterId === otherChapter.id)).toBe(false);
  });
});
