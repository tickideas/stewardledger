// packages/api/src/routes/tenant-contributions.test.ts
// Cross-tenant + role-gating coverage for the Phase 5 contribution + batch
// tenant API. Drives the real Hono stack via `app.fetch` with a spied
// `auth.api.getSession`, mirroring the Phase 3/4 test style.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  accounts,
  applyContributionTriggers,
  chapters,
  contributions,
  givingTypes,
  members,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db";
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
  defaultCurrency: string;
  chapterId: string;
  memberId: string;
  givingTypeId: string;
  generalFundAccountId: string;
  ownerRoleId: string;
  financeAdminRoleId: string;
  chapterTreasurerRoleId: string;
  chapterBookkeeperRoleId: string;
  chapterPastorRoleId: string;
}

async function seedZone(slug: string, currency: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Contrib Routes Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: currency,
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const roleIds = await seedZoneRoles(db, zone.id);
  await seedZoneGivingSetup(db, zone.id, currency);
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });
  const [chapter] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: `Chapter ${unique()}`,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  const [member] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chapter.id,
      referenceCode: `M${unique()}`,
      firstName: "Routes",
      lastName: "Tester",
    })
    .returning({ id: members.id });
  const [givingType] = await db
    .select({ id: givingTypes.id })
    .from(givingTypes)
    .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'TITHE'`)
    .limit(1);
  const [generalFund] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(sql`${accounts.zoneId} = ${zone.id} and ${accounts.name} = 'General Fund'`)
    .limit(1);
  return {
    id: zone.id,
    slug: zone.slug,
    defaultCurrency: currency,
    chapterId: chapter.id,
    memberId: member.id,
    givingTypeId: givingType.id,
    generalFundAccountId: generalFund.id,
    ownerRoleId: roleIds.get(ZONE_ROLES.ZONE_OWNER)!,
    financeAdminRoleId: roleIds.get(ZONE_ROLES.ZONE_FINANCE_ADMIN)!,
    chapterTreasurerRoleId: roleIds.get(CHAPTER_ROLES.CHAPTER_TREASURER)!,
    chapterBookkeeperRoleId: roleIds.get(CHAPTER_ROLES.CHAPTER_BOOKKEEPER)!,
    chapterPastorRoleId: roleIds.get(CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER)!,
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

describe("tenant contribution routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let ownerA: string;
  let financeA: string;
  let treasurerA: string;
  let bookkeeperA: string;
  let pastorA: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];
  const seededDate = `${new Date().getUTCFullYear()}-04-15`;

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-contributions.test.ts requires a *_test DATABASE_URL");
    }
    await applyContributionTriggers(db);
    zoneA = await seedZone(`crt-a-${unique()}`, "GBP");
    zoneB = await seedZone(`crt-b-${unique()}`, "USD");
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    ownerA = await seedUser(`crt-owner+${unique()}@example.com`);
    financeA = await seedUser(`crt-finance+${unique()}@example.com`);
    treasurerA = await seedUser(`crt-treasurer+${unique()}@example.com`);
    bookkeeperA = await seedUser(`crt-bookkeeper+${unique()}@example.com`);
    pastorA = await seedUser(`crt-pastor+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, financeA, treasurerA, bookkeeperA, pastorA);

    await db.insert(userRoleBindings).values([
      { userId: ownerA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId },
      { userId: financeA, zoneId: zoneA.id, roleId: zoneA.financeAdminRoleId },
      {
        userId: treasurerA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        roleId: zoneA.chapterTreasurerRoleId,
      },
      {
        userId: bookkeeperA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        roleId: zoneA.chapterBookkeeperRoleId,
      },
      {
        userId: pastorA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        roleId: zoneA.chapterPastorRoleId,
      },
    ]);
  });

  afterAll(async () => {
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    for (const [t, n] of guards) {
      await db.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
    }
    try {
      for (const slug of cleanupSlugs) {
        const z = sql`(select id from zones where slug = ${slug})`;
        await db.execute(sql`delete from contribution_lines where zone_id = ${z}`);
        await db.execute(sql`delete from contribution_members where zone_id = ${z}`);
        await db.execute(sql`delete from contributions where zone_id = ${z}`);
        await db.execute(sql`delete from contribution_batches where zone_id = ${z}`);
        await db.execute(sql`delete from members where zone_id = ${z}`);
        await db.execute(sql`delete from chapters where zone_id = ${z}`);
        await db.execute(sql`delete from zones where slug = ${slug}`);
      }
      for (const id of cleanupUserIds) {
        await db.execute(sql`delete from "user" where id = ${id}`);
      }
    } finally {
      for (const [t, n] of guards) {
        await db.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asUser(userId: string, email: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userId, email));
  }

  // ─── Happy path ─────────────────────────────────────────────────────

  it("owner can create + post + read a contribution; defaults currency from zone", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        memberId: zoneA.memberId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "12.0000" }],
      },
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as {
      contribution: { id: string; status: string; currencyCode: string; totalAmount: string };
    };
    expect(body.contribution.currencyCode).toBe("GBP");
    expect(body.contribution.status).toBe("draft");
    const id = body.contribution.id;

    const post = await call(zoneA.slug, `/api/tenant/contributions/${id}/post`, { method: "POST" });
    expect(post.status).toBe(200);
    const posted = (await post.json()) as { contribution: { status: string } };
    expect(posted.contribution.status).toBe("posted");

    const get = await call(zoneA.slug, `/api/tenant/contributions/${id}`);
    expect(get.status).toBe(200);
    const got = (await get.json()) as {
      contribution: { status: string };
      lines: Array<{ amount: string }>;
    };
    expect(got.contribution.status).toBe("posted");
    expect(got.lines[0].amount).toBe("12.0000");
  });

  // ─── Cross-tenant ──────────────────────────────────────────────────

  it("rejects creating a contribution against a chapter in another zone", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneB.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    // Service detects cross-tenant via chapter check first → 403 because the
    // role check runs first and the user lacks a binding for zoneB's chapter.
    expect([403, 404]).toContain(res.status);
  });

  it("rejects creating a contribution with a giving_type from another zone", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneB.givingTypeId, amount: "1.0000" }],
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("giving_type_not_found");
  });

  it("does not return a contribution from another zone via GET :id", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    const { contribution } = (await create.json()) as { contribution: { id: string } };
    // Same id, different (zoneB) tenant slug — should be 404.
    const res = await call(zoneB.slug, `/api/tenant/contributions/${contribution.id}`);
    // zoneB user has no session — middleware first; expect 401/403/404.
    expect([401, 403, 404]).toContain(res.status);
  });

  // ─── Role gating ───────────────────────────────────────────────────

  it("chapter pastor (read-only) can list but cannot create a contribution", async () => {
    asUser(pastorA, "pastor@example.com");
    const list = await call(
      zoneA.slug,
      `/api/tenant/contributions?chapterId=${zoneA.chapterId}`,
    );
    expect(list.status).toBe(200);
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    expect(create.status).toBe(403);
  });

  it("chapter bookkeeper can draft but cannot post a contribution", async () => {
    asUser(bookkeeperA, "bookkeeper@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    expect(create.status).toBe(201);
    const { contribution } = (await create.json()) as { contribution: { id: string } };
    const post = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/post`, {
      method: "POST",
    });
    expect(post.status).toBe(403);
  });

  it("chapter treasurer can post their own chapter's contribution", async () => {
    asUser(treasurerA, "treasurer@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    expect(create.status).toBe(201);
    const { contribution } = (await create.json()) as { contribution: { id: string } };
    const post = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/post`, {
      method: "POST",
    });
    expect(post.status).toBe(200);
  });

  // ─── State machine ─────────────────────────────────────────────────

  it("posting a non-draft contribution is rejected with 409 not_draft", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    const { contribution } = (await create.json()) as { contribution: { id: string } };
    await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/post`, { method: "POST" });
    const again = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/post`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_draft");
  });

  it("voiding a posted contribution succeeds and rejects another void", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    const { contribution } = (await create.json()) as { contribution: { id: string } };
    await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/post`, { method: "POST" });
    const voided = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/void`, {
      method: "POST",
      body: { voidReason: "duplicate" },
    });
    expect(voided.status).toBe(200);
    const again = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/void`, {
      method: "POST",
      body: { voidReason: "again" },
    });
    expect(again.status).toBe(409);
  });

  it("reversing a posted contribution emits a corrective contribution and flips original", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "100.0000" }],
      },
    });
    const { contribution } = (await create.json()) as { contribution: { id: string } };
    await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/post`, { method: "POST" });
    const reverse = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/reverse`, {
      method: "POST",
      body: { reason: "wrong member" },
    });
    expect(reverse.status).toBe(201);
    const body = (await reverse.json()) as {
      contribution: { totalAmount: string; reversalOfContributionId: string };
    };
    expect(body.contribution.totalAmount).toBe("-100.0000");
    expect(body.contribution.reversalOfContributionId).toBe(contribution.id);

    const [original] = await db
      .select({ status: contributions.status })
      .from(contributions)
      .where(sql`${contributions.id} = ${contribution.id}`);
    expect(original.status).toBe("reversed");
  });

  // ─── Batch lifecycle via API ──────────────────────────────────────

  it("batch lifecycle endpoints flip statuses; posting a batch promotes its contributions", async () => {
    asUser(ownerA, "owner@example.com");
    const createBatch = await call(zoneA.slug, "/api/tenant/contribution-batches", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "envelope",
      },
    });
    expect(createBatch.status).toBe(201);
    const { batch } = (await createBatch.json()) as { batch: { id: string; currencyCode: string } };
    expect(batch.currencyCode).toBe("GBP");

    const createContrib = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        batchId: batch.id,
        sourceType: "envelope",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "5.0000" }],
      },
    });
    expect(createContrib.status).toBe(201);

    const submit = await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}/submit`, {
      method: "POST",
    });
    expect(submit.status).toBe(200);
    const approve = await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);
    const post = await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}/post`, {
      method: "POST",
    });
    expect(post.status).toBe(200);
    const body = (await post.json()) as {
      batch: { status: string };
      postedCount: number;
    };
    expect(body.batch.status).toBe("posted");
    expect(body.postedCount).toBe(1);
  });

  it("rejects attaching a contribution to a batch with a different currency", async () => {
    asUser(ownerA, "owner@example.com");
    const createBatch = await call(zoneA.slug, "/api/tenant/contribution-batches", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        currencyCode: "USD",
      },
    });
    const { batch } = (await createBatch.json()) as { batch: { id: string } };
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        batchId: batch.id,
        sourceType: "manual",
        contributionDate: seededDate,
        currencyCode: "GBP",
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    expect(create.status).toBe(409);
    const body = (await create.json()) as { error: { code: string } };
    expect(body.error.code).toBe("batch_currency_mismatch");
  });
});
