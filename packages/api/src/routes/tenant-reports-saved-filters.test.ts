// packages/api/src/routes/tenant-reports-saved-filters.test.ts
// Phase 7 — coverage for the saved-filter sub-routes on the
// reports router. Verifies: CRUD happy paths, per-spec Zod
// validation rejecting bad filters, cross-user isolation, and
// cross-tenant isolation.
// RELEVANT FILES: packages/api/src/routes/tenant-reports.ts, packages/api/src/services/reports/saved-filters.ts

import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  auditEvents,
  chapters,
  members,
  savedReportFilters,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { ZONE_ROLES } from "@stewardledger/shared";
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
  memberId: string;
  ownerRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Saved-Filters Zone ${unique()}`,
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
      referenceCode: `SF${unique()}`.slice(0, 12),
      name: `SF Chapter ${unique()}`,
      dateFrom: "2024-01-01",
    })
    .returning({ id: chapters.id });
  const [member] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chapter.id,
      referenceCode: `SF${unique()}`.toUpperCase().slice(0, 10),
      firstName: "Saved",
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

function tenantUrl(slug: string, path: string): string {
  return `http://${slug}.${HOST_DOMAIN}${path}`;
}

async function call(
  slug: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
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

describe("tenant reports — saved filters", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let userA: string;
  let userA2: string;
  let userB: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("saved-filters.test.ts requires a *_test DATABASE_URL");
    }
    zoneA = await seedZone(`sf-rt-a-${unique()}`);
    zoneB = await seedZone(`sf-rt-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    userA = await seedUser(`sf-a+${unique()}@example.com`);
    userA2 = await seedUser(`sf-a2+${unique()}@example.com`);
    userB = await seedUser(`sf-b+${unique()}@example.com`);
    cleanupUserIds.push(userA, userA2, userB);

    await db.insert(userRoleBindings).values([
      { userId: userA, zoneId: zoneA.id, roleId: zoneA.ownerRoleId,
  roleScope: "zone",
},
      { userId: userA2, zoneId: zoneA.id, roleId: zoneA.ownerRoleId,
  roleScope: "zone",
},
      { userId: userB, zoneId: zoneB.id, roleId: zoneB.ownerRoleId,
  roleScope: "zone",
},
    ]);
  });

  afterAll(async () => {
    // The contribution triggers cascade through zones.id with ON
    // DELETE CASCADE; parallel test files calling `alter table
    // ... disable trigger` against the same trigger catalog deadlock
    // with our zone deletes. Wrap the cleanup in the same
    // advisory-lock-then-disable-then-delete pattern that
    // tenant-reports.test.ts uses so we serialise with them.
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
        // Clear domain rows that reference the zone with RESTRICT.
        // Tables with ON DELETE CASCADE (saved_report_filters,
        // user_role_bindings) clean up implicitly.
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

  const reportId = "member-statement";
  const validFilters = (memberId: string) => ({
    memberId,
    dateFrom: "2024-01-01",
    dateTo: "2024-12-31",
    includeVoided: false,
  });

  it("create + list round-trip the filter payload", async () => {
    asUser(userA, "a@test");
    const created = await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: { name: "Annual 2024", filters: validFilters(zoneA.memberId) },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      savedFilter: { id: string; name: string; filters: Record<string, unknown> };
    };
    expect(createdBody.savedFilter.name).toBe("Annual 2024");
    expect(createdBody.savedFilter.filters).toMatchObject({
      memberId: zoneA.memberId,
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
    });

    const listed = await call(
      zoneA.slug,
      `/api/tenant/reports/${reportId}/saved-filters`,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { items: Array<{ id: string; name: string }> };
    expect(listedBody.items.map((i) => i.name)).toContain("Annual 2024");

    // Audit row written.
    const events = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.zoneId, zoneA.id),
          eq(auditEvents.entityType, "saved_report_filter"),
          eq(auditEvents.entityId, createdBody.savedFilter.id),
        ),
      );
    expect(events.map((e) => e.action)).toEqual(["saved_report_filter.create"]);
  });

  it("rejects a payload that fails the report's Zod schema (dateFrom > dateTo)", async () => {
    asUser(userA, "a@test");
    const res = await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: {
        name: "Bad window",
        filters: {
          memberId: zoneA.memberId,
          dateFrom: "2024-12-31",
          dateTo: "2024-01-01",
        },
      },
    });
    // member-statement's schema enforces dateFrom <= dateTo via .refine
    // -> ReportError("invalid_filters") -> 400.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_filters");
  });

  it("rejects an unknown report id with 404", async () => {
    asUser(userA, "a@test");
    const res = await call(zoneA.slug, "/api/tenant/reports/no-such-report/saved-filters");
    expect(res.status).toBe(404);
  });

  it("409s on duplicate name (case-insensitive)", async () => {
    asUser(userA, "a@test");
    const name = `Dup-${unique()}`;
    const first = await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: { name, filters: validFilters(zoneA.memberId) },
    });
    expect(first.status).toBe(201);
    const second = await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: {
        name: name.toUpperCase(), // unique index uses lower(name)
        filters: validFilters(zoneA.memberId),
      },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("duplicate_name");
  });

  it("PATCH renames and replaces filters; audited", async () => {
    asUser(userA, "a@test");
    const created = await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: { name: `Rename-${unique()}`, filters: validFilters(zoneA.memberId) },
    });
    const id = ((await created.json()) as { savedFilter: { id: string } }).savedFilter.id;

    const renamed = await call(
      zoneA.slug,
      `/api/tenant/reports/${reportId}/saved-filters/${id}`,
      {
        method: "PATCH",
        body: {
          name: `Renamed-${unique()}`,
          filters: {
            memberId: zoneA.memberId,
            dateFrom: "2025-01-01",
            dateTo: "2025-06-30",
            includeVoided: true,
          },
        },
      },
    );
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as {
      savedFilter: { name: string; filters: Record<string, unknown> };
    };
    expect(renamedBody.savedFilter.filters).toMatchObject({
      dateFrom: "2025-01-01",
      dateTo: "2025-06-30",
      includeVoided: true,
    });

    const events = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.zoneId, zoneA.id),
          eq(auditEvents.entityType, "saved_report_filter"),
          eq(auditEvents.entityId, id),
        ),
      );
    expect(events.map((e) => e.action).sort()).toEqual([
      "saved_report_filter.create",
      "saved_report_filter.update",
    ]);
  });

  it("DELETE removes the row + writes a delete audit", async () => {
    asUser(userA, "a@test");
    const created = await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: { name: `Del-${unique()}`, filters: validFilters(zoneA.memberId) },
    });
    const id = ((await created.json()) as { savedFilter: { id: string } }).savedFilter.id;
    const deleted = await call(
      zoneA.slug,
      `/api/tenant/reports/${reportId}/saved-filters/${id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    const [row] = await db
      .select()
      .from(savedReportFilters)
      .where(eq(savedReportFilters.id, id));
    expect(row).toBeUndefined();
    // 404 on second delete.
    const second = await call(
      zoneA.slug,
      `/api/tenant/reports/${reportId}/saved-filters/${id}`,
      { method: "DELETE" },
    );
    expect(second.status).toBe(404);
  });

  it("isolates saved filters across users in the same zone", async () => {
    asUser(userA, "a@test");
    await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: { name: `UserA-${unique()}`, filters: validFilters(zoneA.memberId) },
    });

    asUser(userA2, "a2@test");
    const listed = await call(
      zoneA.slug,
      `/api/tenant/reports/${reportId}/saved-filters`,
    );
    const items = ((await listed.json()) as { items: Array<{ name: string }> }).items;
    // userA2 sees their own filters only \u2014 nothing belonging to userA.
    expect(items.every((i) => !i.name.startsWith("UserA-"))).toBe(true);
  });

  it("isolates saved filters across zones (cross-tenant fuzz)", async () => {
    asUser(userA, "a@test");
    const named = `CrossZone-${unique()}`;
    await call(zoneA.slug, `/api/tenant/reports/${reportId}/saved-filters`, {
      method: "POST",
      body: { name: named, filters: validFilters(zoneA.memberId) },
    });

    // userB on zoneB lists \u2014 must not see the zoneA row.
    asUser(userB, "b@test");
    const listed = await call(
      zoneB.slug,
      `/api/tenant/reports/${reportId}/saved-filters`,
    );
    expect(listed.status).toBe(200);
    const items = ((await listed.json()) as { items: Array<{ name: string }> }).items;
    expect(items.find((i) => i.name === named)).toBeUndefined();
  });
});
