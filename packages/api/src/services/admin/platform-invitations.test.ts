// packages/api/src/services/admin/platform-invitations.test.ts
// Integration tests for the platform-invitations service: create, list,
// revoke, lookup, accept. Audit rows are asserted under the
// platform.* namespace.
//
// RELEVANT FILES: packages/api/src/services/admin/platform-invitations.ts

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEvents,
  platformInvitations,
  platformRoleBindings,
  user as userTable,
} from "@stewardledger/db/schema";
import { PLATFORM_ROLES } from "@stewardledger/shared";

import { db } from "../../db";
import {
  applyAcceptedPlatformInvitation,
  createPlatformInvitation,
  findPlatformInvitationByToken,
  listOpenPlatformInvitations,
  PlatformInvitationError,
  revokePlatformInvitation,
} from "./platform-invitations";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const createdUserIds: string[] = [];
const createdInvitationIds: string[] = [];

async function makeUser(opts: { isSuperAdmin?: boolean } = {}): Promise<{
  id: string;
  email: string;
}> {
  const id = `pu-${unique()}-${unique()}`;
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

describe("platform-invitations service", () => {
  let actorId: string;

  beforeAll(async () => {
    actorId = (await makeUser({ isSuperAdmin: true })).id;
  });

  it("creates an invitation, writes a platform.admin.invite audit row, and the token resolves", async () => {
    const email = `invite-${unique()}@example.test`;
    const created = await createPlatformInvitation(
      db,
      {
        email,
        name: "Pat Treasurer",
        roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
        createdByUserId: actorId,
      },
      { actorUserId: actorId },
    );
    createdInvitationIds.push(created.id);
    expect(created.token.length).toBeGreaterThan(20);

    const lookup = await findPlatformInvitationByToken(db, created.token);
    expect(lookup?.email).toBe(email);
    expect(lookup?.roleCode).toBe(PLATFORM_ROLES.SUPPORT_ADMIN);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        sql`action = 'platform.admin.invite' and entity_id = ${created.id}`,
      );
    expect(audit.length).toBe(1);
    expect(audit[0].zoneId).toBeNull();
  });

  it("refuses to invite an email that already exists as a user", async () => {
    const existing = await makeUser();
    await expect(
      createPlatformInvitation(
        db,
        {
          email: existing.email,
          name: "Should Not Invite",
          roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
          createdByUserId: actorId,
        },
        { actorUserId: actorId },
      ),
    ).rejects.toMatchObject({ code: "email_already_user" });
  });

  it("refuses super_admin in roleCode (use the superAdmin flag instead)", async () => {
    await expect(
      createPlatformInvitation(
        db,
        {
          email: `${unique()}@example.test`,
          name: "Whoever",
          roleCode: PLATFORM_ROLES.SUPER_ADMIN,
          createdByUserId: actorId,
        },
        { actorUserId: actorId },
      ),
    ).rejects.toMatchObject({ code: "invalid_role" });
  });

  it("re-issuing for the same (email, role) revokes the prior open invitation", async () => {
    const email = `reissue-${unique()}@example.test`;
    const first = await createPlatformInvitation(
      db,
      {
        email,
        name: "First Try",
        roleCode: PLATFORM_ROLES.BILLING_ADMIN,
        createdByUserId: actorId,
      },
      { actorUserId: actorId },
    );
    const second = await createPlatformInvitation(
      db,
      {
        email,
        name: "Second Try",
        roleCode: PLATFORM_ROLES.BILLING_ADMIN,
        createdByUserId: actorId,
      },
      { actorUserId: actorId },
    );
    createdInvitationIds.push(first.id, second.id);

    const [firstRow] = await db
      .select()
      .from(platformInvitations)
      .where(sql`id = ${first.id}`);
    expect(firstRow.revokedAt).not.toBeNull();
    const open = await listOpenPlatformInvitations(db);
    expect(open.find((o) => o.id === first.id)).toBeUndefined();
    expect(open.find((o) => o.id === second.id)).toBeDefined();
  });

  it("revokePlatformInvitation soft-revokes an open invitation and audits", async () => {
    const created = await createPlatformInvitation(
      db,
      {
        email: `revoke-${unique()}@example.test`,
        name: "To Revoke",
        roleCode: PLATFORM_ROLES.REGION_CURATOR,
        createdByUserId: actorId,
      },
      { actorUserId: actorId },
    );
    createdInvitationIds.push(created.id);
    await revokePlatformInvitation(
      db,
      { invitationId: created.id },
      { actorUserId: actorId },
    );
    const [row] = await db
      .select()
      .from(platformInvitations)
      .where(sql`id = ${created.id}`);
    expect(row.revokedAt).not.toBeNull();

    // A second revoke 404s.
    await expect(
      revokePlatformInvitation(
        db,
        { invitationId: created.id },
        { actorUserId: actorId },
      ),
    ).rejects.toMatchObject({ code: "invitation_revoked" });
  });

  it("applyAcceptedPlatformInvitation grants the role + super-admin bit + writes binding + audits", async () => {
    const created = await createPlatformInvitation(
      db,
      {
        email: `accept-${unique()}@example.test`,
        name: "Accepter",
        roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
        superAdmin: true,
        createdByUserId: actorId,
      },
      { actorUserId: actorId },
    );
    createdInvitationIds.push(created.id);

    // Simulate Better Auth user creation: write the row directly.
    const acceptUser = await makeUser();

    const result = await applyAcceptedPlatformInvitation(db, {
      invitationId: created.id,
      userId: acceptUser.id,
    });
    expect(result.roleCode).toBe(PLATFORM_ROLES.SUPPORT_ADMIN);
    expect(result.superAdmin).toBe(true);

    const [acceptedRow] = await db
      .select()
      .from(platformInvitations)
      .where(sql`id = ${created.id}`);
    expect(acceptedRow.acceptedAt).not.toBeNull();
    expect(acceptedRow.acceptedByUserId).toBe(acceptUser.id);

    const bindings = await db
      .select()
      .from(platformRoleBindings)
      .where(sql`user_id = ${acceptUser.id}`);
    expect(bindings.map((b) => b.roleCode)).toContain(
      PLATFORM_ROLES.SUPPORT_ADMIN,
    );

    const [u] = await db
      .select({ isSuperAdmin: userTable.isSuperAdmin })
      .from(userTable)
      .where(sql`id = ${acceptUser.id}`);
    expect(u.isSuperAdmin).toBe(true);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        sql`action = 'platform.admin.invite_accept' and entity_id = ${created.id}`,
      );
    expect(audit.length).toBe(1);
  });

  it("applyAcceptedPlatformInvitation refuses an already-used invitation", async () => {
    const created = await createPlatformInvitation(
      db,
      {
        email: `once-${unique()}@example.test`,
        name: "Once",
        roleCode: PLATFORM_ROLES.SUPPORT_ADMIN,
        createdByUserId: actorId,
      },
      { actorUserId: actorId },
    );
    createdInvitationIds.push(created.id);
    const u = await makeUser();
    await applyAcceptedPlatformInvitation(db, {
      invitationId: created.id,
      userId: u.id,
    });
    await expect(
      applyAcceptedPlatformInvitation(db, {
        invitationId: created.id,
        userId: u.id,
      }),
    ).rejects.toMatchObject({ code: "invitation_already_accepted" });
  });

  it("findPlatformInvitationByToken returns null for an unknown token", async () => {
    const lookup = await findPlatformInvitationByToken(db, "totally-bogus");
    expect(lookup).toBeNull();
  });

  it("PlatformInvitationError preserves the discriminant", () => {
    const err = new PlatformInvitationError("invalid_role", "x");
    expect(err.code).toBe("invalid_role");
  });
});
