// packages/api/src/routes/admin-audit.test.ts
// Route-level tests for /api/admin/audit-events (platform-scope audit
// search). Pins the WHERE clause: only rows with zone_id IS NULL and
// action LIKE 'platform.%' appear, regardless of any extra rows that
// share the same actor / time window.
//
// RELEVANT FILES: packages/api/src/routes/admin-audit.ts

import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  auditEvents,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";

import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { writeAudit } from "../services/audit";

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

async function call(path: string): Promise<Response> {
  return app.fetch(new Request(`${URL_BASE}${path}`, { method: "GET" }));
}

const createdUserIds: string[] = [];
const createdZoneSlugs: string[] = [];

async function makeUser(opts: { isSuperAdmin?: boolean } = {}): Promise<{
  id: string;
  email: string;
}> {
  const id = `aa-${unique()}-${unique()}`;
  const email = `${id}@example.test`;
  await db.insert(userTable).values({
    id,
    email,
    name: `Audit User ${id}`,
    emailVerified: true,
    isSuperAdmin: opts.isSuperAdmin ?? false,
  });
  createdUserIds.push(id);
  return { id, email };
}

async function makeZone(): Promise<{ id: string; slug: string }> {
  const slug = `aa-zone-${unique()}`;
  const [row] = await db
    .insert(zones)
    .values({
      slug,
      name: `Audit Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Audit Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  createdZoneSlugs.push(slug);
  return { id: row.id, slug };
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

beforeAll(() => {
  if (!process.env.DATABASE_URL?.includes("_test")) {
    throw new Error("admin-audit.test.ts requires a *_test DATABASE_URL");
  }
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  for (const slug of createdZoneSlugs) {
    await db.execute(sql`delete from zones where slug = ${slug}`);
  }
  if (createdUserIds.length > 0) {
    await db.delete(userTable).where(inArray(userTable.id, createdUserIds));
  }
});

describe("admin platform audit search", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await call(
      `/api/admin/audit-events?dateFrom=${todayIso()}&dateTo=${todayIso()}`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-super-admin sessions with 403", async () => {
    const plain = await makeUser();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(plain.id, plain.email),
    );
    const res = await call(
      `/api/admin/audit-events?dateFrom=${todayIso()}&dateTo=${todayIso()}`,
    );
    expect(res.status).toBe(403);
  });

  it("returns only platform.* rows; tenant rows are excluded by the WHERE clause", async () => {
    const admin = await makeUser({ isSuperAdmin: true });
    const targetUser = await makeUser();
    const zone = await makeZone();

    // Write one platform-scope event (zoneId null, action prefixed).
    await writeAudit(db, {
      zoneId: null,
      actorUserId: admin.id,
      action: "platform.admin.grant",
      entityType: "user",
      entityId: targetUser.id,
      after: { roleCode: "support_admin" },
    });
    // Write one tenant-scope event in the same window — must not appear.
    await writeAudit(db, {
      zoneId: zone.id,
      actorUserId: admin.id,
      action: "zone.invite",
      entityType: "zone",
      entityId: zone.id,
      after: { slug: zone.slug },
    });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
    const res = await call(
      `/api/admin/audit-events?dateFrom=${todayIso()}&dateTo=${todayIso()}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ action: string; entityId: string | null }>;
    };
    // Every returned row is platform.* and references our target user.
    const ours = body.items.filter(
      (r) => r.entityId === targetUser.id && r.action === "platform.admin.grant",
    );
    expect(ours.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((r) => r.action.startsWith("platform."))).toBe(true);
  });

  it("filters by action when provided", async () => {
    const admin = await makeUser({ isSuperAdmin: true });
    const targetA = await makeUser();
    const targetB = await makeUser();
    await writeAudit(db, {
      zoneId: null,
      actorUserId: admin.id,
      action: "platform.admin.grant",
      entityType: "user",
      entityId: targetA.id,
      after: { roleCode: "support_admin" },
    });
    await writeAudit(db, {
      zoneId: null,
      actorUserId: admin.id,
      action: "platform.admin.revoke",
      entityType: "user",
      entityId: targetB.id,
      before: { roleCode: "support_admin" },
    });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
    const res = await call(
      `/api/admin/audit-events?dateFrom=${todayIso()}&dateTo=${todayIso()}&action=platform.admin.grant`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ action: string; entityId: string | null }>;
    };
    expect(body.items.every((r) => r.action === "platform.admin.grant")).toBe(true);
    expect(body.items.some((r) => r.entityId === targetA.id)).toBe(true);
    expect(body.items.some((r) => r.entityId === targetB.id)).toBe(false);
  });

  it("rejects an out-of-order date window with 400", async () => {
    const admin = await makeUser({ isSuperAdmin: true });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
    const res = await call(
      `/api/admin/audit-events?dateFrom=2026-12-31&dateTo=2026-01-01`,
    );
    expect(res.status).toBe(400);
  });
});
