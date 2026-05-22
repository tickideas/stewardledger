// packages/api/src/services/admin/administrators.ts
// Service layer for /admin/administrators: list current platform admins,
// grant/revoke explicit platform-role bindings, and promote/demote the
// super-admin bit on `user`. Every mutation writes an audit row under
// the `platform.*` action namespace so it can be queried alongside
// tenant audit history.
//
// RELEVANT FILES: packages/api/src/routes/admin-administrators.ts, packages/api/src/services/admin/platform-invitations.ts, packages/db/src/schema/roles.ts

import type { Database, Db } from "@stewardledger/db";
import {
  platformRoleBindings,
  user as userTable,
} from "@stewardledger/db/schema";
import { PLATFORM_ROLES } from "@stewardledger/shared";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";

import { writeAudit } from "../audit";

/** Platform roles that can be granted via `grantRole`. Super-admin is
 *  handled by `elevate` / `demote` so its audit action stays distinct. */
const GRANTABLE_ROLES: readonly string[] = [
  PLATFORM_ROLES.SUPPORT_ADMIN,
  PLATFORM_ROLES.BILLING_ADMIN,
  PLATFORM_ROLES.REGION_CURATOR,
];

export function isGrantableRole(code: string): boolean {
  return (GRANTABLE_ROLES as readonly string[]).includes(code);
}

export class AdminError extends Error {
  constructor(
    readonly code:
      | "user_not_found"
      | "invalid_role"
      | "already_granted"
      | "not_granted"
      | "last_super_admin"
      | "already_super_admin"
      | "not_super_admin",
    message: string,
  ) {
    super(message);
  }
}

export interface AdministratorSummary {
  userId: string;
  email: string;
  name: string | null;
  isSuperAdmin: boolean;
  platformRoles: string[];
  createdAt: string;
}

/**
 * Every user with at least one un-revoked platform-role binding OR the
 * super-admin bit. Ordered by createdAt asc so the bootstrap super-admin
 * appears first; the UI relies on this for the "you" highlight.
 */
export async function listAdministrators(
  database: Db,
): Promise<AdministratorSummary[]> {
  const rows = await database
    .select({
      userId: userTable.id,
      email: userTable.email,
      name: userTable.name,
      isSuperAdmin: userTable.isSuperAdmin,
      createdAt: userTable.createdAt,
      roleCode: platformRoleBindings.roleCode,
      bindingRevokedAt: platformRoleBindings.revokedAt,
    })
    .from(userTable)
    .leftJoin(
      platformRoleBindings,
      and(
        eq(platformRoleBindings.userId, userTable.id),
        isNull(platformRoleBindings.revokedAt),
      ),
    )
    .where(
      or(
        eq(userTable.isSuperAdmin, true),
        sql`${platformRoleBindings.id} is not null`,
      ),
    )
    .orderBy(userTable.createdAt);

  // Collapse the left-join into one row per user with a role array.
  const byUser = new Map<string, AdministratorSummary>();
  for (const r of rows) {
    let entry = byUser.get(r.userId);
    if (!entry) {
      entry = {
        userId: r.userId,
        email: r.email,
        name: r.name,
        isSuperAdmin: r.isSuperAdmin,
        platformRoles: [],
        createdAt: r.createdAt.toISOString(),
      };
      byUser.set(r.userId, entry);
    }
    if (r.roleCode && r.bindingRevokedAt === null) {
      entry.platformRoles.push(r.roleCode);
    }
  }
  return Array.from(byUser.values());
}

