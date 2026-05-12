// packages/api/src/routes/admin.test.ts
// Focused tests for the admin onboarding endpoints: invite, owner-invite
// resend, and invitation revoke. Auth is faked via the same approach as
// tenant.test.ts; cross-tenant fuzz isn't repeated here because the
// super-admin gate intentionally allows cross-zone reads/writes.

import {
  auditEvents,
  invitations,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import { ZONE_ROLES } from "@stewardledger/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
});
