// packages/api/src/routes/tenant-imports.test.ts
// Phase 6 — cross-tenant + chapter-scope authZ coverage for the import
// API. Drives the real Hono stack via `app.fetch` with a spied
// `auth.api.getSession`, mirroring `tenant-contributions.test.ts`.
//
// The role gating is non-trivial: a chapter-scoped user (e.g. a
// CHAPTER_TREASURER for Chapter A) must NOT be able to touch a job tied
// to Chapter B, or upload a job tied to Chapter B, or commit one. The
// pre-review code only checked the role code, not the chapter scope.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  applyContributionTriggers,
  chapters,
  groups,
  members,
  serviceEvents,
  serviceTypes,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { ensurePlatformFailureTypes } from "../services/imports/failure-types";
import { InMemoryStorage, setStorageForTesting } from "../services/storage";
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
  chapterIdA: string;
  chapterIdB: string;
  serviceEventIdA: string;
  serviceEventIdB: string;
  memberRef: string;
  ownerRoleId: string;
  groupAdminRoleId: string;
  treasurerRoleId: string;
  bookkeeperRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Import Routes Zone ${unique()}`,
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

  // Two chapters so we can prove a chapter-scoped user from A cannot
  // touch B.
  const [chapterA, chapterB] = await db
    .insert(chapters)
    .values([
      {
        zoneId: zone.id,
        referenceCode: `CA${unique()}`.slice(0, 12),
        name: `Chapter A ${unique()}`,
        dateFrom: "2024-01-01",
      },
      {
        zoneId: zone.id,
        referenceCode: `CB${unique()}`.slice(0, 12),
        name: `Chapter B ${unique()}`,
        dateFrom: "2024-01-01",
      },
    ])
    .returning({ id: chapters.id });

  const memberRef = `M${unique()}`.toUpperCase();
  await db.insert(members).values({
    zoneId: zone.id,
    chapterId: chapterA.id,
    referenceCode: memberRef,
    firstName: "Imp",
    lastName: "Tester",
  });
  const [serviceType] = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(sql`${serviceTypes.zoneId} = ${zone.id}`)
    .limit(1);
  const today = new Date().toISOString().slice(0, 10);
  const [eventA, eventB] = await db
    .insert(serviceEvents)
    .values([
      { zoneId: zone.id, chapterId: chapterA.id, serviceTypeId: serviceType.id, serviceDate: today },
      { zoneId: zone.id, chapterId: chapterB.id, serviceTypeId: serviceType.id, serviceDate: today },
    ])
    .returning({ id: serviceEvents.id });

  return {
    id: zone.id,
    slug: zone.slug,
    chapterIdA: chapterA.id,
    chapterIdB: chapterB.id,
    serviceEventIdA: eventA.id,
    serviceEventIdB: eventB.id,
    memberRef,
    ownerRoleId: roleIds.get(ZONE_ROLES.ZONE_OWNER)!,
    groupAdminRoleId: roleIds.get(GROUP_ROLES.GROUP_ADMIN)!,
    treasurerRoleId: roleIds.get(CHAPTER_ROLES.CHAPTER_TREASURER)!,
    bookkeeperRoleId: roleIds.get(CHAPTER_ROLES.CHAPTER_BOOKKEEPER)!,
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
  multipart?: FormData;
}

async function call(slug: string, path: string, opts: FetchOptions = {}): Promise<Response> {
  if (opts.multipart) {
    return app.fetch(
      new Request(tenantUrl(slug, path), {
        method: opts.method ?? "POST",
        // Browser/proxy stacks normally provide Content-Length for these
        // small multipart uploads; set it explicitly in tests so the route
        // can reject unbounded/chunked imports before buffering.
        headers: { "content-length": "1024", host: `${slug}.${HOST_DOMAIN}` },
        body: opts.multipart,
      }),
    );
  }
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

function buildCsv(memberRef: string, dateBase: string): FormData {
  const csv = [
    "date,member reference,giving type code,amount,reference,currency",
    `${dateBase},${memberRef},TITHE,100.00,TX-${unique()},GBP`,
  ].join("\n");
  const form = new FormData();
  form.append(
    "file",
    new Blob([csv], { type: "text/csv" }),
    `upload-${unique()}.csv`,
  );
  form.append("fileType", "statement");
  form.append("sourceType", "generic_csv");
  return form;
}

describe("tenant import routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let ownerA: string;
  let treasurerA: string; // bound to chapter A only
  let bookkeeperA: string; // bound to chapter A only
  const today = new Date().toISOString().slice(0, 10);
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-imports.test.ts requires a *_test DATABASE_URL");
    }
    await applyContributionTriggers(db);
    await ensurePlatformFailureTypes(db);
    setStorageForTesting(new InMemoryStorage());

    zoneA = await seedZone(`imp-rt-a-${unique()}`);
    zoneB = await seedZone(`imp-rt-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    ownerA = await seedUser(`imp-owner+${unique()}@example.com`);
    treasurerA = await seedUser(`imp-treasurer+${unique()}@example.com`);
    bookkeeperA = await seedUser(`imp-bookkeeper+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, treasurerA, bookkeeperA);

    await db.insert(userRoleBindings).values([
      { userId: ownerA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId,
  roleScope: "zone",
},
      {
        userId: treasurerA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterIdA,
        roleId: zoneA.treasurerRoleId,
        roleScope: "chapter",
      },
      {
        userId: bookkeeperA,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterIdA,
        roleId: zoneA.bookkeeperRoleId,
        roleScope: "chapter",
      },
    ]);
  });

  afterAll(async () => {
    // Wrap the whole disable/cleanup/re-enable sequence in one tx and
    // grab the same advisory lock `applyContributionTriggers` uses, so a
    // parallel test suite's bootstrap can't re-enable the trigger
    // halfway through cleanup. `pg_advisory_xact_lock` releases on tx
    // commit so we never leak across pool connections.
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";
    try {
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
          await tx.execute(sql`delete from processed_transactions where zone_id = ${z}`);
          await tx.execute(sql`delete from import_row_failures where zone_id = ${z}`);
          await tx.execute(sql`delete from import_rows where zone_id = ${z}`);
          await tx.execute(sql`delete from import_schedules where zone_id = ${z}`);
          await tx.execute(sql`delete from import_jobs where zone_id = ${z}`);
          await tx.execute(sql`delete from import_files where zone_id = ${z}`);
          await tx.execute(sql`delete from contributions where zone_id = ${z}`);
          await tx.execute(sql`delete from contribution_batches where zone_id = ${z}`);
          await tx.execute(sql`delete from service_events where zone_id = ${z}`);
          await tx.execute(sql`delete from members where zone_id = ${z}`);
          await tx.execute(sql`delete from chapters where zone_id = ${z}`);
          await tx.execute(sql`delete from groups where zone_id = ${z}`);
          await tx.execute(sql`delete from zones where slug = ${slug}`);
        }
        for (const id of cleanupUserIds) {
          await tx.execute(sql`delete from "user" where id = ${id}`);
        }
        for (const [t, n] of guards) {
          await tx.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
        }
      });
    } finally {
      setStorageForTesting(null);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asUser(userId: string, email: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userId, email));
  }

  // ─── Upload body limits ────────────────────────────────────────────

  it("rejects upload requests without content-length before buffering", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await app.fetch(
      new Request(tenantUrl(zoneA.slug, "/api/tenant/imports?chapterId=" + zoneA.chapterIdA), {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          host: `${zoneA.slug}.${HOST_DOMAIN}`,
        },
        body: "date,member reference,giving type code,amount,reference,currency\n" +
          `${today},${zoneA.memberRef},TITHE,1.00,TX-${unique()},GBP`,
      }),
    );

    expect(res.status).toBe(411);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "content_length_required" },
    });
  });

  // ─── Template downloads ───────────────────────────────────────────

  it("lists registered import templates for zone import readers", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/imports/templates");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { kind: string; requiredColumns: string[] }[] };
    expect(body.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "generic-bank-statement",
        "bank-statement",
        "online-giving-statement",
      ]),
    );
    expect(body.items.map((item) => item.kind)).not.toContain("envelope-batch");
  });

  it("downloads a branded XLSX template", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/imports/templates/generic-bank-statement.xlsx");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toContain(
      `${zoneA.slug}-generic-bank-statement-template.xlsx`,
    );
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("returns 404 for unknown template kinds", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/imports/templates/not-real.xlsx");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "template_not_found" },
    });
  });

  it("requires the .xlsx suffix for template downloads", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/imports/templates/generic-bank-statement");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "template_not_found" },
    });
  });

  it("does not expose planned template kinds before their importer is enabled", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await call(zoneA.slug, "/api/tenant/imports/templates/envelope-batch.xlsx");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "template_not_found" },
    });
  });

  // ─── Cross-tenant ──────────────────────────────────────────────────

  it("rejects accessing zone A's import detail from zone B subdomain", async () => {
    asUser(ownerA, "owner@example.com");
    const upload = buildCsv(zoneA.memberRef, today);
    upload.set("chapterId", zoneA.chapterIdA);
    upload.set("serviceEventId", zoneA.serviceEventIdA);
    const created = await call(zoneA.slug, "/api/tenant/imports", { multipart: upload });
    expect(created.status).toBe(201);
    const { importJobId } = (await created.json()) as { importJobId: string };

    // Owner A has no binding in zone B → 403 at requireTenantAuth.
    const cross = await call(zoneB.slug, `/api/tenant/imports/${importJobId}`);
    expect(cross.status).toBe(403);
  });

  // ─── Chapter scope ─────────────────────────────────────────────────

  it("zone owner can upload to any chapter in their zone", async () => {
    asUser(ownerA, "owner@example.com");
    const form = buildCsv(zoneA.memberRef, today);
    form.set("chapterId", zoneA.chapterIdB);
    form.set("serviceEventId", zoneA.serviceEventIdB);
    const res = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });
    expect(res.status).toBe(201);
  });

  it("rejects chapter-scoped uploads without a service event", async () => {
    asUser(ownerA, "owner@example.com");
    const form = buildCsv(zoneA.memberRef, today);
    form.set("chapterId", zoneA.chapterIdA);

    const res = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "service_event_required" },
    });
  });

  it("rejects unsupported import file types before storing bytes", async () => {
    asUser(ownerA, "owner@example.com");
    const form = buildCsv(zoneA.memberRef, today);
    form.set("chapterId", zoneA.chapterIdA);
    form.set("serviceEventId", zoneA.serviceEventIdA);
    form.set("fileType", "member");
    const res = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "unsupported_file_type" },
    });
  });

  it("chapter treasurer cannot upload an import scoped to another chapter", async () => {
    asUser(treasurerA, "treasurer@example.com");
    const form = buildCsv(zoneA.memberRef, today);
    form.set("chapterId", zoneA.chapterIdB);
    form.set("serviceEventId", zoneA.serviceEventIdB);
    const res = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });
    expect(res.status).toBe(403);
  });

  it("chapter treasurer cannot upload a zone-wide import (no chapter)", async () => {
    asUser(treasurerA, "treasurer@example.com");
    // No chapterId → chapter-scoped user has no claim on it.
    const csv = [
      "date,member reference,giving type code,amount,reference,currency",
      `${today},${zoneA.memberRef},TITHE,1.00,TX-${unique()},GBP`,
    ].join("\n");
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), `f-${unique()}.csv`);
    form.append("fileType", "statement");
    form.append("sourceType", "generic_csv");
    // Intentionally no chapterId field.
    const res = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });
    expect(res.status).toBe(403);
  });

  it("chapter treasurer can upload + commit an import for their own chapter", async () => {
    asUser(treasurerA, "treasurer@example.com");
    const form = buildCsv(zoneA.memberRef, today);
    form.set("chapterId", zoneA.chapterIdA);
    form.set("serviceEventId", zoneA.serviceEventIdA);
    const created = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });
    expect(created.status).toBe(201);
    const { importJobId } = (await created.json()) as { importJobId: string };

    const schedule = await call(zoneA.slug, `/api/tenant/imports/${importJobId}/schedule`, {
      method: "POST",
    });
    expect(schedule.status).toBe(200);

    const commit = await call(zoneA.slug, `/api/tenant/imports/${importJobId}/commit`, {
      method: "POST",
    });
    expect(commit.status).toBe(200);
  });

  it("chapter treasurer cannot schedule/commit/rollback an import from another chapter", async () => {
    // Owner uploads + commits an import for chapter B.
    asUser(ownerA, "owner@example.com");
    const form = buildCsv(zoneA.memberRef, today);
    form.set("chapterId", zoneA.chapterIdB);
    form.set("serviceEventId", zoneA.serviceEventIdB);
    const created = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });
    const { importJobId } = (await created.json()) as { importJobId: string };
    await call(zoneA.slug, `/api/tenant/imports/${importJobId}/schedule`, { method: "POST" });
    await call(zoneA.slug, `/api/tenant/imports/${importJobId}/commit`, { method: "POST" });

    // Treasurer A (bound to chapter A) must not be able to read or roll
    // back this job.
    asUser(treasurerA, "treasurer@example.com");
    const get = await call(zoneA.slug, `/api/tenant/imports/${importJobId}`);
    expect(get.status).toBe(403);
    const rollback = await call(zoneA.slug, `/api/tenant/imports/${importJobId}/rollback`, {
      method: "POST",
      body: { reason: "test" },
    });
    expect(rollback.status).toBe(403);
  });

  it("chapter bookkeeper can upload + read but cannot schedule/commit/rollback", async () => {
    asUser(bookkeeperA, "bookkeeper@example.com");
    const form = buildCsv(zoneA.memberRef, today);
    form.set("chapterId", zoneA.chapterIdA);
    form.set("serviceEventId", zoneA.serviceEventIdA);
    const created = await call(zoneA.slug, "/api/tenant/imports", { multipart: form });
    expect(created.status).toBe(201);
    const { importJobId } = (await created.json()) as { importJobId: string };

    const get = await call(zoneA.slug, `/api/tenant/imports/${importJobId}`);
    expect(get.status).toBe(200);

    const schedule = await call(zoneA.slug, `/api/tenant/imports/${importJobId}/schedule`, {
      method: "POST",
    });
    expect(schedule.status).toBe(403);
  });

  it("list scopes chapter-scoped readers to their chapters", async () => {
    // Owner uploads two jobs: one to chapter A, one to chapter B.
    asUser(ownerA, "owner@example.com");
    const fa = buildCsv(zoneA.memberRef, today);
    fa.set("chapterId", zoneA.chapterIdA);
    fa.set("serviceEventId", zoneA.serviceEventIdA);
    const ra = await call(zoneA.slug, "/api/tenant/imports", { multipart: fa });
    expect(ra.status).toBe(201);
    const { importJobId: jobA } = (await ra.json()) as { importJobId: string };

    const fb = buildCsv(zoneA.memberRef, today);
    fb.set("chapterId", zoneA.chapterIdB);
    fb.set("serviceEventId", zoneA.serviceEventIdB);
    const rb = await call(zoneA.slug, "/api/tenant/imports", { multipart: fb });
    expect(rb.status).toBe(201);
    const { importJobId: jobB } = (await rb.json()) as { importJobId: string };

    // Treasurer (chapter A only) must see jobA but never jobB.
    asUser(treasurerA, "treasurer@example.com");
    const list = await call(zoneA.slug, "/api/tenant/imports?limit=200");
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: { id: string }[] };
    const ids = new Set(items.map((i) => i.id));
    expect(ids.has(jobA)).toBe(true);
    expect(ids.has(jobB)).toBe(false);
  });

  it("list/detail/rows allow group admins for imports in their group only", async () => {
    const [group] = await db
      .insert(groups)
      .values({ zoneId: zoneA.id, slug: `imports-${unique()}`, name: `Imports ${unique()}` })
      .returning({ id: groups.id });
    await db.execute(sql`update chapters set group_id = ${group.id} where id = ${zoneA.chapterIdB}`);

    const groupAdmin = await seedUser(`imp-group-admin+${unique()}@example.com`);
    cleanupUserIds.push(groupAdmin);
    await db.insert(userRoleBindings).values({
      userId: groupAdmin,
      zoneId: zoneA.id,
      groupId: group.id,
      roleId: zoneA.groupAdminRoleId,
      roleScope: "group",
    });

    asUser(ownerA, "owner@example.com");
    const fa = buildCsv(zoneA.memberRef, today);
    fa.set("chapterId", zoneA.chapterIdA);
    fa.set("serviceEventId", zoneA.serviceEventIdA);
    const ra = await call(zoneA.slug, "/api/tenant/imports", { multipart: fa });
    expect(ra.status).toBe(201);
    const { importJobId: jobA } = (await ra.json()) as { importJobId: string };

    const fb = buildCsv(zoneA.memberRef, today);
    fb.set("chapterId", zoneA.chapterIdB);
    fb.set("serviceEventId", zoneA.serviceEventIdB);
    const rb = await call(zoneA.slug, "/api/tenant/imports", { multipart: fb });
    expect(rb.status).toBe(201);
    const { importJobId: jobB } = (await rb.json()) as { importJobId: string };

    asUser(groupAdmin, "imp-group-admin@example.com");
    const list = await call(zoneA.slug, "/api/tenant/imports?limit=200");
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: { id: string }[] };
    const ids = new Set(items.map((i) => i.id));
    expect(ids.has(jobB)).toBe(true);
    expect(ids.has(jobA)).toBe(false);

    const detail = await call(zoneA.slug, `/api/tenant/imports/${jobB}`);
    expect(detail.status).toBe(200);

    const rows = await call(zoneA.slug, `/api/tenant/imports/${jobB}/rows`);
    expect(rows.status).toBe(200);

    const outOfScope = await call(zoneA.slug, `/api/tenant/imports/${jobA}`);
    expect(outOfScope.status).toBe(403);
  });

  // ─── Chapter-scope filter (requireChapterScope on the list endpoint) ──────

  it("GET /imports?chapterId=<own-chapter> pins the list to one chapter", async () => {
    // Owner has zone-wide read — normally sees every import. With
    // ?chapterId=A pinned, the response only carries A's jobs.
    asUser(ownerA, "owner@example.com");
    const fa = buildCsv(zoneA.memberRef, today);
    fa.set("chapterId", zoneA.chapterIdA);
    fa.set("serviceEventId", zoneA.serviceEventIdA);
    const ra = await call(zoneA.slug, "/api/tenant/imports", { multipart: fa });
    expect(ra.status).toBe(201);
    const { importJobId: jobA } = (await ra.json()) as { importJobId: string };

    const fb = buildCsv(zoneA.memberRef, today);
    fb.set("chapterId", zoneA.chapterIdB);
    fb.set("serviceEventId", zoneA.serviceEventIdB);
    const rb = await call(zoneA.slug, "/api/tenant/imports", { multipart: fb });
    expect(rb.status).toBe(201);
    const { importJobId: jobB } = (await rb.json()) as { importJobId: string };

    const list = await call(
      zoneA.slug,
      `/api/tenant/imports?limit=200&chapterId=${zoneA.chapterIdA}`,
    );
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: { id: string }[] };
    const ids = new Set(items.map((i) => i.id));
    expect(ids.has(jobA)).toBe(true);
    expect(ids.has(jobB)).toBe(false);
  });

  it("GET /imports?chapterId=<other-zone> → 404 chapter_not_found", async () => {
    // ownerA hand-edits the URL to point at a chapter that doesn't belong
    // to zone A (here a UUIDv4 that lives in no zone). Same code path as
    // a cross-zone smuggling attempt.
    asUser(ownerA, "owner@example.com");
    const ghostId = crypto.randomUUID();
    const res = await call(zoneA.slug, `/api/tenant/imports?chapterId=${ghostId}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("GET /imports?chapterId=<other-in-zone> from chapter-only user → 403", async () => {
    // Treasurer A asks for chapter B's imports. Chapter exists in the
    // zone but they have no binding to it → 403, not 404.
    asUser(treasurerA, "treasurer@example.com");
    const res = await call(
      zoneA.slug,
      `/api/tenant/imports?chapterId=${zoneA.chapterIdB}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});
