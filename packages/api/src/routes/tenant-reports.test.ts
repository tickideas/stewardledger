// packages/api/src/routes/tenant-reports.test.ts
// Phase 7 — route-layer coverage for /api/tenant/reports:
//   • Listing requires any reader role.
//   • Data endpoint runs with sensible filters.
//   • Export endpoint is gated to finance-tier roles — a zone_auditor
//     can READ on screen but cannot DOWNLOAD an Excel artefact.
//   • Cross-tenant: zone A's reports cannot be requested from zone B.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyContributionTriggers,
  chapters,
  members,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
void CHAPTER_ROLES;
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
  chapterIdA: string;
  chapterIdB: string;
  memberId: string;
  ownerRoleId: string;
  auditorRoleId: string;
  treasurerRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Reports Routes Zone ${unique()}`,
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

  const [chapterA, chapterB] = await db
    .insert(chapters)
    .values([
      {
        zoneId: zone.id,
        referenceCode: `CR${unique()}`.slice(0, 12),
        name: `Reports Chapter A ${unique()}`,
        dateFrom: "2024-01-01",
      },
      {
        zoneId: zone.id,
        referenceCode: `CR${unique()}`.slice(0, 12),
        name: `Reports Chapter B ${unique()}`,
        dateFrom: "2024-01-01",
      },
    ])
    .returning({ id: chapters.id });

  const [member] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chapterA.id,
      referenceCode: `MR${unique()}`.toUpperCase().slice(0, 10),
      firstName: "Rep",
      lastName: "Member",
    })
    .returning({ id: members.id });

  return {
    id: zone.id,
    slug: zone.slug,
    chapterIdA: chapterA.id,
    chapterIdB: chapterB.id,
    memberId: member.id,
    ownerRoleId: roleIds.get(ZONE_ROLES.ZONE_OWNER)!,
    auditorRoleId: roleIds.get(ZONE_ROLES.ZONE_AUDITOR)!,
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

function tenantUrl(slug: string, path: string): string {
  return `http://${slug}.${HOST_DOMAIN}${path}`;
}

async function get(slug: string, path: string): Promise<Response> {
  return app.fetch(
    new Request(tenantUrl(slug, path), {
      method: "GET",
      headers: { host: `${slug}.${HOST_DOMAIN}` },
    }),
  );
}