interface ActorContext {
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

interface UserLookup {
  id: string;
  email: string;
  isSuperAdmin: boolean;
}

async function loadUser(database: Db, userId: string): Promise<UserLookup | null> {
  const rows = await database
    .select({
      id: userTable.id,
      email: userTable.email,
      isSuperAdmin: userTable.isSuperAdmin,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function activeBindingId(
  database: Db,
  userId: string,
  roleCode: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: platformRoleBindings.id })
    .from(platformRoleBindings)
    .where(
      and(
        eq(platformRoleBindings.userId, userId),
        eq(platformRoleBindings.roleCode, roleCode),
        isNull(platformRoleBindings.revokedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Add a platform role binding for an existing user. Refuses
 * `super_admin` (use `elevate`) and any role outside the public set.
 */
export async function grantRole(
  database: Database,
  args: { targetUserId: string; roleCode: string },
  actor: ActorContext,
): Promise<{ bindingId: string }> {
  if (!isGrantableRole(args.roleCode)) {
    throw new AdminError("invalid_role", `Role ${args.roleCode} cannot be granted here.`);
  }
  const target = await loadUser(database, args.targetUserId);
  if (!target) throw new AdminError("user_not_found", "User not found.");

  return database.transaction(async (tx) => {
    const existing = await activeBindingId(tx, target.id, args.roleCode);
    if (existing) {
      throw new AdminError(
        "already_granted",
        `User already has the ${args.roleCode} role.`,
      );
    }
    const [row] = await tx
      .insert(platformRoleBindings)
      .values({
        userId: target.id,
        roleCode: args.roleCode,
        grantedByUserId: actor.actorUserId,
      })
      .returning({ id: platformRoleBindings.id });
    await writeAudit(tx, {
      zoneId: null,
      actorUserId: actor.actorUserId,
      action: "platform.admin.grant",
      entityType: "user",
      entityId: target.id,
      after: { roleCode: args.roleCode, email: target.email },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });
    return { bindingId: row.id };
  });
}

/** Soft-revoke a platform role binding. 404 if not currently active. */
export async function revokeRole(
  database: Database,
  args: { targetUserId: string; roleCode: string },
  actor: ActorContext,
): Promise<void> {
  if (!isGrantableRole(args.roleCode)) {
    throw new AdminError("invalid_role", `Role ${args.roleCode} cannot be revoked here.`);
  }
  const target = await loadUser(database, args.targetUserId);
  if (!target) throw new AdminError("user_not_found", "User not found.");

  await database.transaction(async (tx) => {
    const existing = await activeBindingId(tx, target.id, args.roleCode);
    if (!existing) {
      throw new AdminError("not_granted", `User does not hold the ${args.roleCode} role.`);
    }
    await tx
      .update(platformRoleBindings)
      .set({ revokedAt: new Date() })
      .where(eq(platformRoleBindings.id, existing));
    await writeAudit(tx, {
      zoneId: null,
      actorUserId: actor.actorUserId,
      action: "platform.admin.revoke",
      entityType: "user",
      entityId: target.id,
      before: { roleCode: args.roleCode, email: target.email },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });
  });
}

/** Flip `user.is_super_admin` to true. Idempotent: refuses if already set. */
export async function elevate(
  database: Database,
  args: { targetUserId: string },
  actor: ActorContext,
): Promise<void> {
  const target = await loadUser(database, args.targetUserId);
  if (!target) throw new AdminError("user_not_found", "User not found.");
  if (target.isSuperAdmin) {
    throw new AdminError("already_super_admin", "User is already a super-admin.");
  }
  await database.transaction(async (tx) => {
    await tx
      .update(userTable)
      .set({ isSuperAdmin: true })
      .where(eq(userTable.id, target.id));
    await writeAudit(tx, {
      zoneId: null,
      actorUserId: actor.actorUserId,
      action: "platform.admin.elevate",
      entityType: "user",
      entityId: target.id,
      after: { email: target.email, isSuperAdmin: true },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });
  });
}

/**
 * Clear `user.is_super_admin`. Refuses with `last_super_admin` if the
 * target is the only un-revoked super-admin remaining.
 */
export async function demote(
  database: Database,
  args: { targetUserId: string },
  actor: ActorContext,
): Promise<void> {
  const target = await loadUser(database, args.targetUserId);
  if (!target) throw new AdminError("user_not_found", "User not found.");
  if (!target.isSuperAdmin) {
    throw new AdminError("not_super_admin", "User is not a super-admin.");
  }

  await database.transaction(async (tx) => {
    // Lock the candidate super-admin rows so a concurrent demote can't
    // race past the count check.
    const others = await tx
      .select({ id: userTable.id })
      .from(userTable)
      .where(and(eq(userTable.isSuperAdmin, true), ne(userTable.id, target.id)))
      .for("update");
    if (others.length === 0) {
      throw new AdminError(
        "last_super_admin",
        "Cannot demote the only remaining super-admin.",
      );
    }
    await tx
      .update(userTable)
      .set({ isSuperAdmin: false })
      .where(eq(userTable.id, target.id));
    await writeAudit(tx, {
      zoneId: null,
      actorUserId: actor.actorUserId,
      action: "platform.admin.demote",
      entityType: "user",
      entityId: target.id,
      before: { email: target.email, isSuperAdmin: true },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });
  });
}

/** Internal: find user id by email (case-insensitive). */
export async function findUserIdByEmail(
  database: Db,
  email: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: userTable.id })
    .from(userTable)
    .where(sql`lower(${userTable.email}) = lower(${email})`)
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Test/util: count the active platform-role bindings for a user. Used by
 * the test suite and surfaced through the route layer for sanity checks.
 */
export async function activePlatformRoles(
  database: Db,
  userId: string,
): Promise<string[]> {
  const rows = await database
    .select({ roleCode: platformRoleBindings.roleCode })
    .from(platformRoleBindings)
    .where(
      and(
        eq(platformRoleBindings.userId, userId),
        isNull(platformRoleBindings.revokedAt),
      ),
    );
  return rows.map((r) => r.roleCode);
}
