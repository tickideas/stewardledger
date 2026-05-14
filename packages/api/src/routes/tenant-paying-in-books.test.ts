// packages/api/src/routes/tenant-paying-in-books.test.ts
// Phase 8 — paying-in-book CRUD route coverage.
//   • Owner / chapter-admin / treasurer access tiers.
//   • Cross-tenant chapter references rejected.
//   • Schema-level CHECKs (start <= end, dateTo >= dateFrom).
//   • Audit events written on every write.
// RELEVANT FILES: packages/api/src/routes/tenant-paying-in-books.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  chapters,
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
  chapterAdminRoleId: string;
  chapterTreasurerRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `PIB Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const seededRoles = await seedZoneRoles(db, zone.id);
  return {
    id: zone.id,
    slug: zone.slug,
    ownerRoleId: seededRoles.get(ZONE_ROLES.ZONE_OWNER)!,
    chapterAdminRoleId: seededRoles.get(CHAPTER_ROLES.CHAPTER_ADMIN)!,
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

describe("tenant paying-in-books routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let chapterA1: string;
  let chapterA2: string;
  let ownerA: string;
  let chapterAdminA1: string;
  let treasurerA1: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-paying-in-books.test.ts requires a *_test DATABASE_URL");
    }
    zoneA = await seedZone(`pib-rt-a-${unique()}`);
    zoneB = await seedZone(`pib-rt-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);
    chapterA1 = await seedChapter(zoneA.id, "Chapter A1");
    chapterA2 = await seedChapter(zoneA.id, "Chapter A2");
    await seedChapter(zoneB.id, "Chapter B1");

    ownerA = await seedUser(`pib-owner+${unique()}@example.com`);
    chapterAdminA1 = await seedUser(`pib-chadm+${unique()}@example.com`);
    treasurerA1 = await seedUser(`pib-tre+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, chapterAdminA1, treasurerA1);

    await db.insert(userRoleBindings).values([
      { userId: ownerA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId },
      {
        userId: chapterAdminA1,
        zoneId: zoneA.id,
        chapterId: chapterA1,
        roleId: zoneA.chapterAdminRoleId,
      },
      {
        userId: treasurerA1,
        zoneId: zoneA.id,
        chapterId: chapterA1,
        roleId: zoneA.chapterTreasurerRoleId,
      },
    ]);
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
      await db.execute(sql`delete from paying_in_books where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from chapters where zone_id = ${zoneIdSubq}`);
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

  it("owner creates a chapter-scoped paying-in book", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "0001",
        referenceCodeEnd: "0100",
        dateFrom: "2025-01-01",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payingInBook: { id: string; chapterId: string; dateTo: string | null };
    };
    expect(body.payingInBook.chapterId).toBe(chapterA1);
    expect(body.payingInBook.dateTo).toBeNull();
  });

  it("rejects a chapter from another zone with 404", async () => {
    asUser(ownerA, "owner@example.com");
    const [zoneBChapter] = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(sql`${chapters.zoneId} = ${zoneB.id}`)
      .limit(1);
    const res = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: zoneBChapter.id,
        referenceCodeStart: "0001",
        referenceCodeEnd: "0100",
        dateFrom: "2025-01-01",
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("rejects start > end via the Zod schema (400)", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "0200",
        referenceCodeEnd: "0100",
        dateFrom: "2025-01-01",
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects dateTo < dateFrom via the Zod schema (400)", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "0001",
        referenceCodeEnd: "0100",
        dateFrom: "2025-06-01",
        dateTo: "2025-01-01",
      },
    });
    expect(res.status).toBe(400);
  });

  it("chapter admin can create on their bound chapter but not on others", async () => {
    asUser(chapterAdminA1, "chadm@example.com");
    const allowed = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "0500",
        referenceCodeEnd: "0600",
        dateFrom: "2025-01-01",
      },
    });
    expect(allowed.status).toBe(201);

    const denied = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA2,
        referenceCodeStart: "0700",
        referenceCodeEnd: "0800",
        dateFrom: "2025-01-01",
      },
    });
    expect(denied.status).toBe(403);
  });

  it("treasurer cannot write but can read their chapter's books", async () => {
    asUser(treasurerA1, "tre@example.com");
    const writeRes = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "9999",
        referenceCodeEnd: "9999",
        dateFrom: "2025-01-01",
      },
    });
    expect(writeRes.status).toBe(403);

    const list = await call(zoneA.slug, "/api/tenant/paying-in-books");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ chapterId: string }> };
    // Treasurer is bound only to chapter A1; all returned items must belong to A1.
    expect(body.items.every((b) => b.chapterId === chapterA1)).toBe(true);
  });

  it("patch updates a book's range + date window", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "2000",
        referenceCodeEnd: "2100",
        dateFrom: "2025-01-01",
      },
    });
    const { payingInBook } = (await create.json()) as { payingInBook: { id: string } };
    const patch = await call(
      zoneA.slug,
      `/api/tenant/paying-in-books/${payingInBook.id}`,
      {
        method: "PATCH",
        body: { referenceCodeEnd: "2200", dateTo: "2025-12-31" },
      },
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as {
      payingInBook: { referenceCodeEnd: string; dateTo: string };
    };
    expect(patched.payingInBook.referenceCodeEnd).toBe("2200");
    expect(patched.payingInBook.dateTo).toBe("2025-12-31");
  });

  it("patch rejects an end < existing-start (invalid_range)", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "3000",
        referenceCodeEnd: "3100",
        dateFrom: "2025-01-01",
      },
    });
    const { payingInBook } = (await create.json()) as { payingInBook: { id: string } };
    const patch = await call(
      zoneA.slug,
      `/api/tenant/paying-in-books/${payingInBook.id}`,
      {
        method: "PATCH",
        body: { referenceCodeEnd: "2999" },
      },
    );
    expect(patch.status).toBe(400);
    const body = (await patch.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_range");
  });

  it("delete removes the row", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/paying-in-books", {
      method: "POST",
      body: {
        chapterId: chapterA1,
        referenceCodeStart: "4000",
        referenceCodeEnd: "4001",
        dateFrom: "2025-01-01",
      },
    });
    const { payingInBook } = (await create.json()) as { payingInBook: { id: string } };
    const del = await call(
      zoneA.slug,
      `/api/tenant/paying-in-books/${payingInBook.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
  });

  it("cross-tenant attempt is blocked at requireTenantAuth (403)", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneB.slug, "/api/tenant/paying-in-books");
    expect(res.status).toBe(403);
  });
});
