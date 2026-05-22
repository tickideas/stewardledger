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

/**
 * Advisory-lock key used by `demote()` to serialise concurrent demotes
 * across the platform. The value is arbitrary; treat it as opaque.
 * Lives at module scope so a future maintainer can grep for the key
 * before adding another advisory lock that might collide.
 */
const ADVISORY_LOCK_DEMOTE_SUPER_ADMIN = 87234101938n;

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
    // The activeBindingId check above is a fast-path. A concurrent
    // grant for the same (user_id, role_code) could pass both checks
    // and then race on the partial unique index
    // `platform_role_bindings_unique_idx`. Translate the
    // unique-violation into the typed `already_granted` so the loser
    // request gets a deterministic 409 instead of a raw 500.
    let row: { id: string };
    try {
      [row] = await tx
        .insert(platformRoleBindings)
        .values({
          userId: target.id,
          roleCode: args.roleCode,
          grantedByUserId: actor.actorUserId,
        })
        .returning({ id: platformRoleBindings.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AdminError(
          "already_granted",
          `User already has the ${args.roleCode} role.`,
        );
      }
      throw err;
    }
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
    // Predicate on the current bit so a concurrent elevate that
    // already flipped the user to super-admin makes this UPDATE
    // affect zero rows; we then refuse with already_super_admin and
    // do NOT write a duplicate audit row.
    const updated = await tx
      .update(userTable)
      .set({ isSuperAdmin: true })
      .where(and(eq(userTable.id, target.id), eq(userTable.isSuperAdmin, false)))
      .returning({ id: userTable.id });
    if (updated.length === 0) {
      throw new AdminError("already_super_admin", "User is already a super-admin.");
    }
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
    // Globally serialise demote() across the platform via a constant
    // advisory lock. Without this, two demotes against different
    // targets would acquire row locks in opposite order (T1 locks B
    // while demoting A; T2 locks A while demoting B) and deadlock.
    // Demote is a rare admin action; the serialisation cost is
    // negligible and held only for the duration of this transaction.
    // The key is an arbitrary application-scoped constant; bigint to
    // match Postgres pg_advisory_xact_lock(bigint) signature.
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_DEMOTE_SUPER_ADMIN})`);

    // Now that demotes are serialised we can count safely.
    const others = await tx
      .select({ id: userTable.id })
      .from(userTable)
      .where(and(eq(userTable.isSuperAdmin, true), ne(userTable.id, target.id)));
    if (others.length === 0) {
      throw new AdminError(
        "last_super_admin",
        "Cannot demote the only remaining super-admin.",
      );
    }
    // Predicate on the current bit so a stale snapshot (e.g. the
    // target was already demoted between loadUser() and here) yields
    // not_super_admin rather than silently doing nothing.
    const updated = await tx
      .update(userTable)
      .set({ isSuperAdmin: false })
      .where(and(eq(userTable.id, target.id), eq(userTable.isSuperAdmin, true)))
      .returning({ id: userTable.id });
    if (updated.length === 0) {
      throw new AdminError("not_super_admin", "User is not a super-admin.");
    }
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

/**
 * Find a user by email (case-insensitive). Returns enough fields for
 * the grant-by-email route to render a notification email; the older
 * `findUserIdByEmail` was id-only and forced a second query.
 */
export async function findUserByEmail(
  database: Db,
  email: string,
): Promise<{ id: string; email: string; name: string | null } | null> {
  const rows = await database
    .select({ id: userTable.id, email: userTable.email, name: userTable.name })
    .from(userTable)
    .where(sql`lower(${userTable.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
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

/**
 * Detect a Postgres unique_violation (SQLSTATE 23505). `postgres-js`
 * exposes the code directly on the error; some drizzle wrappers nest
 * it under `cause`.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const direct = err as { code?: unknown; cause?: unknown };
  if (direct.code === "23505") return true;
  const cause = direct.cause;
  return Boolean(
    cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505",
  );
}
