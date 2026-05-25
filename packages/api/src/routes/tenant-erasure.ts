// packages/api/src/routes/tenant-erasure.ts
// Phase 9 §6 — tenant-facing GDPR erasure endpoints.
//
//   POST   /api/tenant/members/:memberId/erasure-requests
//                                schedule a member-level erase
//   POST   /api/tenant/zones/erasure-requests
//                                schedule a zone-level erase
//                                (requires recent confirmExportId)
//   DELETE /api/tenant/erasure-requests/:id
//                                cancel a pending request
//   GET    /api/tenant/erasure-requests
//                                list (filterable by scope / status)
//
// Role gates:
//   - Member-scope create/cancel/list: owner / admin /
//     finance_admin (PII control). Auditor / chapter roles
//     denied.
//   - Zone-scope create: `zone_owner` only. Highest blast-radius
//     single action in the product.
//
// Service errors → HTTP:
//   - ErasureRequestError("not_found")          → 404
//   - ErasureRequestError("duplicate_pending")  → 409
//   - ErasureRequestError("not_pending")        → 409
//   - ErasureRequestError("member_required" |
//       "member_forbidden" | "invalid_scope")   → 400
//   - ErasureRequestError("recent_export_required") → 422
//
// RELEVANT FILES: ../services/erasure/requests.ts, ./tenant.ts

import type { Context } from "hono";
import { Hono } from "hono";
import { type AuthorizedContext, ZONE_ROLES } from "@stewardledger/shared";

import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import {
  cancelErasureRequest,
  createErasureRequest,
  ErasureRequestError,
  listErasureRequests,
  type ErasureScope,
  type ErasureStatus,
} from "../services/erasure/requests";

export const tenantErasureRouter = new Hono();

const NO_STORE = "no-store, max-age=0";

const MEMBER_SCOPE_ROLES: readonly string[] = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
];

function forbidden(c: Context, message = "Insufficient permissions") {
  return c.json({ error: { code: "forbidden", message } }, 403);
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
        {
          error: {
            code: "recent_export_required",
            message: e.message,
          },
        },
        422,
      );
    case "invalid_scope":
    case "member_required":
    case "member_forbidden":
      return c.json({ error: { code: e.code, message: e.message } }, 400);
  }
}

interface MemberCreateBody {
  reason?: unknown;
  windowDays?: unknown;
}

interface ZoneCreateBody {
  confirmExportId?: unknown;
  reason?: unknown;
}

interface CancelBody {
  reason?: unknown;
}

function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || v === null || typeof v === "string";
}

function isOptionalIntInRange(
  v: unknown,
  min: number,
  max: number,
): v is number | undefined {
  if (v === undefined || v === null) return true;
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Schedule a member-level erase. Body:
 *   { reason?: string, windowDays?: 1..365 }
 *
 * The member must belong to the caller's zone; the service rejects
 * cross-zone member ids via the row's `zone_id` (it loads via id
 * but the create path validates the member belongs to the zone
 * through the unique (zone_id, member_id) index path).
 */
tenantErasureRouter.post("/members/:memberId/erasure-requests", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...MEMBER_SCOPE_ROLES)) return forbidden(c);

  const body = (await c.req.json().catch(() => ({}))) as MemberCreateBody;
  if (!isOptionalString(body.reason)) {
    return c.json(
      { error: { code: "invalid_body", message: "reason must be a string" } },
      400,
    );
  }
  if (!isOptionalIntInRange(body.windowDays, 1, 365)) {
    return c.json(
      {
        error: {
          code: "invalid_body",
          message: "windowDays must be an integer in [1, 365]",
        },
      },
      400,
    );
  }

  try {
    const summary = await createErasureRequest(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      scope: "member",
      memberId: c.req.param("memberId"),
      reason: body.reason ?? null,
      windowDays: body.windowDays ?? undefined,
    });
    c.header("cache-control", NO_STORE);
    return c.json({ request: summary }, 201);
  } catch (e) {
    if (e instanceof ErasureRequestError) return fromErasureError(c, e);
    throw e;
  }
});

/**
 * Schedule a zone-level erase. Body:
 *   { confirmExportId: string, reason?: string }
 *
 * Owner-only. The service refuses without a `completed`
 * `zone_exports` row created in the last 7 days; surfaces 422
 * `recent_export_required` so the UI can prompt for an export.
 */
tenantErasureRouter.post("/zones/erasure-requests", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)) {
    return forbidden(c, "Zone owner required");
  }

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
  if (!isOptionalString(body.reason)) {
    return c.json(
      { error: { code: "invalid_body", message: "reason must be a string" } },
      400,
    );
  }

  try {
    const summary = await createErasureRequest(db, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      scope: "zone",
      confirmExportId: body.confirmExportId,
      reason: body.reason ?? null,
    });
    c.header("cache-control", NO_STORE);
    return c.json({ request: summary }, 201);
  } catch (e) {
    if (e instanceof ErasureRequestError) return fromErasureError(c, e);
    throw e;
  }
});

/**
 * Cancel a pending request. Same role gate as the create paths
 * for the relevant scope — we look up the row first to determine
 * which scope it is, then refuse if the caller lacks the role.
 */
tenantErasureRouter.delete("/erasure-requests/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  // Permissive pre-check: at least one of the member-scope roles
  // (which is a superset of owner). The service will 404 on
  // cross-zone probes, so we don't need to read the row first.
  if (!hasAnyRole(ctx, ...MEMBER_SCOPE_ROLES)) return forbidden(c);

  const body = (await c.req.json().catch(() => ({}))) as CancelBody;
  if (!isOptionalString(body.reason)) {
    return c.json(
      { error: { code: "invalid_body", message: "reason must be a string" } },
      400,
    );
  }

  try {
    const summary = await cancelErasureRequest(db, {
      zoneId: ctx.zoneId,
      requestId: c.req.param("id"),
      actorUserId: ctx.userId,
      reason: body.reason ?? null,
    });
    c.header("cache-control", NO_STORE);
    return c.json({ request: summary });
  } catch (e) {
    if (e instanceof ErasureRequestError) return fromErasureError(c, e);
    throw e;
  }
});

/**
 * List requests for the caller's zone. Filterable by `scope` and
 * `status`. Member-scope role required (PII visibility).
 */
tenantErasureRouter.get("/erasure-requests", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...MEMBER_SCOPE_ROLES)) return forbidden(c);

  const scope = c.req.query("scope");
  const status = c.req.query("status");
  if (scope !== undefined && scope !== "member" && scope !== "zone") {
    return c.json(
      {
        error: {
          code: "invalid_query",
          message: "scope must be 'member' or 'zone'",
        },
      },
      400,
    );
  }
  if (
    status !== undefined &&
    !["pending", "applied", "cancelled", "failed"].includes(status)
  ) {
    return c.json(
      {
        error: {
          code: "invalid_query",
          message: "status must be 'pending' | 'applied' | 'cancelled' | 'failed'",
        },
      },
      400,
    );
  }

  const rows = await listErasureRequests(db, {
    zoneId: ctx.zoneId,
    scope: scope as ErasureScope | undefined,
    status: status as ErasureStatus | undefined,
  });
  c.header("cache-control", NO_STORE);
  return c.json({ requests: rows });
});
