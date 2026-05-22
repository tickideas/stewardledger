// packages/api/src/routes/tenant-reports-jobs.test.ts
// Phase 7 PR 1 \u2014 async report jobs route coverage.
// Tests the queue + worker + download endpoints; cross-user and
// cross-tenant isolation; bad-filter and forbidden rejections.
// The worker loop is started by `server.ts`, not by tests \u2014 we
// drive a single run via `runOnce(db)` so assertions don't race
// the poll interval.
// RELEVANT FILES: packages/api/src/routes/tenant-reports.ts, packages/api/src/services/reports/jobs.ts

import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZONE_ROLES } from "@stewardledger/shared";
import {
  auditEvents,
  chapters,
  members,
  reportJobs,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { runOnce } from "../services/reports/jobs";
import { seedZoneRoles } from "../services/role-seed";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const HOST_DOMAIN = "localhost";

interface SeededZone {
  id: string;
  slug: string;
  memberId: string;
  ownerRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Jobs Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const roleIds = await seedZoneRoles(db, zone.id);
  const [chapter] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `JB${unique()}`.slice(0, 12),
      name: `JB Chapter ${unique()}`,
      dateFrom: "2024-01-01",
    })
    .returning({ id: chapters.id });
  const [member] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chapter.id,
      referenceCode: `JB${unique()}`.toUpperCase().slice(0, 10),
      firstName: "Job",
      lastName: "Member",
    })
    .returning({ id: members.id });
  return {
    id: zone.id,
    slug: zone.slug,
    memberId: member.id,
    ownerRoleId: roleIds.get(ZONE_ROLES.ZONE_OWNER)!,
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

async function call(
  slug: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
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

describe("tenant reports \u2014 async jobs", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let userA: string;
  let userA2: string;
  let userB: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-reports-jobs.test.ts requires a *_test DATABASE_URL");
    }
    zoneA = await seedZone(`jb-rt-a-${unique()}`);
    zoneB = await seedZone(`jb-rt-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    userA = await seedUser(`jb-a+${unique()}@example.com`);
    userA2 = await seedUser(`jb-a2+${unique()}@example.com`);
    userB = await seedUser(`jb-b+${unique()}@example.com`);
    cleanupUserIds.push(userA, userA2, userB);

    await db.insert(userRoleBindings).values([
      { userId: userA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId },
      { userId: userA2, zoneId: zoneA.id, roleId: zoneA.ownerRoleId },
      { userId: userB, zoneId: zoneB.id, roleId: zoneB.ownerRoleId },
    ]);
  });

  afterAll(async () => {
    // Same advisory-lock cleanup the other reports tests use to
    // serialise against the contribution-trigger bootstrap.
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    const TRIGGER_BOOTSTRAP_LOCK_TAG =
      "stewardledger.applyContributionTriggers";
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
      );
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
      }
      for (const slug of cleanupSlugs) {
        const z = sql`(select id from zones where slug = ${slug})`;
        await tx.execute(sql`delete from members where zone_id = ${z}`);
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

  afterEach(async () => {
    vi.restoreAllMocks();
    // Each test posts jobs against shared zones; drain any rows
    // left in `queued` or `running` so a later test's `runOnce`
    // doesn't pick them up by accident.
    await db
      .delete(reportJobs)
      .where(eq(reportJobs.zoneId, zoneA.id));
    await db
      .delete(reportJobs)
      .where(eq(reportJobs.zoneId, zoneB.id));
  });

  function asUser(userId: string, email: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userId, email));
  }

  const reportId = "member-statement";
  const validFilters = (memberId: string) => ({
    memberId,
    dateFrom: "2024-01-01",
    dateTo: "2024-12-31",
    includeVoided: false,
  });

  it("queues a job; row persisted with parsed filters + create audit", async () => {
    asUser(userA, "a@test");
    const res = await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "xlsx", filters: validFilters(zoneA.memberId) },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      job: { id: string; status: string; format: string };
    };
    expect(body.job.status).toBe("queued");
    expect(body.job.format).toBe("xlsx");

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, body.job.id));
    expect(row.status).toBe("queued");
    expect(row.filters).toMatchObject({ memberId: zoneA.memberId });

    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.zoneId, zoneA.id),
          eq(auditEvents.entityType, "report_job"),
          eq(auditEvents.entityId, body.job.id),
        ),
      );
    expect(audits.map((a) => a.action)).toEqual(["report.job.create"]);
  });

  it("worker drains a queued job to completed + writes the artefact", async () => {
    asUser(userA, "a@test");
    const queued = await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "xlsx", filters: validFilters(zoneA.memberId) },
    });
    const jobId = ((await queued.json()) as { job: { id: string } }).job.id;

    // Drive the worker directly. The polling loop is started by
    // server.ts only; tests don't run it, so this is deterministic.
    const summary = await runOnce(db);
    expect(summary?.id).toBe(jobId);
    expect(summary?.status).toBe("completed");
    expect(summary?.rowCount).toBeGreaterThanOrEqual(0);
    expect(summary?.byteCount).toBeGreaterThan(0);

    const [row] = await db.select().from(reportJobs).where(eq(reportJobs.id, jobId));
    expect(row.status).toBe("completed");
    expect(row.storageKey).toMatch(new RegExp(`^${zoneA.id}/reports/`));
  });

  it("rejects a payload that fails the spec's Zod schema", async () => {
    asUser(userA, "a@test");
    const before = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.zoneId, zoneA.id));
    const res = await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: {
        format: "xlsx",
        filters: { memberId: zoneA.memberId, dateFrom: "2024-12-31", dateTo: "2024-01-01" },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_filters");
    // No row written — assert by row count, not by errorCode shape
    // (a partially-persisted row could have errorCode = null and
    //  still be a leak).
    const after = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.zoneId, zoneA.id));
    expect(after.length).toBe(before.length);
  });

  it("status endpoint returns the job; another user in the same zone gets 404", async () => {
    asUser(userA, "a@test");
    const queued = await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "xlsx", filters: validFilters(zoneA.memberId) },
    });
    const jobId = ((await queued.json()) as { job: { id: string } }).job.id;

    const own = await call(zoneA.slug, `/api/tenant/reports/jobs/${jobId}`);
    expect(own.status).toBe(200);

    asUser(userA2, "a2@test");
    const other = await call(zoneA.slug, `/api/tenant/reports/jobs/${jobId}`);
    expect(other.status).toBe(404);
  });

  it("download endpoint streams the artefact; 409 before completion", async () => {
    asUser(userA, "a@test");
    const queued = await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "xlsx", filters: validFilters(zoneA.memberId) },
    });
    const jobId = ((await queued.json()) as { job: { id: string } }).job.id;

    // Before the worker runs the job is queued, so download must
    // refuse with 409 not_ready.
    const earlyDownload = await call(
      zoneA.slug,
      `/api/tenant/reports/jobs/${jobId}/download`,
    );
    expect(earlyDownload.status).toBe(409);

    await runOnce(db);

    const ok = await call(zoneA.slug, `/api/tenant/reports/jobs/${jobId}/download`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("spreadsheetml");
    expect(ok.headers.get("content-disposition")).toMatch(/filename=/);
    const bytes = new Uint8Array(await ok.arrayBuffer());
    // XLSX is a zip; magic bytes "PK\x03\x04".
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("download endpoint returns 404 once the row's expires_at has passed", async () => {
    asUser(userA, "a@test");
    const queued = await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "xlsx", filters: validFilters(zoneA.memberId) },
    });
    const jobId = ((await queued.json()) as { job: { id: string } }).job.id;
    await runOnce(db);
    // Force-expire the row.
    await db
      .update(reportJobs)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(reportJobs.id, jobId));
    const res = await call(zoneA.slug, `/api/tenant/reports/jobs/${jobId}/download`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("expired");
  });

  it("isolates jobs across tenants \u2014 zone B's user can't see zone A's job", async () => {
    asUser(userA, "a@test");
    const queued = await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "xlsx", filters: validFilters(zoneA.memberId) },
    });
    const jobId = ((await queued.json()) as { job: { id: string } }).job.id;

    asUser(userB, "b@test");
    const res = await call(zoneB.slug, `/api/tenant/reports/jobs/${jobId}`);
    expect(res.status).toBe(404);
  });

  it("lists jobs filtered by reportId, newest first", async () => {
    asUser(userA, "a@test");
    await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "xlsx", filters: validFilters(zoneA.memberId) },
    });
    await call(zoneA.slug, `/api/tenant/reports/${reportId}/jobs`, {
      method: "POST",
      body: { format: "pdf", filters: validFilters(zoneA.memberId) },
    });

    const res = await call(
      zoneA.slug,
      `/api/tenant/reports/jobs?reportId=${reportId}&limit=10`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ reportId: string; createdAt: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items.every((j) => j.reportId === reportId)).toBe(true);
    // Newest first.
    const dates = body.items.map((j) => new Date(j.createdAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  // Quietly reference the desc helper so the import stays.
  void desc;
});