describe("tenant reports routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let ownerA: string;
  let auditorA: string;
  let treasurerB: string; // bound to zoneA chapter B only
  let nobody: string; // authenticated but with no bindings in zoneA
  const today = new Date().toISOString().slice(0, 10);
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-reports.test.ts requires a *_test DATABASE_URL");
    }
    await applyContributionTriggers(db);

    zoneA = await seedZone(`rpt-rt-a-${unique()}`);
    zoneB = await seedZone(`rpt-rt-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    ownerA = await seedUser(`rpt-owner+${unique()}@example.com`);
    auditorA = await seedUser(`rpt-auditor+${unique()}@example.com`);
    treasurerB = await seedUser(`rpt-treasurerB+${unique()}@example.com`);
    nobody = await seedUser(`rpt-nobody+${unique()}@example.com`);
    cleanupUserIds.push(ownerA, auditorA, treasurerB, nobody);

    // nobody is intentionally absent from userRoleBindings: they have a
    // session but no role in zoneA, so the requireTenantAuth middleware
    // surfaces a 403 before the route handler ever runs.
    await db.insert(userRoleBindings).values([
      { userId: ownerA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId },
      { userId: auditorA, zoneId: zoneA.id, roleId: zoneA.auditorRoleId },
      {
        userId: treasurerB,
        zoneId: zoneA.id,
        chapterId: zoneA.chapterIdB,
        roleId: zoneA.treasurerRoleId,
      },
    ]);
  });

  afterAll(async () => {
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

  it("lists the registered reports for an auditor (read-only)", async () => {
    asUser(auditorA, "auditor@example.com");
    const res = await get(zoneA.slug, "/api/tenant/reports");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((r) => r.id).sort();
    expect(ids).toEqual([
      "import-reconciliation",
      "member-list",
      "member-statement",
    ]);
  });

  it("returns member-statement data for an owner", async () => {
    asUser(ownerA, "owner@example.com");
    const params = new URLSearchParams({
      memberId: zoneA.memberId,
      dateFrom: today,
      dateTo: today,
    });
    const res = await get(
      zoneA.slug,
      `/api/tenant/reports/member-statement/data?${params.toString()}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: unknown[];
      subtotals: unknown[];
      columns: unknown[];
    };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(Array.isArray(body.columns)).toBe(true);
    expect(body.columns.length).toBeGreaterThan(0);
  });

  it("rejects an auditor's export request (forbidden_export)", async () => {
    asUser(auditorA, "auditor@example.com");
    const params = new URLSearchParams({
      memberId: zoneA.memberId,
      dateFrom: today,
      dateTo: today,
    });
    const res = await get(
      zoneA.slug,
      `/api/tenant/reports/member-statement/export.xlsx?${params.toString()}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden_export");
  });

  it("allows an owner's export and returns an xlsx response", async () => {
    asUser(ownerA, "owner@example.com");
    const params = new URLSearchParams({
      memberId: zoneA.memberId,
      dateFrom: today,
      dateTo: today,
    });
    const res = await get(
      zoneA.slug,
      `/api/tenant/reports/member-statement/export.xlsx?${params.toString()}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toMatch(/attachment;.*\.xlsx/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // XLSX is a zip; the PK signature is the canonical sanity check.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("rejects a cross-tenant export attempt", async () => {
    asUser(ownerA, "owner@example.com");
    // Owner of A has no binding in B → 403 at requireTenantAuth.
    const res = await get(
      zoneB.slug,
      `/api/tenant/reports/member-statement/export.xlsx?memberId=${zoneA.memberId}&dateFrom=${today}&dateTo=${today}`,
    );
    expect(res.status).toBe(403);
  });

  it("422-flavoured invalid filters surface a 400", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await get(
      zoneA.slug,
      "/api/tenant/reports/member-statement/data?memberId=not-a-uuid&dateFrom=2025-01-01&dateTo=2025-12-31",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_filters");
  });

  it("404 for an unknown report id", async () => {
    asUser(ownerA, "owner@example.com");
    const res = await get(
      zoneA.slug,
      "/api/tenant/reports/no-such-report/data",
    );
    expect(res.status).toBe(404);
  });

  it("403 when an authenticated user has no bindings in the zone", async () => {
    asUser(nobody, "nobody@example.com");
    const res = await get(zoneA.slug, "/api/tenant/reports");
    // requireTenantAuth fires before the reports gate, so the body code
    // is the generic "forbidden" envelope rather than the report-
    // specific one.
    expect(res.status).toBe(403);
  });

  it("maps a per-spec accessCheck denial to 403 with the denial code", async () => {
    // treasurerB is bound to chapterB only; member is in chapterA. The
    // member-statement fetch path throws ReportError("forbidden"); the
    // route handler must surface that as a 403.
    asUser(treasurerB, "treasurerB@example.com");
    const params = new URLSearchParams({
      memberId: zoneA.memberId,
      dateFrom: today,
      dateTo: today,
    });
    const res = await get(
      zoneA.slug,
      `/api/tenant/reports/member-statement/data?${params.toString()}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("member-list accessCheck denies an out-of-scope chapter filter with 403", async () => {
    asUser(treasurerB, "treasurerB@example.com");
    // treasurerB is bound to chapterB only; ask for chapterA.
    const res = await get(
      zoneA.slug,
      `/api/tenant/reports/member-list/data?chapterId=${zoneA.chapterIdA}`,
    );
    expect(res.status).toBe(403);
  });
});
