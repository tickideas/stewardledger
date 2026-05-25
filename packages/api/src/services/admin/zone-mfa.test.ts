// packages/api/src/services/admin/zone-mfa.test.ts
// Service-layer tests for the platform-admin "Two-factor enforcement"
// surface. Covers normalisation, idempotency (no audit on no-op),
// invalid-role rejection, audit fan-out on a real change, and the
// enrolled/required counter for the UI's blast-radius preview.
//
// RELEVANT FILES: ./zone-mfa.ts, packages/db/src/schema/zones.ts

import {
  auditEvents,
  roles,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { ZONE_ROLES } from "@stewardledger/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../../db";
import {
  loadMfaRequiredRoleCodes,
  mfaEnforcementSummary,
  updateMfaRequiredRoleCodes,
  ZoneMfaError,
} from "./zone-mfa";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const cleanupSlugs: string[] = [];
const cleanupUserIds: string[] = [];

async function seedZone(opts: { mfaCodes?: string[] } = {}): Promise<{
  id: string;
  slug: string;
}> {
  const slug = `mfa-${unique()}`;
  cleanupSlugs.push(slug);
  const [row] = await db
    .insert(zones)
    .values({
      slug,
      name: `MFA Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
      mfaRequiredRoleCodes: opts.mfaCodes ?? [],
    })
    .returning({ id: zones.id, slug: zones.slug });
  return row;
}

async function seedUser(opts: { twoFactorEnabled?: boolean } = {}): Promise<string> {
  const id = `u-${unique()}`;
  cleanupUserIds.push(id);
  await db.insert(userTable).values({
    id,
    email: `mfa-${unique()}@example.com`,
    emailVerified: true,
    twoFactorEnabled: opts.twoFactorEnabled ?? false,
  });
  return id;
}

async function seedRole(zoneId: string, code: string): Promise<string> {
  // Each zone gets its own roles row per code; this matches the system-
  // role bootstrap shape and keeps the unique index `(zone_id, code)`
  // happy across parallel test runs.
  const [row] = await db
    .insert(roles)
    .values({
      zoneId,
      code,
      name: code,
      scope: code.startsWith("chapter_")
        ? "chapter"
        : code.startsWith("group_")
          ? "group"
          : "zone",
    })
    .returning({ id: roles.id });
  return row.id;
}

async function bindRole(opts: {
  userId: string;
  zoneId: string;
  roleId: string;
  scope: "zone" | "group" | "chapter";
}): Promise<void> {
  await db.insert(userRoleBindings).values({
    userId: opts.userId,
    zoneId: opts.zoneId,
    roleId: opts.roleId,
    roleScope: opts.scope,
  });
}

beforeAll(() => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("zone-mfa.test.ts requires a *_test DATABASE_URL");
  }
});

afterAll(async () => {
  for (const slug of cleanupSlugs) {
    const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
    await db.execute(
      sql`delete from user_role_bindings where zone_id = ${zoneIdSubq}`,
    );
    await db.execute(sql`delete from roles where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from zones where slug = ${slug}`);
  }
  if (cleanupUserIds.length > 0) {
    await db.delete(userTable).where(inArray(userTable.id, cleanupUserIds));
  }
});

describe("updateMfaRequiredRoleCodes", () => {
  it("writes a normalised list + emits a single platform-scope audit row", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    const result = await updateMfaRequiredRoleCodes(db, {
      zoneId: zone.id,
      actorUserId: actor,
      // Mixed-case + whitespace + duplicate to exercise normalise().
      codes: [" Zone_Owner ", "zone_owner", "zone_finance_admin"],
    });
    expect(result).toEqual(["zone_finance_admin", "zone_owner"]);

    const stored = await loadMfaRequiredRoleCodes(db, zone.id);
    expect(stored).toEqual(["zone_finance_admin", "zone_owner"]);

    const audits = await db
      .select({
        action: auditEvents.action,
        zoneId: auditEvents.zoneId,
        entityId: auditEvents.entityId,
        before: auditEvents.before,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "zone"),
          eq(auditEvents.entityId, zone.id),
        ),
      );
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe(
      "platform.zone.mfa_required_role_codes.update",
    );
    // Platform-scope event must have NULL zone_id (audit constraint).
    expect(audits[0].zoneId).toBeNull();
    expect(audits[0].before).toEqual({ codes: [] });
    expect(audits[0].after).toEqual({
      codes: ["zone_finance_admin", "zone_owner"],
    });
  });

  it("is idempotent: a re-write of the same list emits no audit row", async () => {
    const zone = await seedZone({ mfaCodes: ["zone_owner"] });
    const actor = await seedUser();
    await updateMfaRequiredRoleCodes(db, {
      zoneId: zone.id,
      actorUserId: actor,
      // Same effective list, different surface form.
      codes: ["ZONE_OWNER"],
    });
    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "zone"),
          eq(auditEvents.entityId, zone.id),
        ),
      );
    expect(audits.length).toBe(0);
  });

  it("rejects an unknown role code with invalid_role", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    await expect(
      updateMfaRequiredRoleCodes(db, {
        zoneId: zone.id,
        actorUserId: actor,
        codes: ["zone_owner", "definitely_not_a_role"],
      }),
    ).rejects.toBeInstanceOf(ZoneMfaError);
  });

  it("rejects platform roles (not zone-scoped)", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    await expect(
      updateMfaRequiredRoleCodes(db, {
        zoneId: zone.id,
        actorUserId: actor,
        codes: ["super_admin"],
      }),
    ).rejects.toBeInstanceOf(ZoneMfaError);
  });

  it("throws zone_not_found for a missing zone", async () => {
    const actor = await seedUser();
    await expect(
      updateMfaRequiredRoleCodes(db, {
        zoneId: "not-a-real-zone-id",
        actorUserId: actor,
        codes: ["zone_owner"],
      }),
    ).rejects.toMatchObject({ code: "zone_not_found" });
  });

  it("allows an empty list (turns enforcement off)", async () => {
    const zone = await seedZone({ mfaCodes: ["zone_owner"] });
    const actor = await seedUser();
    const result = await updateMfaRequiredRoleCodes(db, {
      zoneId: zone.id,
      actorUserId: actor,
      codes: [],
    });
    expect(result).toEqual([]);
  });
});

describe("mfaEnforcementSummary", () => {
  it("counts enrolled vs required users on the configured roles", async () => {
    const zone = await seedZone({
      mfaCodes: [ZONE_ROLES.ZONE_OWNER],
    });
    const roleId = await seedRole(zone.id, ZONE_ROLES.ZONE_OWNER);

    const enrolledUser = await seedUser({ twoFactorEnabled: true });
    const unenrolledUser = await seedUser({ twoFactorEnabled: false });

    await bindRole({
      userId: enrolledUser,
      zoneId: zone.id,
      roleId,
      scope: "zone",
    });
    await bindRole({
      userId: unenrolledUser,
      zoneId: zone.id,
      roleId,
      scope: "zone",
    });

    const summary = await mfaEnforcementSummary(db, zone.id);
    expect(summary).toEqual({ required: 2, enrolled: 1 });
  });

  it("returns zeroes when the column is empty", async () => {
    const zone = await seedZone();
    expect(await mfaEnforcementSummary(db, zone.id)).toEqual({
      required: 0,
      enrolled: 0,
    });
  });

  it("ignores revoked bindings", async () => {
    const zone = await seedZone({
      mfaCodes: [ZONE_ROLES.ZONE_OWNER],
    });
    const roleId = await seedRole(zone.id, ZONE_ROLES.ZONE_OWNER);
    const u = await seedUser({ twoFactorEnabled: false });
    await db.insert(userRoleBindings).values({
      userId: u,
      zoneId: zone.id,
      roleId,
      roleScope: "zone",
      revokedAt: new Date(),
    });
    expect(await mfaEnforcementSummary(db, zone.id)).toEqual({
      required: 0,
      enrolled: 0,
    });
  });

  it("de-duplicates a user holding two required roles", async () => {
    const zone = await seedZone({
      mfaCodes: [ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN],
    });
    const ownerRoleId = await seedRole(zone.id, ZONE_ROLES.ZONE_OWNER);
    const adminRoleId = await seedRole(zone.id, ZONE_ROLES.ZONE_ADMIN);
    const u = await seedUser({ twoFactorEnabled: true });
    await bindRole({
      userId: u,
      zoneId: zone.id,
      roleId: ownerRoleId,
      scope: "zone",
    });
    await bindRole({
      userId: u,
      zoneId: zone.id,
      roleId: adminRoleId,
      scope: "zone",
    });
    const summary = await mfaEnforcementSummary(db, zone.id);
    expect(summary).toEqual({ required: 1, enrolled: 1 });
  });
});
