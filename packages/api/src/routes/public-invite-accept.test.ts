// packages/api/src/routes/public-invite-accept.test.ts
// Tests the orphan-user cleanup on invitation-accept failure. When
// applyAcceptedInvitation (zone) or applyAcceptedPlatformInvitation
// (platform) throws after signUpEmail has already created the auth
// user, the route must delete that user row so the same email can be
// re-invited.
//
// We stub the lookup + apply services so the test does not need a
// full zone fixture; the cleanup behaviour is what we're pinning.
//
// RELEVANT FILES: packages/api/src/routes/public.ts, packages/api/src/services/invitations.ts

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { user as userTable } from "@stewardledger/db/schema";

import { createApp } from "../app";
import { db } from "../db";
import * as platformInvitationsService from "../services/admin/platform-invitations";
import * as invitationsService from "../services/invitations";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const app = createApp();
const URL_BASE = "http://localhost";

async function call(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`${URL_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const createdUserIds: string[] = [];

beforeAll(() => {
  if (!process.env.DATABASE_URL?.includes("_test")) {
    throw new Error("public-invite-accept.test.ts requires a *_test DATABASE_URL");
  }
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(userTable).where(inArray(userTable.id, createdUserIds));
  }
});

async function userExistsByEmail(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(sql`lower(email) = lower(${email})`);
  return rows.length > 0;
}

describe("zone invitation accept: orphan-user cleanup", () => {
  it("deletes the just-created user when applyAcceptedInvitation throws", async () => {
    const email = `orphan-zone-${unique()}@example.test`;
    const fakeInv: Awaited<ReturnType<typeof invitationsService.findInvitationByToken>> = {
      id: `inv-${unique()}`,
      zoneId: `zone-${unique()}`,
      zoneSlug: `zone-${unique()}`,
      zoneName: "Mocked Zone",
      email,
      roleCode: "zone_owner",
      chapterId: null,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
    };
    const lookupSpy = vi
      .spyOn(invitationsService, "findInvitationByToken")
      .mockResolvedValue(fakeInv);
    const applySpy = vi
      .spyOn(invitationsService, "applyAcceptedInvitation")
      .mockRejectedValue(new Error("simulated apply failure"));

    try {
      const res = await call("/api/public/invitations/accept", {
        token: "x".repeat(40),
        name: "Orphan Test",
        password: "Orphan#Pass123!",
      });
      // Non-InvitationError bubbles to the framework as 500. We don't
      // care about the exact code here; we care that the user row is
      // gone.
      expect([400, 409, 500]).toContain(res.status);

      expect(await userExistsByEmail(email)).toBe(false);
    } finally {
      lookupSpy.mockRestore();
      applySpy.mockRestore();
    }
  });

  it("happy path: no apply failure means the user persists", async () => {
    const email = `orphan-zone-ok-${unique()}@example.test`;
    const fakeInv: Awaited<ReturnType<typeof invitationsService.findInvitationByToken>> = {
      id: `inv-${unique()}`,
      zoneId: `zone-${unique()}`,
      zoneSlug: `zone-${unique()}`,
      zoneName: "Mocked Zone",
      email,
      roleCode: "zone_owner",
      chapterId: null,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
    };
    const lookupSpy = vi
      .spyOn(invitationsService, "findInvitationByToken")
      .mockResolvedValue(fakeInv);
    const applySpy = vi
      .spyOn(invitationsService, "applyAcceptedInvitation")
      .mockResolvedValue({ zoneId: fakeInv.zoneId });

    try {
      const res = await call("/api/public/invitations/accept", {
        token: "x".repeat(40),
        name: "Happy Path",
        password: "Happy#Pass123!",
      });
      expect(res.status).toBe(200);
      expect(await userExistsByEmail(email)).toBe(true);

      // Record so afterAll cleans them up.
      const [row] = await db
        .select({ id: userTable.id })
        .from(userTable)
        .where(sql`lower(email) = lower(${email})`);
      if (row) createdUserIds.push(row.id);
    } finally {
      lookupSpy.mockRestore();
      applySpy.mockRestore();
    }
  });
});

describe("platform invitation accept: orphan-user cleanup", () => {
  it("deletes the just-created user when applyAcceptedPlatformInvitation throws", async () => {
    const email = `orphan-platform-${unique()}@example.test`;
    const fakeInv: Awaited<
      ReturnType<typeof platformInvitationsService.findPlatformInvitationByToken>
    > = {
      id: `pinv-${unique()}`,
      email,
      name: "Orphan Platform",
      roleCode: "support_admin",
      superAdmin: false,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
    };
    const lookupSpy = vi
      .spyOn(platformInvitationsService, "findPlatformInvitationByToken")
      .mockResolvedValue(fakeInv);
    const applySpy = vi
      .spyOn(platformInvitationsService, "applyAcceptedPlatformInvitation")
      .mockRejectedValue(new Error("simulated platform apply failure"));

    try {
      const res = await call("/api/public/platform-invitations/accept", {
        token: "x".repeat(40),
        name: "Orphan Platform",
        password: "Orphan#Plat123!",
      });
      expect([400, 409, 500]).toContain(res.status);
      expect(await userExistsByEmail(email)).toBe(false);
    } finally {
      lookupSpy.mockRestore();
      applySpy.mockRestore();
    }
  });
});
