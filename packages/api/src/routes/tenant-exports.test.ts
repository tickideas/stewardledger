// packages/api/src/routes/tenant-exports.test.ts
// Phase 9 §3 — tenant-exports router. Covers HTTP wiring, the
// `zone_owner`-only gate, the 24h-per-zone cooldown, 410 on
// expired, 404 on cross-zone, and the download stream.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZONE_ROLES } from "@stewardledger/shared";
import {
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
  zoneAdminRoleId: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Exports Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  const roles = await seedZoneRoles(db, zone.id);
  return {
    id: zone.id,
    slug: zone.slug,
    ownerRoleId: roles.get(ZONE_ROLES.ZONE_OWNER)!,
    zoneAdminRoleId: roles.get(ZONE_ROLES.ZONE_ADMIN)!,
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

describe("tenant exports router", () => {
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];
  let storage: InMemoryStorage;

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("tenant-exports.test.ts requires a *_test DATABASE_URL");
    }
    storage = new InMemoryStorage();
    setStorageForTesting(storage);
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
      await db.execute(sql`delete from zone_exports where zone_id = ${zoneIdSubq}`);
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
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userId, email));
  }

  /**
   * Insert a completed export row directly (bypassing the queue) so
   * we can exercise the list + download paths without booting
   * pg-boss. The CHECK `expires_at > created_at` blocks
   * straight-line "already-expired" inserts; tests that need an
   * expired row push `created_at` back via raw SQL after insert.
   */
  async function insertCompletedExport(opts: {
    zoneId: string;
    userId: string;
    body: Buffer;
    expiresInMs?: number;
  }): Promise<{ id: string; storageKey: string }> {
    const expiresIn = opts.expiresInMs ?? 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + expiresIn);
    const [row] = await db
      .insert(zoneExports)
      .values({
        zoneId: opts.zoneId,
        requestedByUserId: opts.userId,
        status: "completed",
        storageKey: `${opts.zoneId}/exports/2026/01/test-${unique()}.tar.gz`,
        byteCount: opts.body.length,
        tableCount: 45,
        fileCount: 0,
        artefactCount: 0,
        completedAt: new Date(),
        expiresAt,
      })
      .returning({ id: zoneExports.id, storageKey: zoneExports.storageKey });
    await storage.put(row.storageKey!, opts.body);
    return { id: row.id, storageKey: row.storageKey! };
  }

  it("POST /zones/exports rejects non-owners with 403", async () => {
    const zone = await seedZone(`exp-na-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const adminUser = await seedUser(`exp-na+${unique()}@example.com`);
    cleanupUserIds.push(adminUser);
    await bindUser(adminUser, zone.id, zone.zoneAdminRoleId);
    asUser(adminUser, `exp-na+${unique()}@example.com`);
    const res = await call(zone.slug, "/api/tenant/zones/exports", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("POST /zones/exports queues a bundle for a zone_owner", async () => {
    const zone = await seedZone(`exp-ok-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`exp-ok+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId);
    asUser(owner, `exp-ok+${unique()}@example.com`);
    const res = await call(zone.slug, "/api/tenant/zones/exports", { method: "POST" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      export: { status: string; requestedByUserId: string };
    };
    expect(body.export.status).toBe("queued");
    expect(body.export.requestedByUserId).toBe(owner);
  });

  it("POST /zones/exports returns 429 when within the 24h cooldown", async () => {
    const zone = await seedZone(`exp-rl-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`exp-rl+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId);
    asUser(owner, `exp-rl+${unique()}@example.com`);

    const first = await call(zone.slug, "/api/tenant/zones/exports", { method: "POST" });
    expect(first.status).toBe(202);

    const second = await call(zone.slug, "/api/tenant/zones/exports", { method: "POST" });
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      error: {
        code: string;
        details: { cooldownUntil?: string; existingExportId?: string };
      };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details.cooldownUntil).toBeDefined();
    expect(body.error.details.existingExportId).toBeDefined();
  });

  it("GET /zones/exports lists the caller's recent bundles", async () => {
    const zone = await seedZone(`exp-list-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`exp-list+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId);
    await insertCompletedExport({
      zoneId: zone.id,
      userId: owner,
      body: Buffer.from("bundle-1"),
    });
    asUser(owner, `exp-list+${unique()}@example.com`);
    const res = await call(zone.slug, "/api/tenant/zones/exports");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exports: Array<{ status: string }>;
    };
    expect(body.exports).toHaveLength(1);
    expect(body.exports[0].status).toBe("completed");
  });

  it("GET /zones/exports/:id/download streams a completed bundle", async () => {
    const zone = await seedZone(`exp-dl-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`exp-dl+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId);
    const inserted = await insertCompletedExport({
      zoneId: zone.id,
      userId: owner,
      body: Buffer.from("\x1f\x8b\x08stub-gzip"),
    });
    asUser(owner, `exp-dl+${unique()}@example.com`);
    const res = await call(
      zone.slug,
      `/api/tenant/zones/exports/${inserted.id}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toContain(
      `zone-export-${zone.id.slice(0, 8)}-${inserted.id.slice(0, 8)}.tar.gz`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).toString("utf-8")).toBe("\x1f\x8b\x08stub-gzip");
  });

  it("GET /zones/exports/:id/download returns 410 when the bundle has expired", async () => {
    const zone = await seedZone(`exp-ex-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const owner = await seedUser(`exp-ex+${unique()}@example.com`);
    cleanupUserIds.push(owner);
    await bindUser(owner, zone.id, zone.ownerRoleId);
    const inserted = await insertCompletedExport({
      zoneId: zone.id,
      userId: owner,
      body: Buffer.from("expired"),
    });
    // Push the row's window into the past. The DB CHECK
    // `expires_at > created_at` is satisfied because we move both.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const olderPast = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await db.execute(
      sql`update zone_exports
            set created_at = ${olderPast}::timestamptz,
                expires_at = ${past}::timestamptz
          where id = ${inserted.id}`,
    );
    asUser(owner, `exp-ex+${unique()}@example.com`);
    const res = await call(
      zone.slug,
      `/api/tenant/zones/exports/${inserted.id}/download`,
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("expired");
  });

  it("GET /zones/exports/:id/download returns 404 for a cross-zone id", async () => {
    const owner = await seedUser(`exp-x-${unique()}@example.com`);
    cleanupUserIds.push(owner);
    const myZone = await seedZone(`exp-my-${unique()}`);
    cleanupSlugs.push(myZone.slug);
    await bindUser(owner, myZone.id, myZone.ownerRoleId);

    // Belongs to a different zone, NOT the caller's.
    const otherZone = await seedZone(`exp-ot-${unique()}`);
    cleanupSlugs.push(otherZone.slug);
    const otherOwner = await seedUser(`exp-ot+${unique()}@example.com`);
    cleanupUserIds.push(otherOwner);
    const foreign = await insertCompletedExport({
      zoneId: otherZone.id,
      userId: otherOwner,
      body: Buffer.from("foreign"),
    });

    asUser(owner, `exp-x+${unique()}@example.com`);
    const res = await call(
      myZone.slug,
      `/api/tenant/zones/exports/${foreign.id}/download`,
    );
    expect(res.status).toBe(404);
  });
});
