// packages/api/src/routes/tenant-erasure.test.ts
// Phase 9 §6 — tenant-erasure router. Covers HTTP wiring, role
// gates, the recent-export gate for zone-scope, and the error
// shape contract.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZONE_ROLES } from "@stewardledger/shared";
import {
  chapters,
  erasureRequests,
  members,
  user as userTable,
  userRoleBindings,
  zoneExports,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { seedZoneRoles } from "../services/role-seed";
import { InMemoryStorage, setStorageForTesting } from "../services/storage";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const HOST_DOMAIN = "localhost";
const app = createApp();

interface SeededZone {
  id: string;
  slug: string;
  ownerRoleId: string;
  adminRoleId: string;
  auditorRoleId: string;
  memberId: string;
  exportId: string;
}

async function seedZoneWithMember(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Erasure Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const roles = await seedZoneRoles(db, zone.id);
  const [chap] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: "Erasure Chapter",
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  const [m] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chap.id,
      referenceCode: `M-${unique()}`,
      firstName: "TestPii",
      email: "pii@example.com",
    })
    .returning({ id: members.id });
  const [exp] = await db
    .insert(zoneExports)
    .values({
      zoneId: zone.id,
      status: "completed",
      storageKey: `${zone.id}/exports/2026/01/x-${unique()}.tar.gz`,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: zoneExports.id });
  return {
    id: zone.id,
    slug: zone.slug,
    ownerRoleId: roles.get(ZONE_ROLES.ZONE_OWNER)!,
    adminRoleId: roles.get(ZONE_ROLES.ZONE_ADMIN)!,
    auditorRoleId: roles.get(ZONE_ROLES.ZONE_AUDITOR)!,
    memberId: m.id,
    exportId: exp.id,
  };
}

async function seedUser(email: string): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({ id, email, emailVerified: true });
  return id;
}

async function bindUser(
  userId: string,
  zoneId: string,
  roleId: string,
): Promise<void> {
  await db.insert(userRoleBindings).values({
    userId,
    zoneId,
    roleId,
    roleScope: "zone",
  });
}

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

interface FetchOptions {
  method?: string;
  body?: unknown;
}

