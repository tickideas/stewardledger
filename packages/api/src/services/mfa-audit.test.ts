// packages/api/src/services/mfa-audit.test.ts
// Phase 9 §5 — coverage for the MFA audit fan-out.
//
// The Better Auth `databaseHooks.user.update.after` hook calls
// `recordMfaAudit` when `two_factor_enabled` flips. We test the helper
// directly here; the hook wiring itself is exercised end-to-end the
// first time a real super-admin enables MFA on a deployed environment.
// RELEVANT FILES: packages/api/src/services/mfa-audit.ts, packages/api/src/auth.ts

import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZONE_ROLES } from "@stewardledger/shared";
import {
  auditEvents,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";
import { seedZoneRoles } from "./role-seed";
import { recordMfaAudit, scopedZoneIds } from "./mfa-audit";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedZone(): Promise<{ id: string; ownerRoleId: string }> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug: `mfa-${unique()}`,
      name: `MFA Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  const seeded = await seedZoneRoles(db, zone.id);
  return { id: zone.id, ownerRoleId: seeded.get(ZONE_ROLES.ZONE_OWNER)! };
}

async function seedUser(): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({
    id,
    email: `${id}@test.local`,
    emailVerified: true,
  });
  return id;
}

async function bind(userId: string, zoneId: string, roleId: string): Promise<void> {
  await db.insert(userRoleBindings).values({
    userId,
    zoneId,
    chapterId: null,
    roleId,
  });
}

async function readMfaEvents(userId: string): Promise<
  Array<{ zoneId: string; action: string; after: unknown }>
> {
  return db
    .select({
      zoneId: auditEvents.zoneId,
      action: auditEvents.action,
      after: auditEvents.after,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, "user"),
        eq(auditEvents.entityId, userId),
      ),
    )
    .orderBy(desc(auditEvents.occurredAt));
}

describe("mfa-audit", () => {
  const cleanupUserIds: string[] = [];
  const cleanupZoneIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("mfa-audit.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
    for (const id of cleanupZoneIds) {
      await db.execute(sql`delete from zones where id = ${id}`);
    }
  });

  it("fans out an enable event to every bound zone", async () => {
    const zoneA = await seedZone();
    const zoneB = await seedZone();
    cleanupZoneIds.push(zoneA.id, zoneB.id);
    const userId = await seedUser();
    cleanupUserIds.push(userId);
    await bind(userId, zoneA.id, zoneA.ownerRoleId);
    await bind(userId, zoneB.id, zoneB.ownerRoleId);

    await recordMfaAudit(db, { userId, enabled: true });

    const events = await readMfaEvents(userId);
    expect(events).toHaveLength(2);
    const byZone = new Map(events.map((e) => [e.zoneId, e]));
    expect(byZone.get(zoneA.id)?.action).toBe("user.mfa_enable");
    expect(byZone.get(zoneB.id)?.action).toBe("user.mfa_enable");
    expect(byZone.get(zoneA.id)?.after).toEqual({ twoFactorEnabled: true });
  });

  it("writes user.mfa_disable when enabled=false", async () => {
    const zone = await seedZone();
    cleanupZoneIds.push(zone.id);
    const userId = await seedUser();
    cleanupUserIds.push(userId);
    await bind(userId, zone.id, zone.ownerRoleId);

    await recordMfaAudit(db, { userId, enabled: false });

    const events = await readMfaEvents(userId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("user.mfa_disable");
    expect(events[0].after).toEqual({ twoFactorEnabled: false });
  });

  it("no-ops for a user with no tenant bindings (platform-only)", async () => {
    const userId = await seedUser();
    cleanupUserIds.push(userId);

    await recordMfaAudit(db, { userId, enabled: true });

    const events = await readMfaEvents(userId);
    expect(events).toHaveLength(0);
  });

  it("excludes revoked bindings from the fan-out", async () => {
    const zoneActive = await seedZone();
    const zoneRevoked = await seedZone();
    cleanupZoneIds.push(zoneActive.id, zoneRevoked.id);
    const userId = await seedUser();
    cleanupUserIds.push(userId);
    await bind(userId, zoneActive.id, zoneActive.ownerRoleId);
    await db.insert(userRoleBindings).values({
      userId,
      zoneId: zoneRevoked.id,
      chapterId: null,
      roleId: zoneRevoked.ownerRoleId,
      revokedAt: new Date(),
    });

    const ids = await scopedZoneIds(db, userId);
    expect(ids).toEqual([zoneActive.id]);

    await recordMfaAudit(db, { userId, enabled: true });
    const events = await readMfaEvents(userId);
    expect(events).toHaveLength(1);
    expect(events[0].zoneId).toBe(zoneActive.id);
  });
});
