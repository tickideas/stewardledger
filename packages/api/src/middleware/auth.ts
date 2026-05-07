// packages/api/src/middleware/auth.ts
// Session + authorization middleware. Sits on top of the tenant resolver:
//   tenantMiddleware  → requireTenantAuth   → tenant-scoped routes
//   requireSession    → requirePlatformAdmin → platform-admin routes
//
// AuthorizedContext (see @stewardledger/shared/types) is the single record of
// "who is this and what can they do in this zone".

import type { AuthorizedContext } from "@stewardledger/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import {
  platformRoleBindings,
  roles,
  user as userTable,
  userRoleBindings,
} from "@stewardledger/db/schema";
import { auth } from "../auth";
import { db } from "../db";
import type { TenantBindings } from "./tenant";

export interface SessionUser {
  id: string;
  email: string;
  isSuperAdmin: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    user?: SessionUser;
  }
}

/** Load the Better Auth session and attach the user; reject if absent. */
export const requireSession: MiddlewareHandler = async (c: Context, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: { code: "unauthenticated", message: "Sign in required" } }, 401);
  }
  // The Better Auth session user shape covers id+email; isSuperAdmin lives on our
  // user table extension.
  const rows = await db
    .select({ isSuperAdmin: userTable.isSuperAdmin })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);
  c.set("user", {
    id: session.user.id,
    email: session.user.email,
    isSuperAdmin: rows[0]?.isSuperAdmin ?? false,
  });
  await next();
};

/**
 * Require both a session and a binding for the resolved tenant. Builds an
 * AuthorizedContext with the union of the user's effective role codes within
 * the zone and the chapter ids those bindings apply to.
 *
 * Must run after `tenantMiddleware` and `requireSession`.
 */
export const requireTenantAuth: MiddlewareHandler = async (c: Context, next) => {
  const tenant = c.get("tenant") as TenantBindings | undefined;
  const sessionUser = c.get("user") as SessionUser | undefined;
  if (!tenant) {
    return c.json({ error: { code: "no_tenant", message: "Tenant not resolved" } }, 500);
  }
  if (!sessionUser) {
    return c.json({ error: { code: "unauthenticated", message: "Sign in required" } }, 401);
  }

  const bindings = await db
    .select({
      chapterId: userRoleBindings.chapterId,
      roleCode: roles.code,
    })
    .from(userRoleBindings)
    .innerJoin(roles, eq(userRoleBindings.roleId, roles.id))
    .where(
      and(
        eq(userRoleBindings.userId, sessionUser.id),
        eq(userRoleBindings.zoneId, tenant.zoneId),
        isNull(userRoleBindings.revokedAt),
      ),
    );

  // Platform admins can read any zone, but never silently. Their access is
  // surfaced via isPlatformAdmin and audited downstream.
  if (bindings.length === 0 && !sessionUser.isSuperAdmin) {
    return c.json({ error: { code: "forbidden", message: "No access to this zone" } }, 403);
  }

  const roleCodes = Array.from(new Set(bindings.map((b) => b.roleCode)));
  const chapterIds = Array.from(
    new Set(bindings.map((b) => b.chapterId).filter((id): id is string => id !== null)),
  );

  const ctx: AuthorizedContext = {
    userId: sessionUser.id,
    zoneId: tenant.zoneId,
    regionId: tenant.regionId,
    roleCodes,
    chapterIds,
    isPlatformAdmin: sessionUser.isSuperAdmin,
  };
  c.set("auth", ctx);
  await next();
};

/** Require a platform-level role (super_admin / region_curator / etc.). */
export function requirePlatformRole(...allowed: string[]): MiddlewareHandler {
  return async (c, next) => {
    const sessionUser = c.get("user") as SessionUser | undefined;
    if (!sessionUser) {
      return c.json({ error: { code: "unauthenticated", message: "Sign in required" } }, 401);
    }
    if (sessionUser.isSuperAdmin) {
      await next();
      return;
    }
    const rows = await db
      .select({ roleCode: platformRoleBindings.roleCode })
      .from(platformRoleBindings)
      .where(
        and(
          eq(platformRoleBindings.userId, sessionUser.id),
          isNull(platformRoleBindings.revokedAt),
        ),
      );
    const granted = new Set(rows.map((r) => r.roleCode));
    if (!allowed.some((code) => granted.has(code))) {
      return c.json({ error: { code: "forbidden", message: "Platform role required" } }, 403);
    }
    await next();
  };
}

/** Helper: assert the AuthorizedContext carries at least one of the given role codes. */
export function hasAnyRole(ctx: AuthorizedContext, ...codes: string[]): boolean {
  if (ctx.isPlatformAdmin) return true;
  return ctx.roleCodes.some((c) => codes.includes(c));
}