async function call(
  slug: string,
  path: string,
  opts: FetchOptions = {},
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

describe("tenant erasure router", () => {
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(() => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-erasure.test.ts requires a *_test DATABASE_URL");
    }
    setStorageForTesting(new InMemoryStorage());
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
      await db.execute(sql`delete from erasure_requests where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from zone_exports where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from member_addresses where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from members where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from chapters where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from user_role_bindings where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from roles where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
    setStorageForTesting(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asUser(userId: string, email: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(userId, email),
    );
  }

  describe("POST /members/:memberId/erasure-requests", () => {
    it("rejects an auditor (member-scope is owner / admin / finance_admin only)", async () => {
      const zone = await seedZoneWithMember(`er-aud-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-aud+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.auditorRoleId);
      asUser(u, `er-aud+${unique()}@example.com`);
      const res = await call(
        zone.slug,
        `/api/tenant/members/${zone.memberId}/erasure-requests`,
        { method: "POST", body: {} },
      );
      expect(res.status).toBe(403);
    });

    it("creates a member-scope request for an admin", async () => {
      const zone = await seedZoneWithMember(`er-mok-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-mok+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.adminRoleId);
      asUser(u, `er-mok+${unique()}@example.com`);
      const res = await call(
        zone.slug,
        `/api/tenant/members/${zone.memberId}/erasure-requests`,
        { method: "POST", body: { reason: "subject request" } },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        request: { scope: string; status: string; memberId: string };
      };
      expect(body.request.scope).toBe("member");
      expect(body.request.status).toBe("pending");
      expect(body.request.memberId).toBe(zone.memberId);
    });

    it("409s on duplicate-pending", async () => {
      const zone = await seedZoneWithMember(`er-dup-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-dup+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.ownerRoleId);
      asUser(u, `er-dup+${unique()}@example.com`);
      const first = await call(
        zone.slug,
        `/api/tenant/members/${zone.memberId}/erasure-requests`,
        { method: "POST", body: {} },
      );
      expect(first.status).toBe(201);
      const second = await call(
        zone.slug,
        `/api/tenant/members/${zone.memberId}/erasure-requests`,
        { method: "POST", body: {} },
      );
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe("duplicate_pending");
    });

    it("400s on invalid windowDays", async () => {
      const zone = await seedZoneWithMember(`er-win-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-win+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.ownerRoleId);
      asUser(u, `er-win+${unique()}@example.com`);
      const res = await call(
        zone.slug,
        `/api/tenant/members/${zone.memberId}/erasure-requests`,
        { method: "POST", body: { windowDays: 0 } },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /zones/erasure-requests", () => {
    it("rejects admin (owner-only)", async () => {
      const zone = await seedZoneWithMember(`er-zna-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-zna+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.adminRoleId);
      asUser(u, `er-zna+${unique()}@example.com`);
      const res = await call(zone.slug, "/api/tenant/zones/erasure-requests", {
        method: "POST",
        body: { confirmExportId: zone.exportId },
      });
      expect(res.status).toBe(403);
    });

    it("400s without confirmExportId in the body", async () => {
      const zone = await seedZoneWithMember(`er-zce-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-zce+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.ownerRoleId);
      asUser(u, `er-zce+${unique()}@example.com`);
      const res = await call(zone.slug, "/api/tenant/zones/erasure-requests", {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(400);
    });

    it("422s on a stale confirmExportId (>7 days old)", async () => {
      const zone = await seedZoneWithMember(`er-zst-${unique()}`);
      cleanupSlugs.push(zone.slug);
      // Back-date the export's created_at past the 7-day window.
      await db
        .update(zoneExports)
        .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
        .where(sql`id = ${zone.exportId}`);
      const u = await seedUser(`er-zst+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.ownerRoleId);
      asUser(u, `er-zst+${unique()}@example.com`);
      const res = await call(zone.slug, "/api/tenant/zones/erasure-requests", {
        method: "POST",
        body: { confirmExportId: zone.exportId },
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("recent_export_required");
    });

    it("creates a zone-scope request for an owner with a recent export", async () => {
      const zone = await seedZoneWithMember(`er-zok-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-zok+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.ownerRoleId);
      asUser(u, `er-zok+${unique()}@example.com`);
      const res = await call(zone.slug, "/api/tenant/zones/erasure-requests", {
        method: "POST",
        body: { confirmExportId: zone.exportId, reason: "tenant cancelled" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        request: { scope: string; status: string };
      };
      expect(body.request.scope).toBe("zone");
      expect(body.request.status).toBe("pending");
    });
  });

  describe("DELETE /erasure-requests/:id + GET /erasure-requests", () => {
    it("cancels a pending request and lists the cancelled status", async () => {
      const zone = await seedZoneWithMember(`er-can-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-can+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.ownerRoleId);
      asUser(u, `er-can+${unique()}@example.com`);
      const created = await call(
        zone.slug,
        `/api/tenant/members/${zone.memberId}/erasure-requests`,
        { method: "POST", body: {} },
      );
      const createdBody = (await created.json()) as {
        request: { id: string };
      };
      const cancelled = await call(
        zone.slug,
        `/api/tenant/erasure-requests/${createdBody.request.id}`,
        { method: "DELETE", body: { reason: "operator reconsidered" } },
      );
      expect(cancelled.status).toBe(200);

      const list = await call(zone.slug, "/api/tenant/erasure-requests");
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as {
        requests: Array<{ status: string }>;
      };
      expect(listBody.requests.length).toBe(1);
      expect(listBody.requests[0].status).toBe("cancelled");
    });

    it("GET ?scope=zone filters", async () => {
      const zone = await seedZoneWithMember(`er-flt-${unique()}`);
      cleanupSlugs.push(zone.slug);
      const u = await seedUser(`er-flt+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zone.id, zone.ownerRoleId);
      asUser(u, `er-flt+${unique()}@example.com`);
      await call(
        zone.slug,
        `/api/tenant/members/${zone.memberId}/erasure-requests`,
        { method: "POST", body: {} },
      );
      await call(zone.slug, "/api/tenant/zones/erasure-requests", {
        method: "POST",
        body: { confirmExportId: zone.exportId },
      });
      const list = await call(
        zone.slug,
        "/api/tenant/erasure-requests?scope=zone",
      );
      const listBody = (await list.json()) as {
        requests: Array<{ scope: string }>;
      };
      expect(listBody.requests.length).toBe(1);
      expect(listBody.requests[0].scope).toBe("zone");
    });

    it("404s a cross-zone cancel attempt", async () => {
      const zoneA = await seedZoneWithMember(`er-xa-${unique()}`);
      const zoneB = await seedZoneWithMember(`er-xb-${unique()}`);
      cleanupSlugs.push(zoneA.slug, zoneB.slug);
      const u = await seedUser(`er-x+${unique()}@example.com`);
      cleanupUserIds.push(u);
      await bindUser(u, zoneA.id, zoneA.ownerRoleId);
      await bindUser(u, zoneB.id, zoneB.ownerRoleId);
      asUser(u, `er-x+${unique()}@example.com`);
      const created = await call(
        zoneA.slug,
        `/api/tenant/members/${zoneA.memberId}/erasure-requests`,
        { method: "POST", body: {} },
      );
      const createdBody = (await created.json()) as {
        request: { id: string };
      };
      // Cancel via zone B's host — should 404 because the row
      // doesn't belong to zone B.
      const res = await call(
        zoneB.slug,
        `/api/tenant/erasure-requests/${createdBody.request.id}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
      // Cleanup the pending row on zoneA so afterAll doesn't trip.
      await db
        .delete(erasureRequests)
        .where(sql`zone_id = ${zoneA.id}`);
    });
  });
});
