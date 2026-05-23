// packages/api/src/routes/tenant-contributions.test.ts
// Cross-tenant + role-gating coverage for the Phase 5 contribution + batch
// tenant API. Drives the real Hono stack via `app.fetch` with a spied
// `auth.api.getSession`, mirroring the Phase 3/4 test style.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  accounts,
  applyContributionTriggers,
  chapters,
  contributions,
  groups,
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
  groupAdminRoleId: string;
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
    groupAdminRoleId: roleIds.get(GROUP_ROLES.GROUP_ADMIN)!,
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
  let groupAdminA: string;
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
    groupAdminA = await seedUser(`crt-group+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, financeA, treasurerA, bookkeeperA, pastorA, groupAdminA);

    const [groupA] = await db
      .insert(groups)
      .values({ zoneId: zoneA.id, name: `Contrib Group ${unique()}`, slug: `contrib-group-${unique()}` })
      .returning({ id: groups.id });
    await db.update(chapters).set({ groupId: groupA.id }).where(sql`${chapters.id} = ${zoneA.chapterId}`);

    await db.insert(userRoleBindings).values([
      { userId: ownerA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId,
  roleScope: "zone",
},
      { userId: financeA, zoneId: zoneA.id, roleId: zoneA.financeAdminRoleId,
  roleScope: "zone",
},
      {
        userId: treasurerA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        roleId: zoneA.chapterTreasurerRoleId,
        roleScope: "chapter",
      },
      {
        userId: bookkeeperA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        roleId: zoneA.chapterBookkeeperRoleId,
        roleScope: "chapter",
      },
      {
        userId: pastorA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterId,
        roleId: zoneA.chapterPastorRoleId,
        roleScope: "chapter",
      },
      {
        userId: groupAdminA,
        zoneId: zoneA.id,
        groupId: groupA.id,
        roleId: zoneA.groupAdminRoleId,
        roleScope: "group",
      },
    ]);
  });

  afterAll(async () => {
    // Wrap the whole disable / delete / re-enable in one transaction
    // so all three statements share one connection — the pool would
    // otherwise route the DELETE to a different connection where the
    // trigger is still active. The advisory lock serialises against
    // any parallel suite calling `applyContributionTriggers` in its
    // own bootstrap. Mirrors the safe pattern in imports.test.ts.
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
      );
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
      }
      for (const slug of cleanupSlugs) {
        const z = sql`(select id from zones where slug = ${slug})`;
        await tx.execute(sql`delete from contribution_lines where zone_id = ${z}`);
        await tx.execute(sql`delete from contribution_members where zone_id = ${z}`);
        await tx.execute(sql`delete from contributions where zone_id = ${z}`);
        await tx.execute(sql`delete from contribution_batches where zone_id = ${z}`);
        await tx.execute(sql`delete from members where zone_id = ${z}`);
        await tx.execute(sql`update chapters set group_id = null where zone_id = ${z}`);
        await tx.execute(sql`delete from groups where zone_id = ${z}`);
        await tx.execute(sql`delete from chapters where zone_id = ${z}`);
        await tx.execute(sql`delete from zones where slug = ${slug}`);
      }
      for (const id of cleanupUserIds) {
        await tx.execute(sql`delete from "user" where id = ${id}`);
      }
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
      }
    });
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

  it("group admins can read but not write contributions in their group", async () => {
    asUser(ownerA, "owner@example.com");
    const create = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        memberId: zoneA.memberId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "9.0000" }],
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { contribution: { id: string } };

    asUser(groupAdminA, "group@example.com");
    const list = await call(zoneA.slug, "/api/tenant/contributions");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: Array<{ id: string }> };
    expect(listBody.items.map((c) => c.id)).toContain(created.contribution.id);

    const get = await call(zoneA.slug, `/api/tenant/contributions/${created.contribution.id}`);
    expect(get.status).toBe(200);

    const denied = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "10.0000" }],
      },
    });
    expect(denied.status).toBe(403);
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
    // ownerA has zone-wide write on zoneA so role gating passes; the
    // service-layer in-zone reference check rejects with chapter_not_found.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
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
    // Same id, different (zoneB) tenant slug. ownerA's session is valid but
    // they have no role binding in zoneB → requireTenantAuth → 403 forbidden.
    const res = await call(zoneB.slug, `/api/tenant/contributions/${contribution.id}`);
    expect(res.status).toBe(403);
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

  // ─── PATCH / DELETE / batch list+get+void ─────────────────────────

  it("PATCH /contributions/:id rewrites a draft and rejects on a posted record", async () => {
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

    const patch = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}`, {
      method: "PATCH",
      body: {
        description: "patched",
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "9.0000" }],
      },
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as {
      contribution: { description: string | null; totalAmount: string };
      lines: Array<{ amount: string }>;
    };
    expect(patched.contribution.description).toBe("patched");
    expect(patched.contribution.totalAmount).toBe("9.0000");
    expect(patched.lines[0].amount).toBe("9.0000");

    await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}/post`, {
      method: "POST",
    });
    const patchPosted = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}`, {
      method: "PATCH",
      body: { description: "no-go" },
    });
    expect(patchPosted.status).toBe(409);
    const body = (await patchPosted.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_draft");
  });

  it("DELETE /contributions/:id removes a draft and refuses on posted", async () => {
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
    const del = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const get = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}`);
    expect(get.status).toBe(404);

    // Now post one and try to delete: must be rejected.
    const create2 = await call(zoneA.slug, "/api/tenant/contributions", {
      method: "POST",
      body: {
        chapterId: zoneA.chapterId,
        sourceType: "manual",
        contributionDate: seededDate,
        lines: [{ givingTypeId: zoneA.givingTypeId, amount: "1.0000" }],
      },
    });
    const { contribution: c2 } = (await create2.json()) as { contribution: { id: string } };
    await call(zoneA.slug, `/api/tenant/contributions/${c2.id}/post`, { method: "POST" });
    const delPosted = await call(zoneA.slug, `/api/tenant/contributions/${c2.id}`, {
      method: "DELETE",
    });
    expect(delPosted.status).toBe(409);
    const body = (await delPosted.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_draft");
  });

  it("PATCH /contribution-batches/:id updates a draft and rejects on submitted", async () => {
    asUser(ownerA, "owner@example.com");
    const createBatch = await call(zoneA.slug, "/api/tenant/contribution-batches", {
      method: "POST",
      body: { chapterId: zoneA.chapterId, sourceType: "envelope" },
    });
    const { batch } = (await createBatch.json()) as { batch: { id: string } };

    const patch = await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}`, {
      method: "PATCH",
      body: { notes: "morning service" },
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { batch: { notes: string | null; status: string } };
    expect(patched.batch.notes).toBe("morning service");
    expect(patched.batch.status).toBe("draft");

    await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}/submit`, {
      method: "POST",
    });
    const patchSubmitted = await call(
      zoneA.slug,
      `/api/tenant/contribution-batches/${batch.id}`,
      { method: "PATCH", body: { notes: "too late" } },
    );
    expect(patchSubmitted.status).toBe(409);
    const body = (await patchSubmitted.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_draft");
  });

  it("GET /contribution-batches lists scoped batches and refuses cross-zone reads", async () => {
    asUser(ownerA, "owner@example.com");
    const createBatch = await call(zoneA.slug, "/api/tenant/contribution-batches", {
      method: "POST",
      body: { chapterId: zoneA.chapterId, sourceType: "manual" },
    });
    const { batch } = (await createBatch.json()) as { batch: { id: string } };

    const list = await call(zoneA.slug, "/api/tenant/contribution-batches");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: Array<{ id: string }>; total: number };
    expect(listBody.items.some((r) => r.id === batch.id)).toBe(true);

    const get = await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}`);
    expect(get.status).toBe(200);

    // Cross-zone GET via zoneB slug: ownerA has no binding in zoneB.
    const cross = await call(zoneB.slug, `/api/tenant/contribution-batches/${batch.id}`);
    expect(cross.status).toBe(403);
  });

  it("voiding a draft batch succeeds; voiding twice is rejected", async () => {
    asUser(ownerA, "owner@example.com");
    const createBatch = await call(zoneA.slug, "/api/tenant/contribution-batches", {
      method: "POST",
      body: { chapterId: zoneA.chapterId, sourceType: "manual" },
    });
    const { batch } = (await createBatch.json()) as { batch: { id: string } };
    const voided = await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}/void`, {
      method: "POST",
      body: { voidReason: "abandon" },
    });
    expect(voided.status).toBe(200);
    const again = await call(zoneA.slug, `/api/tenant/contribution-batches/${batch.id}/void`, {
      method: "POST",
      body: { voidReason: "again" },
    });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_transition");
  });

  it("chapter pastor (read-only) can GET a contribution but cannot DELETE it", async () => {
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

    asUser(pastorA, "pastor@example.com");
    const get = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}`);
    expect(get.status).toBe(200);
    const del = await call(zoneA.slug, `/api/tenant/contributions/${contribution.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(403);
  });

  // ─── Chapter-scope filter (requireChapterScope) ─────────────────────

  it("GET /contributions?chapterId=<other-zone> from zone admin → 404", async () => {
    // Hand-edited URL pointing at zone B's chapter. Previously: silently
    // empty result. Now: loud 404 chapter_not_found so the UI can react.
    asUser(ownerA, "owner@example.com");
    const res = await call(
      zoneA.slug,
      `/api/tenant/contributions?chapterId=${zoneB.chapterId}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("GET /contribution-batches?chapterId=<other-zone> from zone admin → 404", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(
      zoneA.slug,
      `/api/tenant/contribution-batches?chapterId=${zoneB.chapterId}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("GET /contributions?chapterId=<own-chapter> from chapter treasurer → 200", async () => {
    // Sanity for the `/church/*` happy path: the treasurer asks for their
    // own chapter and gets a 200 (not a 403).
    asUser(treasurerA, "treasurer@example.com");
    const res = await call(
      zoneA.slug,
      `/api/tenant/contributions?chapterId=${zoneA.chapterId}`,
    );
    expect(res.status).toBe(200);
  });
});
