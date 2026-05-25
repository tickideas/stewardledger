// packages/api/src/routes/admin-erasure.test.ts
// Phase 9 §6 — platform-admin parallel for the zone-erasure path.
// Covers super-admin gate, slug → zone resolution, the
// recent-export gate, and the cancel/list happy paths.

import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  user as userTable,
  zoneExports,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { InMemoryStorage, setStorageForTesting } from "../services/storage";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

const app = createApp();
const URL_BASE = "http://localhost";

interface FetchOpts {
  method?: string;
  body?: unknown;
}

async function call(path: string, opts: FetchOpts = {}): Promise<Response> {
  return app.fetch(
    new Request(`${URL_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "content-type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

const createdUserIds: string[] = [];
const createdZoneSlugs: string[] = [];

async function makeUser(opts: { isSuperAdmin?: boolean } = {}): Promise<{
  id: string;
  email: string;
}> {
  const id = `ae-${unique()}-${unique()}`;
  const email = `${id}@example.test`;
  await db.insert(userTable).values({
    id,
    email,
    name: `Erasure Admin ${id}`,
    emailVerified: true,
    isSuperAdmin: opts.isSuperAdmin ?? false,
  });
  createdUserIds.push(id);
  return { id, email };
}

async function makeZoneWithExport(): Promise<{
  id: string;
  slug: string;
  exportId: string;
}> {
  const slug = `ae-zone-${unique()}`;
  const [row] = await db
    .insert(zones)
    .values({
      slug,
      name: `Erasure Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Erasure Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  createdZoneSlugs.push(slug);
  const [exp] = await db
    .insert(zoneExports)
    .values({
      zoneId: row.id,
      status: "completed",
      storageKey: `${row.id}/exports/2026/01/ae-${unique()}.tar.gz`,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: zoneExports.id });
  return { id: row.id, slug, exportId: exp.id };
}

beforeAll(() => {
  if (!process.env.DATABASE_URL?.includes("_test")) {
    throw new Error("admin-erasure.test.ts requires a *_test DATABASE_URL");
  }
  setStorageForTesting(new InMemoryStorage());
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  for (const slug of createdZoneSlugs) {
    const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
    await db.execute(sql`delete from erasure_requests where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from zone_exports where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from zones where slug = ${slug}`);
  }
  if (createdUserIds.length > 0) {
    await db.delete(userTable).where(inArray(userTable.id, createdUserIds));
  }
  setStorageForTesting(null);
});

describe("admin erasure router", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const z = await makeZoneWithExport();
    const res = await call(
      `/api/admin/zones/${z.slug}/erasure-requests`,
      { method: "POST", body: { confirmExportId: z.exportId } },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a non-super-admin with 403", async () => {
    const u = await makeUser({ isSuperAdmin: false });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(u.id, u.email),
    );
    const z = await makeZoneWithExport();
    const res = await call(
      `/api/admin/zones/${z.slug}/erasure-requests`,
      { method: "POST", body: { confirmExportId: z.exportId } },
    );
    expect(res.status).toBe(403);
  });

  it("404s on an unknown slug", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(u.id, u.email),
    );
    const res = await call(
      `/api/admin/zones/non-existent-slug-${unique()}/erasure-requests`,
      { method: "POST", body: { confirmExportId: "x" } },
    );
    expect(res.status).toBe(404);
  });

  it("super-admin can schedule a zone-erase + the list + cancel cycle", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(u.id, u.email),
    );
    const z = await makeZoneWithExport();

    const created = await call(
      `/api/admin/zones/${z.slug}/erasure-requests`,
      {
        method: "POST",
        body: { confirmExportId: z.exportId, reason: "owner inactive" },
      },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      request: { id: string; status: string };
    };
    expect(createdBody.request.status).toBe("pending");

    const list = await call(`/api/admin/zones/${z.slug}/erasure-requests`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      requests: Array<{ id: string; scope: string }>;
    };
    expect(listBody.requests.length).toBe(1);
    expect(listBody.requests[0].scope).toBe("zone");

    const cancel = await call(
      `/api/admin/zones/${z.slug}/erasure-requests/${createdBody.request.id}`,
      { method: "DELETE", body: { reason: "operator returned" } },
    );
    expect(cancel.status).toBe(200);
  });

  it("422s when confirmExportId is stale (>7 days old)", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(u.id, u.email),
    );
    const z = await makeZoneWithExport();
    await db
      .update(zoneExports)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(sql`id = ${z.exportId}`);
    const res = await call(
      `/api/admin/zones/${z.slug}/erasure-requests`,
      { method: "POST", body: { confirmExportId: z.exportId } },
    );
    expect(res.status).toBe(422);
  });

  it("400s without confirmExportId", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(u.id, u.email),
    );
    const z = await makeZoneWithExport();
    const res = await call(
      `/api/admin/zones/${z.slug}/erasure-requests`,
      { method: "POST", body: {} },
    );
    expect(res.status).toBe(400);
  });
});
