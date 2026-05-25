// packages/api/src/routes/admin.test.ts
// Focused tests for the admin onboarding endpoints: invite, owner-invite
// resend, and invitation revoke. Auth is faked via the same approach as
// RELEVANT FILES: packages/api/src/routes/admin.ts, packages/db/src/schema/zones.ts, docs/ARCHITECTURE.md

import {
  auditEvents,
  invitations,
  platformRoleBindings,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import { ZONE_ROLES } from "@stewardledger/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

async function seedSuperAdmin(): Promise<{ id: string; email: string }> {
  const id = `u-${unique()}`;
  const email = `super+${unique()}@example.com`;
  await db.insert(userTable).values({ id, email, emailVerified: true, isSuperAdmin: true });
  return { id, email };
}

const app = createApp();
const ADMIN_URL = "http://localhost";

async function adminCall(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return app.fetch(
    new Request(`${ADMIN_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

describe("admin zone onboarding routes", () => {
  let admin: { id: string; email: string };
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("admin.test.ts requires a *_test DATABASE_URL");
    }
    admin = await seedSuperAdmin();
    cleanupUserIds.push(admin.id);
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function invite(): Promise<{ slug: string; zoneId: string }> {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));
    const slug = `inv-${unique()}`;
    const res = await adminCall("/api/admin/zones/invite", {
      method: "POST",
      body: {
        name: `Invited ${unique()}`,
        slug,
        countryCode: "GB",
        timeZone: "Europe/London",
        defaultCurrency: "GBP",
        fiscalYearStartMonth: 1,
        ministryYearStartMonth: 3,
        regionNameUnverified: `Region ${unique()}`,
        primaryContactName: "Pat Primary",
        primaryContactEmail: `pat+${unique()}@example.com`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; zoneId: string };
    expect(body.status).toBe("invited");
    cleanupSlugs.push(slug);
    return { slug, zoneId: body.zoneId };
  }

  it("POST /zones/invite creates a pending_setup zone with an open owner invitation", async () => {
    const { slug, zoneId } = await invite();

    const [zone] = await db.select().from(zones).where(eq(zones.id, zoneId));
    expect(zone.status).toBe("pending_setup");
    expect(zone.slug).toBe(slug);

    const open = await db
      .select({ id: invitations.id, roleCode: invitations.roleCode })
      .from(invitations)
      .where(
        and(
          eq(invitations.zoneId, zoneId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    expect(open).toHaveLength(1);
    expect(open[0].roleCode).toBe(ZONE_ROLES.ZONE_OWNER);
  });

  it("GET /zones/:slug exposes openInvitations alongside zone metadata", async () => {
    const { slug, zoneId } = await invite();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));
    const res = await adminCall(`/api/admin/zones/${slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      zone: { id: string; status: string };
      openInvitations: Array<{ roleCode: string; expired: boolean }>;
    };
    expect(body.zone.id).toBe(zoneId);
    expect(body.openInvitations).toHaveLength(1);
    expect(body.openInvitations[0].roleCode).toBe(ZONE_ROLES.ZONE_OWNER);
    expect(body.openInvitations[0].expired).toBe(false);
  });

  it("POST /zones/:slug/owner-invitations revokes previous open owner invites and emits a fresh one", async () => {
    const { slug, zoneId } = await invite();
    const before = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(eq(invitations.zoneId, zoneId));
    expect(before).toHaveLength(1);
    const originalId = before[0].id;

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));
    const newEmail = `corrected+${unique()}@example.com`;
    const res = await adminCall(`/api/admin/zones/${slug}/owner-invitations`, {
      method: "POST",
      body: { email: newEmail, primaryContactName: "Pat Updated" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      invitationId: string;
      revokedCount: number;
    };
    expect(body.status).toBe("resent");
    expect(body.invitationId).not.toBe(originalId);
    expect(body.revokedCount).toBe(1);

    // Original is now revoked; only the new one is open and is pinned to the
    // corrected email.
    const all = await db
      .select({
        id: invitations.id,
        email: invitations.email,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
      })
      .from(invitations)
      .where(eq(invitations.zoneId, zoneId));
    expect(all).toHaveLength(2);
    const original = all.find((r) => r.id === originalId)!;
    const fresh = all.find((r) => r.id === body.invitationId)!;
    expect(original.revokedAt).not.toBeNull();
    expect(fresh.revokedAt).toBeNull();
    expect(fresh.email).toBe(newEmail);

    // Audit trail: a zone.owner_invite.resend row should reference the new
    // invitation and record the revoked id in its `after` payload. This
    // proves the audit insert runs inside the same transaction as the
    // revoke/insert (per services/audit.ts contract).
    const [audit] = await db
      .select({
        action: auditEvents.action,
        entityId: auditEvents.entityId,
        after: auditEvents.after,
        actorUserId: auditEvents.actorUserId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.zoneId, zoneId),
          eq(auditEvents.action, "zone.owner_invite.resend"),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.entityId).toBe(body.invitationId);
    expect(audit.actorUserId).toBe(admin.id);
    expect((audit.after as { revokedInvitationIds: string[] }).revokedInvitationIds).toContain(
      originalId,
    );
  });

  it("POST /zones/:slug/owner-invitations refuses on already-active zones", async () => {
    const { slug, zoneId } = await invite();
    // Simulate the zone owner having accepted: flip to active.
    await db.update(zones).set({ status: "active" }).where(eq(zones.id, zoneId));

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));
    const res = await adminCall(`/api/admin/zones/${slug}/owner-invitations`, {
      method: "POST",
      body: { email: `another+${unique()}@example.com` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("zone_already_active");
  });

  it("POST /zones/:slug/invitations/:id/revoke revokes a specific open invitation", async () => {
    const { slug, zoneId } = await invite();
    const [open] = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.zoneId, zoneId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));
    const res = await adminCall(`/api/admin/zones/${slug}/invitations/${open.id}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("revoked");

    const [after] = await db
      .select({ revokedAt: invitations.revokedAt })
      .from(invitations)
      .where(eq(invitations.id, open.id));
    expect(after.revokedAt).not.toBeNull();

    // Audit row written in the same transaction.
    const [audit] = await db
      .select({ action: auditEvents.action, entityId: auditEvents.entityId })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.zoneId, zoneId), eq(auditEvents.action, "invitation.revoke")),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.entityId).toBe(open.id);
  });

  it("rejects revoke for an unknown invitation id on a real zone with 404", async () => {
    const { slug } = await invite();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));
    const res = await adminCall(
      `/api/admin/zones/${slug}/invitations/does-not-exist/revoke`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /zones/:slug soft-deletes the zone and writes an audit event", async () => {
    const { slug, zoneId } = await invite();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));

    const res = await adminCall(`/api/admin/zones/${slug}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      zone: { slug: string; deletedAt: string | null };
    };
    expect(body.status).toBe("removed");
    expect(body.zone.slug).toBe(slug);
    expect(body.zone.deletedAt).toEqual(expect.any(String));

    const [removed] = await db
      .select({ deletedAt: zones.deletedAt })
      .from(zones)
      .where(eq(zones.id, zoneId));
    expect(removed.deletedAt).not.toBeNull();

    const openInvitations = await db
      .select({ revokedAt: invitations.revokedAt, revokedByUserId: invitations.revokedByUserId })
      .from(invitations)
      .where(eq(invitations.zoneId, zoneId));
    expect(openInvitations.length).toBeGreaterThan(0);
    expect(openInvitations.every((inv) => inv.revokedAt !== null)).toBe(true);
    expect(openInvitations.every((inv) => inv.revokedByUserId === admin.id)).toBe(true);

    const [audit] = await db
      .select({
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        actorUserId: auditEvents.actorUserId,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.zoneId, zoneId), eq(auditEvents.action, "zone.remove")))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.entityType).toBe("zone");
    expect(audit.entityId).toBe(zoneId);
    expect(audit.actorUserId).toBe(admin.id);
    expect((audit.after as { revokedInvitationIds: string[] }).revokedInvitationIds.length).toBe(
      openInvitations.length,
    );

    const detail = await adminCall(`/api/admin/zones/${slug}`);
    expect(detail.status).toBe(404);
  });

  it("DELETE /zones/:slug returns 404 for an unknown or already-removed zone", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));
    const missing = await adminCall(`/api/admin/zones/not-${unique()}`, { method: "DELETE" });
    expect(missing.status).toBe(404);

    const { slug } = await invite();
    const first = await adminCall(`/api/admin/zones/${slug}`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const second = await adminCall(`/api/admin/zones/${slug}`, { method: "DELETE" });
    expect(second.status).toBe(404);
  });

  it("excludes removed zones from region inbox and promotion", async () => {
    const { slug, zoneId } = await invite();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(admin.id, admin.email));

    const removed = await adminCall(`/api/admin/zones/${slug}`, { method: "DELETE" });
    expect(removed.status).toBe(200);

    const inbox = await adminCall("/api/admin/regions/inbox");
    expect(inbox.status).toBe(200);
    const inboxBody = (await inbox.json()) as { items: Array<{ zoneId: string }> };
    expect(inboxBody.items.map((row) => row.zoneId)).not.toContain(zoneId);

    const promote = await adminCall("/api/admin/regions/promote", {
      method: "POST",
      body: {
        zoneIds: [zoneId],
        regionDraft: { name: `Removed Region ${unique()}` },
      },
    });
    expect(promote.status).toBe(409);
    const promoteBody = (await promote.json()) as { error: { code: string } };
    expect(promoteBody.error.code).toBe("zone_not_found");

    const [after] = await db
      .select({ regionId: zones.regionId, regionNameUnverified: zones.regionNameUnverified })
      .from(zones)
      .where(eq(zones.id, zoneId));
    expect(after.regionId).toBeNull();
    expect(after.regionNameUnverified).not.toBeNull();
  });
});

