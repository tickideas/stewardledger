// packages/api/src/routes/public-session-zones.test.ts
// Phase 9 §5 (PR 2) — coverage for the per-zone MFA-enforcement flag
// surfaced on /api/public/session-zones. The web shell reads this to
// redirect MFA-less users with a required role to /account/security.
//
// We exercise the enforcement-list intersection: a zone with
// `mfa_required_role_codes = '{zone_owner}'` returns `mfaRequired: true`
// for a user holding `zone_owner`; the same zone returns `false` for a
// user without a matching role.
// RELEVANT FILES: packages/api/src/routes/public.ts, packages/api/src/services/mfa-policy.ts

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZONE_ROLES } from "@stewardledger/shared";
import {
  platformRoleBindings,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { seedZoneRoles } from "../services/role-seed";

const app = createApp();
const URL = "http://localhost";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

async function seedZone(
  mfaRequiredRoleCodes: string[] = [],
): Promise<{ id: string; ownerRoleId: string }> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug: `mfa-pol-${unique()}`,
      name: `MFA Policy Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
      mfaRequiredRoleCodes,
    })
    .returning({ id: zones.id });
  const seeded = await seedZoneRoles(db, zone.id);
  return { id: zone.id, ownerRoleId: seeded.get(ZONE_ROLES.ZONE_OWNER)! };
}

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = `u-${unique()}`;
  const email = `${id}@test.local`;
  await db.insert(userTable).values({ id, email, emailVerified: true });
  return { id, email };
}

async function bind(userId: string, zoneId: string, roleId: string): Promise<void> {
  await db.insert(userRoleBindings).values({
    userId,
    zoneId,
    chapterId: null,
    roleId,
  });
}

interface ZoneItem {
  slug: string;
  mfaRequired: boolean;
  zoneRoles: string[];
}

async function callSessionZones(): Promise<ZoneItem[]> {
  const res = await app.fetch(
    new Request(`${URL}/api/public/session-zones`, { method: "GET" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: ZoneItem[] };
  return body.items;
}

describe("/api/public/session-zones — mfaRequired flag", () => {
  const cleanupUserIds: string[] = [];
  const cleanupZoneIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("public-session-zones.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
    for (const id of cleanupZoneIds) {
      await db.execute(sql`delete from zones where id = ${id}`);
    }
  });

  it("reports mfaRequired=true when a user's role is on the zone's required list", async () => {
    const zone = await seedZone([ZONE_ROLES.ZONE_OWNER]);
    cleanupZoneIds.push(zone.id);
    const user = await seedUser();
    cleanupUserIds.push(user.id);
    await bind(user.id, zone.id, zone.ownerRoleId);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(user.id, user.email),
    );

    const items = await callSessionZones();
    const z = items.find((i) => i.zoneRoles.includes(ZONE_ROLES.ZONE_OWNER));
    expect(z?.mfaRequired).toBe(true);
  });

  it("reports mfaRequired=false when the zone's required list is empty", async () => {
    const zone = await seedZone([]);
    cleanupZoneIds.push(zone.id);
    const user = await seedUser();
    cleanupUserIds.push(user.id);
    await bind(user.id, zone.id, zone.ownerRoleId);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(user.id, user.email),
    );

    const items = await callSessionZones();
    const z = items.find((i) => i.zoneRoles.includes(ZONE_ROLES.ZONE_OWNER));
    expect(z?.mfaRequired).toBe(false);
  });

  it("reports mfaRequired=false when the user's role isn't on the required list", async () => {
    // Zone requires MFA for chapter_treasurer; user is a zone_owner.
    const zone = await seedZone(["chapter_treasurer"]);
    cleanupZoneIds.push(zone.id);
    const user = await seedUser();
    cleanupUserIds.push(user.id);
    await bind(user.id, zone.id, zone.ownerRoleId);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(user.id, user.email),
    );

    const items = await callSessionZones();
    const z = items.find((i) => i.zoneRoles.includes(ZONE_ROLES.ZONE_OWNER));
    expect(z?.mfaRequired).toBe(false);
  });
});

async function callSessionZonesFull(): Promise<{
  isSuperAdmin: boolean;
  platformRoles: string[];
}> {
  const res = await app.fetch(
    new Request(`${URL}/api/public/session-zones`, { method: "GET" }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { isSuperAdmin: boolean; platformRoles: string[] };
}

describe("/api/public/session-zones — platformRoles", () => {
  const cleanupUserIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("public-session-zones.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterAll(async () => {
    if (cleanupUserIds.length > 0) {
      // platform_role_bindings cascade-delete via user FK ON DELETE CASCADE.
      for (const id of cleanupUserIds) {
        await db.execute(sql`delete from "user" where id = ${id}`);
      }
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns an empty platformRoles array for a user with no platform-role bindings", async () => {
    const user = await seedUser();
    cleanupUserIds.push(user.id);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(user.id, user.email),
    );
    const body = await callSessionZonesFull();
    expect(body.platformRoles).toEqual([]);
  });

  it("returns each active platform-role binding once", async () => {
    const user = await seedUser();
    cleanupUserIds.push(user.id);
    await db.insert(platformRoleBindings).values([
      { userId: user.id, roleCode: "support_admin" },
      { userId: user.id, roleCode: "region_curator" },
    ]);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(user.id, user.email),
    );
    const body = await callSessionZonesFull();
    expect(new Set(body.platformRoles)).toEqual(
      new Set(["support_admin", "region_curator"]),
    );
  });

  it("excludes revoked platform-role bindings", async () => {
    const user = await seedUser();
    cleanupUserIds.push(user.id);
    await db.insert(platformRoleBindings).values({
      userId: user.id,
      roleCode: "billing_admin",
      revokedAt: new Date(),
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(user.id, user.email),
    );
    const body = await callSessionZonesFull();
    expect(body.platformRoles).toEqual([]);
  });
});

