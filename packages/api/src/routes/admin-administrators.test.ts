// packages/api/src/routes/admin-administrators.test.ts
// Route-level tests for /api/admin/administrators. Auth is faked via the
// same `auth.api.getSession` spy pattern as admin.test.ts.
//
// RELEVANT FILES: packages/api/src/routes/admin-administrators.ts, packages/api/src/services/admin/administrators.ts

import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  auditEvents,
  platformInvitations,
  platformRoleBindings,
  user as userTable,
} from "@stewardledger/db/schema";
import { PLATFORM_ROLES } from "@stewardledger/shared";

import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import * as platformEmails from "../services/admin/platform-admin-emails";

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

const createdUserIds: string[] = [];
const createdInvitationIds: string[] = [];

async function makeUser(opts: { isSuperAdmin?: boolean } = {}): Promise<{
  id: string;
  email: string;
}> {
  const id = `r-${unique()}-${unique()}`;
  const email = `${id}@example.test`;
  await db.insert(userTable).values({
    id,
    email,
    name: `Test ${id}`,
    emailVerified: true,
    isSuperAdmin: opts.isSuperAdmin ?? false,
  });
  createdUserIds.push(id);
  return { id, email };
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return app.fetch(
    new Request(`${URL_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

describe("admin administrators routes", () => {
  let admin: { id: string; email: string };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("admin-administrators.test.ts requires a *_test DATABASE_URL");
    }
    admin = await makeUser({ isSuperAdmin: true });
  });

  afterAll(async () => {
    if (createdInvitationIds.length > 0) {
      await db
        .delete(platformInvitations)
        .where(inArray(platformInvitations.id, createdInvitationIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(userTable).where(inArray(userTable.id, createdUserIds));
    }
  });

  afterEach(() => vi.restoreAllMocks());

  function asAdmin(): void {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(admin.id, admin.email),
    );
  }
  function asUser(u: { id: string; email: string }): void {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(u.id, u.email));
  }

  it("rejects unauthenticated requests with 401", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await call("/api/admin/administrators");
    expect(res.status).toBe(401);
  });

  it("rejects non-super-admin sessions with 403", async () => {
    const plain = await makeUser();
    asUser(plain);
    const res = await call("/api/admin/administrators");
    expect(res.status).toBe(403);
  });

  it("lists administrators with their platform roles", async () => {
    asAdmin();
    const res = await call("/api/admin/administrators");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ userId: string; isSuperAdmin: boolean }>;
      invitations: unknown[];
    };
    expect(body.items.find((i) => i.userId === admin.id)?.isSuperAdmin).toBe(true);
    expect(Array.isArray(body.invitations)).toBe(true);
  });

  it("invites a new platform admin and surfaces the invitation id", async () => {
    asAdmin();
    const email = `invite-route-${unique()}@example.test`;
    const res = await call("/api/admin/administrators/invite", {
      method: "POST",
      body: {
        name: "Pat Route",
        email,
        roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invitationId: string;
      emailSent: boolean;
      emailError: string | null;
    };
    createdInvitationIds.push(body.invitationId);
    expect(body.invitationId).toBeTruthy();
    // Dev email transport always reports success (it just logs the
    // body), so the happy path returns emailSent=true here.
    expect(body.emailSent).toBe(true);
    expect(body.emailError).toBeNull();

    // Audit row landed under platform.*.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        sql`action = 'platform.admin.invite' and entity_id = ${body.invitationId}`,
      );
    expect(audit.length).toBe(1);
    expect(audit[0].zoneId).toBeNull();
  });

  it("invite refuses an email that already exists as a user", async () => {
    const existing = await makeUser();
    asAdmin();
    const res = await call("/api/admin/administrators/invite", {
      method: "POST",
      body: {
        name: "Should Not Invite",
        email: existing.email,
        roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
      },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("email_already_user");
  });

  it("grant-by-email adds a platform role to an existing user and notifies by default", async () => {
    const target = await makeUser();
    const spy = vi
      .spyOn(platformEmails, "sendPlatformAdminGrantNoticeEmail")
      .mockResolvedValue();
    asAdmin();
    try {
      const res = await call("/api/admin/administrators/grant", {
        method: "POST",
        body: {
          email: target.email,
          roleCode: PLATFORM_ROLES.BILLING_ADMIN,
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        bindingId: string;
        notified: boolean;
        emailSent: boolean;
      };
      expect(body.notified).toBe(true);
      expect(body.emailSent).toBe(true);
      const bindings = await db
        .select({ roleCode: platformRoleBindings.roleCode })
        .from(platformRoleBindings)
        .where(sql`user_id = ${target.id} and revoked_at is null`);
      expect(bindings.map((b) => b.roleCode)).toContain(
        PLATFORM_ROLES.BILLING_ADMIN,
      );
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ to: target.email, roleCode: PLATFORM_ROLES.BILLING_ADMIN }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("grant-by-email respects notify=false (no email sent, notified=false in response)", async () => {
    const target = await makeUser();
    const spy = vi
      .spyOn(platformEmails, "sendPlatformAdminGrantNoticeEmail")
      .mockResolvedValue();
    asAdmin();
    try {
      const res = await call("/api/admin/administrators/grant", {
        method: "POST",
        body: {
          email: target.email,
          roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
          notify: false,
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { notified: boolean; emailSent: boolean };
      expect(body.notified).toBe(false);
      expect(body.emailSent).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("grant-by-email surfaces emailSent=false when the transport fails (binding still landed)", async () => {
    const target = await makeUser();
    const spy = vi
      .spyOn(platformEmails, "sendPlatformAdminGrantNoticeEmail")
      .mockRejectedValueOnce(new Error("transport down"));
    asAdmin();
    try {
      const res = await call("/api/admin/administrators/grant", {
        method: "POST",
        body: {
          email: target.email,
          roleCode: PLATFORM_ROLES.REGION_CURATOR,
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        notified: boolean;
        emailSent: boolean;
        emailError: string | null;
      };
      expect(body.notified).toBe(true);
      expect(body.emailSent).toBe(false);
      expect(body.emailError).toBe("transport down");
      // Binding still landed.
      const bindings = await db
        .select({ roleCode: platformRoleBindings.roleCode })
        .from(platformRoleBindings)
        .where(sql`user_id = ${target.id} and revoked_at is null`);
      expect(bindings.map((b) => b.roleCode)).toContain(
        PLATFORM_ROLES.REGION_CURATOR,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("grant-by-id + revoke role round-trip", async () => {
    const target = await makeUser();
    asAdmin();
    const grantRes = await call(
      `/api/admin/administrators/${encodeURIComponent(target.id)}/roles`,
      {
        method: "POST",
        body: { roleCode: PLATFORM_ROLES.REGION_CURATOR },
      },
    );
    expect(grantRes.status).toBe(201);

    const revokeRes = await call(
      `/api/admin/administrators/${encodeURIComponent(target.id)}/roles/${PLATFORM_ROLES.REGION_CURATOR}`,
      { method: "DELETE" },
    );
    expect(revokeRes.status).toBe(200);

    const active = await db
      .select()
      .from(platformRoleBindings)
      .where(
        sql`user_id = ${target.id} and role_code = ${PLATFORM_ROLES.REGION_CURATOR} and revoked_at is null`,
      );
    expect(active.length).toBe(0);
  });

  it("elevate + demote round-trip on an existing user", async () => {
    const target = await makeUser();
    asAdmin();
    const elev = await call(
      `/api/admin/administrators/${encodeURIComponent(target.id)}/super-admin`,
      { method: "POST" },
    );
    expect(elev.status).toBe(200);
    const [afterElev] = await db
      .select({ isSuperAdmin: userTable.isSuperAdmin })
      .from(userTable)
      .where(sql`id = ${target.id}`);
    expect(afterElev.isSuperAdmin).toBe(true);

    const demoteRes = await call(
      `/api/admin/administrators/${encodeURIComponent(target.id)}/super-admin`,
      { method: "DELETE" },
    );
    expect(demoteRes.status).toBe(200);
    const [afterDemote] = await db
      .select({ isSuperAdmin: userTable.isSuperAdmin })
      .from(userTable)
      .where(sql`id = ${target.id}`);
    expect(afterDemote.isSuperAdmin).toBe(false);
  });

  it("grant by id returns 404 on an unknown user", async () => {
    asAdmin();
    const res = await call(
      `/api/admin/administrators/does-not-exist/roles`,
      { method: "POST", body: { roleCode: PLATFORM_ROLES.SUPPORT_ADMIN } },
    );
    expect(res.status).toBe(404);
  });

  it("revoke an invitation soft-revokes the row", async () => {
    asAdmin();
    const inviteRes = await call("/api/admin/administrators/invite", {
      method: "POST",
      body: {
        name: "Will Revoke",
        email: `will-revoke-${unique()}@example.test`,
        roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
      },
    });
    const { invitationId } = (await inviteRes.json()) as { invitationId: string };
    createdInvitationIds.push(invitationId);

    const revokeRes = await call(
      `/api/admin/administrators/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
    expect(revokeRes.status).toBe(200);
    const [row] = await db
      .select()
      .from(platformInvitations)
      .where(sql`id = ${invitationId}`);
    expect(row.revokedAt).not.toBeNull();
  });

  it("invite surfaces emailSent=false when the email transport fails", async () => {
    asAdmin();
    // Make ONLY the next sendPlatformAdminInviteEmail call throw, so we
    // do not poison sibling tests if vi.restoreAllMocks misses afterEach.
    const spy = vi
      .spyOn(platformEmails, "sendPlatformAdminInviteEmail")
      .mockRejectedValueOnce(new Error("transport down"));
    try {
      const res = await call("/api/admin/administrators/invite", {
        method: "POST",
        body: {
          name: "Email Fail",
          email: `email-fail-${unique()}@example.test`,
          roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        invitationId: string;
        emailSent: boolean;
        emailError: string | null;
      };
      createdInvitationIds.push(body.invitationId);
      expect(body.emailSent).toBe(false);
      expect(body.emailError).toBe("transport down");
      // The invitation row itself still exists — the operator can
      // resend or revoke it, but the system did not silently drop it.
      const open = await db
        .select()
        .from(platformInvitations)
        .where(sql`id = ${body.invitationId}`);
      expect(open.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("validates input via zod (400 on bad role code)", async () => {
    const target = await makeUser();
    asAdmin();
    const res = await call(
      `/api/admin/administrators/${encodeURIComponent(target.id)}/roles`,
      {
        method: "POST",
        body: { roleCode: "not_a_real_role" },
      },
    );
    expect(res.status).toBe(400);
  });
});