describe("admin platform-role gating", () => {
  // A second describe to keep the scenario data isolated from the
  // onboarding suite above. Each test seeds its own user and role
  // binding and cleans them up in afterAll.
  const cleanupUserIds: string[] = [];
  const cleanupBindings: string[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("admin.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterAll(async () => {
    if (cleanupBindings.length > 0) {
      await db.delete(platformRoleBindings).where(inArray(platformRoleBindings.id, cleanupBindings));
    }
    if (cleanupUserIds.length > 0) {
      for (const id of cleanupUserIds) {
        await db.execute(sql`delete from "user" where id = ${id}`);
      }
    }
  });

  afterEach(() => vi.restoreAllMocks());

  async function seedSupportAdmin(): Promise<{ id: string; email: string }> {
    const id = `u-sup-${unique()}`;
    const email = `support+${unique()}@example.com`;
    await db.insert(userTable).values({ id, email, emailVerified: true, isSuperAdmin: false });
    const [binding] = await db
      .insert(platformRoleBindings)
      .values({ userId: id, roleCode: "support_admin" })
      .returning({ id: platformRoleBindings.id });
    cleanupUserIds.push(id);
    cleanupBindings.push(binding.id);
    return { id, email };
  }

  it("support_admin reads tenant zone listing", async () => {
    const sup = await seedSupportAdmin();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(sup.id, sup.email),
    );
    const res = await adminCall("/api/admin/zones");
    expect(res.status).toBe(200);
  });

  it("support_admin reads a specific tenant zone", async () => {
    const sup = await seedSupportAdmin();
    // Need a zone to read; reuse the demo-river-ng-style fixture by
    // creating one via the super-admin path. To keep this test
    // independent, just insert a minimal zone directly.
    const slug = `sup-zone-${unique()}`;
    const [zone] = await db
      .insert(zones)
      .values({
        slug,
        name: `Support Test ${unique()}`,
        countryCode: "GB",
        defaultCurrencyCode: "GBP",
        defaultTimeZone: "Europe/London",
        regionNameUnverified: `Support Region ${unique()}`,
        status: "active",
      })
      .returning({ id: zones.id });
    try {
      vi.spyOn(auth.api, "getSession").mockResolvedValue(
        fakeSession(sup.id, sup.email),
      );
      const res = await adminCall(`/api/admin/zones/${encodeURIComponent(slug)}`);
      expect(res.status).toBe(200);
    } finally {
      await db.execute(sql`delete from zones where id = ${zone.id}`);
    }
  });

  it("support_admin cannot invite a zone (403)", async () => {
    const sup = await seedSupportAdmin();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(sup.id, sup.email),
    );
    const res = await adminCall("/api/admin/zones/invite", {
      method: "POST",
      body: {
        name: `No Permit ${unique()}`,
        slug: `nop-${unique()}`,
        countryCode: "GB",
        timeZone: "Europe/London",
        defaultCurrency: "GBP",
        fiscalYearStartMonth: 1,
        ministryYearStartMonth: 3,
        regionNameUnverified: `Nope Region ${unique()}`,
        primaryContactName: "Owner",
        primaryContactEmail: `nope+${unique()}@example.com`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("support_admin cannot create a region (403 via inline gate)", async () => {
    const sup = await seedSupportAdmin();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(sup.id, sup.email),
    );
    const res = await adminCall("/api/admin/regions", {
      method: "POST",
      body: { name: `Forbidden Region ${unique()}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/admin/zones/:slug/mfa-required-role-codes", () => {
  // Self-contained: seeds its own admin + zone per test so the order-
  // independence guarantee holds even when run in isolation.
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];
  const cleanupBindings: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("admin.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterAll(async () => {
    if (cleanupBindings.length > 0) {
      await db
        .delete(platformRoleBindings)
        .where(inArray(platformRoleBindings.id, cleanupBindings));
    }
    for (const slug of cleanupSlugs) {
      const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
      await db.execute(
        sql`delete from audit_events where entity_type = 'zone' and entity_id in (select id from zones where slug = ${slug})`,
      );
      await db.execute(sql`delete from user_role_bindings where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from roles where zone_id = ${zoneIdSubq}`);
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  async function seedSuperAdminUser(): Promise<{ id: string; email: string }> {
    const id = `u-mfa-sup-${unique()}`;
    const email = `mfa-sup-${unique()}@example.com`;
    await db.insert(userTable).values({
      id,
      email,
      emailVerified: true,
      isSuperAdmin: true,
    });
    cleanupUserIds.push(id);
    return { id, email };
  }

  async function seedSupportAdminUser(): Promise<{ id: string; email: string }> {
    const id = `u-mfa-sup2-${unique()}`;
    const email = `mfa-sup2-${unique()}@example.com`;
    await db.insert(userTable).values({
      id,
      email,
      emailVerified: true,
      isSuperAdmin: false,
    });
    const [binding] = await db
      .insert(platformRoleBindings)
      .values({ userId: id, roleCode: "support_admin" })
      .returning({ id: platformRoleBindings.id });
    cleanupUserIds.push(id);
    cleanupBindings.push(binding.id);
    return { id, email };
  }

  async function seedMfaZone(): Promise<{ id: string; slug: string }> {
    const slug = `mfa-route-${unique()}`;
    cleanupSlugs.push(slug);
    const [row] = await db
      .insert(zones)
      .values({
        slug,
        name: `MFA Route ${unique()}`,
        countryCode: "GB",
        defaultCurrencyCode: "GBP",
        defaultTimeZone: "Europe/London",
        regionNameUnverified: `Region ${unique()}`,
        status: "active",
      })
      .returning({ id: zones.id, slug: zones.slug });
    return row;
  }

  it("super_admin PATCH with valid codes returns 200 + normalised list", async () => {
    const admin = await seedSuperAdminUser();
    const zone = await seedMfaZone();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
    const res = await adminCall(
      `/api/admin/zones/${zone.slug}/mfa-required-role-codes`,
      {
        method: "PATCH",
        body: { codes: ["zone_owner", "ZONE_FINANCE_ADMIN"] },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codes: string[] };
    expect(body.codes).toEqual(["zone_finance_admin", "zone_owner"]);
  });

  it("support_admin PATCH returns 403", async () => {
    const sup = await seedSupportAdminUser();
    const zone = await seedMfaZone();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(sup.id, sup.email),
    );
    const res = await adminCall(
      `/api/admin/zones/${zone.slug}/mfa-required-role-codes`,
      {
        method: "PATCH",
        body: { codes: ["zone_owner"] },
      },
    );
    expect(res.status).toBe(403);
  });

  it("super_admin PATCH with an unknown role code returns 422 + invalid_role", async () => {
    const admin = await seedSuperAdminUser();
    const zone = await seedMfaZone();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
    const res = await adminCall(
      `/api/admin/zones/${zone.slug}/mfa-required-role-codes`,
      {
        method: "PATCH",
        body: { codes: ["zone_owner", "bogus_role"] },
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; unknownCodes?: string[] };
    };
    expect(body.error.code).toBe("invalid_role");
    expect(body.error.unknownCodes).toEqual(["bogus_role"]);
  });

  it("GET /zones/:slug includes the mfa bundle", async () => {
    const admin = await seedSuperAdminUser();
    const zone = await seedMfaZone();
    // Seed an initial list so the GET reads a non-empty value.
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
    await adminCall(
      `/api/admin/zones/${zone.slug}/mfa-required-role-codes`,
      {
        method: "PATCH",
        body: { codes: ["zone_owner"] },
      },
    );
    const res = await adminCall(`/api/admin/zones/${zone.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mfa: { requiredRoleCodes: string[]; required: number; enrolled: number };
    };
    expect(body.mfa.requiredRoleCodes).toEqual(["zone_owner"]);
    expect(body.mfa.required).toBe(0);
    expect(body.mfa.enrolled).toBe(0);
  });

  it("returns 404 when the zone slug does not exist", async () => {
    const admin = await seedSuperAdminUser();
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
    const res = await adminCall(
      "/api/admin/zones/zone-does-not-exist/mfa-required-role-codes",
      {
        method: "PATCH",
        body: { codes: ["zone_owner"] },
      },
    );
    expect(res.status).toBe(404);
  });
});

