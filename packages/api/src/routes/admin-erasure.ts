// packages/api/src/routes/admin-erasure.ts
// Phase 9 §6 — platform-admin parallel of the tenant erasure
// surface, scoped to the zone-level path. The use case is a
// tenant whose owner has lost access (abandoned account,
// disputed handover); the super-admin acts on their behalf.
//
//   POST   /api/admin/zones/:slug/erasure-requests
//                                schedule a zone-level erase
//   DELETE /api/admin/zones/:slug/erasure-requests/:id
//                                cancel a pending request
//   GET    /api/admin/zones/:slug/erasure-requests
//                                list (zone-scope only)
//
// Super-admin only. Body shape + error contract mirror
// `tenant-erasure.ts`. We deliberately do NOT expose member-
// level erasure through this surface — the tenant's own admin
// stack handles those; cross-tenant member visibility is out
// of scope for v1.
//
// RELEVANT FILES: ../services/erasure/requests.ts,
//                 ./tenant-erasure.ts (mirrored shape),
//                 ./admin.ts (router mount + super-admin gate)

import type { Context } from "hono";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { zones } from "@stewardledger/db/schema";
import { PLATFORM_ROLES } from "@stewardledger/shared";

import { db } from "../db";
import {
  requirePlatformRole,
  requireSession,
  type SessionUser,
} from "../middleware/auth";
import {
  cancelErasureRequest,
  createErasureRequest,
  ErasureRequestError,
  listErasureRequests,
} from "../services/erasure/requests";

export const adminErasureRouter = new Hono();

// Mirror adminRouter's wider platform-role gate so support /
// region admins fall through to other admin routes mounted at
// the same prefix. Each route below tightens to super-admin
// inline; sibling admin routes (admin.ts) keep their own gates.
adminErasureRouter.use(
  "*",
  requireSession,
  requirePlatformRole(
    PLATFORM_ROLES.SUPER_ADMIN,
    PLATFORM_ROLES.REGION_CURATOR,
    PLATFORM_ROLES.SUPPORT_ADMIN,
  ),
);

const NO_STORE = "no-store, max-age=0";

function forbidden(c: Context, message = "Super-admin required") {
  return c.json({ error: { code: "forbidden", message } }, 403);
}

function notFound(c: Context, message = "Zone not found") {
  return c.json({ error: { code: "not_found", message } }, 404);
}

function requireSuperAdmin(c: Context): Response | null {
  const user = c.get("user") as SessionUser;
  if (!user.isSuperAdmin) return forbidden(c);
  return null;
}

/**
 * Resolve a zone slug → id. Returns null when the slug doesn't
 * match a live zone (the admin surface intentionally refuses
 * already-soft-deleted zones; a half-purged tenant should not
 * be re-erased via this surface).
 */
async function resolveZoneId(slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.slug, slug)))
    .limit(1);
  return row?.id ?? null;
}

function fromErasureError(c: Context, e: ErasureRequestError) {
  switch (e.code) {
    case "not_found":
      return c.json({ error: { code: "not_found", message: e.message } }, 404);
    case "not_pending":
      return c.json(
        { error: { code: "not_pending", message: e.message } },
        409,
      );
    case "duplicate_pending":
      return c.json(
        {
          error: {
            code: "duplicate_pending",
            message: e.message,
            details: e.details ?? {},
          },
        },
        409,
      );
    case "recent_export_required":
      return c.json(
        { error: { code: "recent_export_required", message: e.message } },
        422,
      );
    case "invalid_scope":
    case "member_required":
    case "member_forbidden":
      return c.json({ error: { code: e.code, message: e.message } }, 400);
  }
}

interface ZoneCreateBody {
  confirmExportId?: unknown;
  reason?: unknown;
}

interface CancelBody {
  reason?: unknown;
}

adminErasureRouter.post("/zones/:slug/erasure-requests", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const user = c.get("user") as SessionUser;
  const zoneId = await resolveZoneId(c.req.param("slug"));
  if (!zoneId) return notFound(c);

  const body = (await c.req.json().catch(() => ({}))) as ZoneCreateBody;
  if (typeof body.confirmExportId !== "string" || !body.confirmExportId) {
    return c.json(
      {
        error: {
          code: "invalid_body",
          message: "confirmExportId is required",
        },
      },
      400,
    );
  }
  if (body.reason !== undefined && typeof body.reason !== "string") {
    return c.json(
      { error: { code: "invalid_body", message: "reason must be a string" } },
      400,
    );
  }

  try {
    const summary = await createErasureRequest(db, {
      zoneId,
      actorUserId: user.id,
      scope: "zone",
      confirmExportId: body.confirmExportId,
      reason: (body.reason as string | undefined) ?? null,
    });
    c.header("cache-control", NO_STORE);
    return c.json({ request: summary }, 201);
  } catch (e) {
    if (e instanceof ErasureRequestError) return fromErasureError(c, e);
    throw e;
  }
});

adminErasureRouter.delete(
  "/zones/:slug/erasure-requests/:id",
  async (c) => {
    const denied = requireSuperAdmin(c);
    if (denied) return denied;
    const user = c.get("user") as SessionUser;
    const zoneId = await resolveZoneId(c.req.param("slug"));
    if (!zoneId) return notFound(c);

    const body = (await c.req.json().catch(() => ({}))) as CancelBody;
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return c.json(
        { error: { code: "invalid_body", message: "reason must be a string" } },
        400,
      );
    }

    try {
      const summary = await cancelErasureRequest(db, {
        zoneId,
        requestId: c.req.param("id"),
        actorUserId: user.id,
        reason: (body.reason as string | undefined) ?? null,
      });
      c.header("cache-control", NO_STORE);
      return c.json({ request: summary });
    } catch (e) {
      if (e instanceof ErasureRequestError) return fromErasureError(c, e);
      throw e;
    }
  },
);

adminErasureRouter.get("/zones/:slug/erasure-requests", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const zoneId = await resolveZoneId(c.req.param("slug"));
  if (!zoneId) return notFound(c);
  // Admin surface lists ONLY zone-scope rows. Member-scope
  // visibility for cross-tenant operators is out of scope for v1.
  const rows = await listErasureRequests(db, {
    zoneId,
    scope: "zone",
  });
  c.header("cache-control", NO_STORE);
  return c.json({ requests: rows });
});
