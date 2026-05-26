// packages/api/src/routes/tenant-families.ts
// Tenant-scoped routes for the families / households surface.
// Mounted onto tenantRouter so it inherits the standard middleware stack
// (tenantMiddleware → requireSession → requireTenantAuth).
//
// Role gating reuses the existing predicates in middleware/auth.ts; no
// new role codes. Chapter clamps for chapter-tier / group-tier callers
// go through `requireChapterScope` exactly like tenant-members.ts.
// RELEVANT FILES: packages/api/src/services/families.ts, packages/db/src/schema/families.ts, packages/api/src/routes/tenant-members.ts, packages/api/src/routes/tenant.ts

import { zValidator } from "@hono/zod-validator";
import {
  CHAPTER_ROLES,
  GROUP_ROLES,
  ZONE_ROLES,
  type AuthorizedContext,
  familyCreateSchema,
  familyListQuerySchema,
  familyMemberCreateSchema,
  familyMemberUpdateSchema,
  familyTransferSchema,
  familyUpdateSchema,
} from "@stewardledger/shared";
import { Hono } from "hono";
import { db } from "../db";
import {
  hasAnyRole,
  requireChapterScope,
  visibleChapterIds,
} from "../middleware/auth";
import {
  FamilyError,
  addFamilyMember,
  createFamily,
  familyForMember,
  familyGivingTotals,
  getFamilyChapterId,
  getFamilyDetail,
  listFamiliesForCaller,
  removeFamilyMember,
  softDeleteFamily,
  transferFamily,
  updateFamily,
  updateFamilyMember,
} from "../services/families";
import { z } from "zod";

export const tenantFamiliesRouter = new Hono();

const FAMILY_ZONE_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

const FAMILY_CHAPTER_READ_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
  CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER,
] as const;

const FAMILY_GROUP_READ_ROLES = [
  GROUP_ROLES.GROUP_ADMIN,
  GROUP_ROLES.GROUP_PASTOR_VIEWER,
] as const;

const FAMILY_ZONE_WRITE_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
] as const;

const FAMILY_CHAPTER_WRITE_ROLES = [CHAPTER_ROLES.CHAPTER_ADMIN] as const;
const FAMILY_GROUP_WRITE_ROLES = [GROUP_ROLES.GROUP_ADMIN] as const;

function hasReadAccess(ctx: AuthorizedContext): boolean {
  return (
    hasAnyRole(ctx, ...FAMILY_ZONE_READ_ROLES) ||
    ctx.roleCodes.some((c) => (FAMILY_CHAPTER_READ_ROLES as readonly string[]).includes(c)) ||
    ctx.roleCodes.some((c) => (FAMILY_GROUP_READ_ROLES as readonly string[]).includes(c))
  );
}

function hasZoneWrite(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...FAMILY_ZONE_WRITE_ROLES);
}

function hasChapterWrite(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) => (FAMILY_CHAPTER_WRITE_ROLES as readonly string[]).includes(c));
}

function hasGroupWrite(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) => (FAMILY_GROUP_WRITE_ROLES as readonly string[]).includes(c));
}

function forbidden(c: { json: (b: unknown, s: number) => Response }, msg = "Insufficient role"): Response {
  return c.json({ error: { code: "forbidden", message: msg } }, 403);
}

function mapFamilyErrorStatus(code: string): 400 | 404 | 409 | 422 {
  switch (code) {
    case "family_not_found":
    case "chapter_not_found":
    case "member_not_found":
    case "family_member_not_found":
      return 404;
    case "member_already_in_family":
    case "primary_contact_already_set":
    case "primary_contact_required":
    case "family_name_taken":
    case "reference_code_collision":
    case "family_has_open_members":
    case "transfer_same_family":
    case "transfer_cross_chapter":
    case "family_deleted":
      return 409;
    case "member_chapter_mismatch":
    case "address_not_in_member":
    case "address_not_in_zone":
    case "primary_address_without_member":
      return 422;
    default:
      return 400;
  }
}

function familyErrorToJson(err: FamilyError): { code: string; message: string } {
  return { code: err.code, message: err.message };
}

/**
 * Resolve write authority for a chapter id (caller's own zone). Returns
 * a flag the route can branch on; cross-zone ids surface as 404 (chapter
 * not in this zone) — same shape as `requireChapterScope`.
 */
async function canWriteForChapter(
  ctx: AuthorizedContext,
  chapterId: string,
): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 404; code: string; message: string }
> {
  // Zone-write: full access regardless of chapter.
  if (hasZoneWrite(ctx)) {
    const scope = await requireChapterScope(ctx, chapterId, FAMILY_ZONE_READ_ROLES);
    return scope.ok
      ? { ok: true }
      : { ok: false, status: scope.status, code: scope.code, message: scope.message };
  }
  // Chapter-write: only for chapters in the caller's bindings.
  if (hasChapterWrite(ctx)) {
    const scope = await requireChapterScope(ctx, chapterId, FAMILY_ZONE_READ_ROLES);
    if (!scope.ok) return { ok: false, status: scope.status, code: scope.code, message: scope.message };
    if (!ctx.chapterIds.includes(chapterId)) {
      return { ok: false, status: 403, code: "forbidden", message: "No access to this chapter" };
    }
    return { ok: true };
  }
  // Group-write: chapters that resolve through bound groups.
  if (hasGroupWrite(ctx)) {
    const scope = await requireChapterScope(ctx, chapterId, FAMILY_ZONE_READ_ROLES);
    if (!scope.ok) return { ok: false, status: scope.status, code: scope.code, message: scope.message };
    return { ok: true };
  }
  return { ok: false, status: 403, code: "forbidden", message: "Insufficient role" };
}

// ─── List ────────────────────────────────────────────────────────────

tenantFamiliesRouter.get(
  "/families",
  zValidator("query", familyListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasReadAccess(ctx)) return forbidden(c);
    const q = c.req.valid("query");

    if (q.chapterId) {
      const scope = await requireChapterScope(ctx, q.chapterId, FAMILY_ZONE_READ_ROLES);
      if (!scope.ok) {
        return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
      }
    }

    const scope = await visibleChapterIds(ctx, FAMILY_ZONE_READ_ROLES);
    const result = await listFamiliesForCaller(db, {
      zoneId: ctx.zoneId,
      chapterIds: scope.kind === "all" ? "all" : scope.ids,
      explicitChapterId: q.chapterId,
      q: q.q,
      limit: q.limit,
      offset: q.offset,
    });
    return c.json({
      items: result.rows,
      total: result.total,
      limit: q.limit,
      offset: q.offset,
    });
  },
);

// ─── Detail ──────────────────────────────────────────────────────────

const givingRangeSchema = z
  .object({
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
  })
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  });

tenantFamiliesRouter.get(
  "/families/:id",
  zValidator("query", givingRangeSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasReadAccess(ctx)) return forbidden(c);
    const familyId = c.req.param("id");

    const chapterId = await getFamilyChapterId(db, ctx.zoneId, familyId);
    if (!chapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    const scope = await requireChapterScope(ctx, chapterId, FAMILY_ZONE_READ_ROLES);
    if (!scope.ok) {
      // Map chapter-scope failures to a generic 404 so the caller cannot
      // probe family ids to learn that a given chapter exists.
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }

    const detail = await getFamilyDetail(db, ctx.zoneId, familyId);
    if (!detail) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }

    const q = c.req.valid("query");
    const todayIso = new Date().toISOString().slice(0, 10);
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const totals = await familyGivingTotals(db, ctx.zoneId, familyId, {
      dateFrom: q.dateFrom ?? yearAgo.toISOString().slice(0, 10),
      dateTo: q.dateTo ?? todayIso,
    });

    return c.json({
      family: detail,
      givingTotals: totals,
      givingRange: {
        dateFrom: q.dateFrom ?? yearAgo.toISOString().slice(0, 10),
        dateTo: q.dateTo ?? todayIso,
      },
    });
  },
);

// ─── Family for member (convenience) ─────────────────────────────────

tenantFamiliesRouter.get("/members/:id/family", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasReadAccess(ctx)) return forbidden(c);
  const memberId = c.req.param("id");
  const family = await familyForMember(db, ctx.zoneId, memberId);
  if (!family) return c.json({ family: null });

  const scope = await requireChapterScope(ctx, family.chapterId, FAMILY_ZONE_READ_ROLES);
  if (!scope.ok) {
    return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
  }
  return c.json({ family });
});

// ─── Create ──────────────────────────────────────────────────────────

tenantFamiliesRouter.post(
  "/families",
  zValidator("json", familyCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const input = c.req.valid("json");

    const gate = await canWriteForChapter(ctx, input.chapterId);
    if (!gate.ok) {
      return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
    }

    try {
      const family = await createFamily(db, { zoneId: ctx.zoneId, userId: ctx.userId }, input);
      return c.json({ family }, 201);
    } catch (err) {
      if (err instanceof FamilyError) {
        return c.json({ error: familyErrorToJson(err) }, mapFamilyErrorStatus(err.code));
      }
      throw err;
    }
  },
);

// ─── Update ──────────────────────────────────────────────────────────

tenantFamiliesRouter.patch(
  "/families/:id",
  zValidator("json", familyUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const familyId = c.req.param("id");
    const input = c.req.valid("json");

    const chapterId = await getFamilyChapterId(db, ctx.zoneId, familyId);
    if (!chapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    const gate = await canWriteForChapter(ctx, chapterId);
    if (!gate.ok) {
      return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
    }

    try {
      const family = await updateFamily(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        familyId,
        input,
      );
      return c.json({ family });
    } catch (err) {
      if (err instanceof FamilyError) {
        return c.json({ error: familyErrorToJson(err) }, mapFamilyErrorStatus(err.code));
      }
      throw err;
    }
  },
);

// ─── Delete (soft) ───────────────────────────────────────────────────

const deleteFamilyQuery = z.object({
  reason: z.string().trim().max(500).optional(),
});

tenantFamiliesRouter.delete(
  "/families/:id",
  zValidator("query", deleteFamilyQuery),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const familyId = c.req.param("id");
    const chapterId = await getFamilyChapterId(db, ctx.zoneId, familyId);
    if (!chapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    const gate = await canWriteForChapter(ctx, chapterId);
    if (!gate.ok) {
      return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
    }

    const q = c.req.valid("query");
    try {
      await softDeleteFamily(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        familyId,
        q.reason ?? null,
      );
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof FamilyError) {
        return c.json({ error: familyErrorToJson(err) }, mapFamilyErrorStatus(err.code));
      }
      throw err;
    }
  },
);

// ─── Members of a family ─────────────────────────────────────────────

tenantFamiliesRouter.post(
  "/families/:id/members",
  zValidator("json", familyMemberCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const familyId = c.req.param("id");
    const input = c.req.valid("json");

    const chapterId = await getFamilyChapterId(db, ctx.zoneId, familyId);
    if (!chapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    const gate = await canWriteForChapter(ctx, chapterId);
    if (!gate.ok) {
      return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
    }

    try {
      const detail = await addFamilyMember(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        familyId,
        input,
      );
      return c.json({ familyMember: detail }, 201);
    } catch (err) {
      if (err instanceof FamilyError) {
        return c.json({ error: familyErrorToJson(err) }, mapFamilyErrorStatus(err.code));
      }
      throw err;
    }
  },
);

tenantFamiliesRouter.patch(
  "/families/:id/members/:memberId",
  zValidator("json", familyMemberUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const familyId = c.req.param("id");
    const memberId = c.req.param("memberId");
    const input = c.req.valid("json");

    const chapterId = await getFamilyChapterId(db, ctx.zoneId, familyId);
    if (!chapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    const gate = await canWriteForChapter(ctx, chapterId);
    if (!gate.ok) {
      return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
    }

    try {
      const detail = await updateFamilyMember(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        familyId,
        memberId,
        input,
      );
      return c.json({ familyMember: detail });
    } catch (err) {
      if (err instanceof FamilyError) {
        return c.json({ error: familyErrorToJson(err) }, mapFamilyErrorStatus(err.code));
      }
      throw err;
    }
  },
);

const familyMemberRemoveQuery = z.object({
  reason: z.string().trim().min(1).max(500),
});

tenantFamiliesRouter.delete(
  "/families/:id/members/:memberId",
  zValidator("query", familyMemberRemoveQuery),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const familyId = c.req.param("id");
    const memberId = c.req.param("memberId");
    const q = c.req.valid("query");

    const chapterId = await getFamilyChapterId(db, ctx.zoneId, familyId);
    if (!chapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    const gate = await canWriteForChapter(ctx, chapterId);
    if (!gate.ok) {
      return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
    }

    try {
      await removeFamilyMember(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        familyId,
        memberId,
        q.reason,
      );
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof FamilyError) {
        return c.json({ error: familyErrorToJson(err) }, mapFamilyErrorStatus(err.code));
      }
      throw err;
    }
  },
);

// ─── Transfer ────────────────────────────────────────────────────────

tenantFamiliesRouter.post(
  "/families/:id/transfer",
  zValidator("json", familyTransferSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const fromFamilyId = c.req.param("id");
    const input = c.req.valid("json");

    const fromChapterId = await getFamilyChapterId(db, ctx.zoneId, fromFamilyId);
    if (!fromChapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    const toChapterId = await getFamilyChapterId(db, ctx.zoneId, input.toFamilyId);
    if (!toChapterId) {
      return c.json({ error: { code: "not_found", message: "Family not found" } }, 404);
    }
    // The caller needs write authority on both ends of the transfer.
    const gateFrom = await canWriteForChapter(ctx, fromChapterId);
    if (!gateFrom.ok) {
      return c.json({ error: { code: gateFrom.code, message: gateFrom.message } }, gateFrom.status);
    }
    const gateTo = await canWriteForChapter(ctx, toChapterId);
    if (!gateTo.ok) {
      return c.json({ error: { code: gateTo.code, message: gateTo.message } }, gateTo.status);
    }

    try {
      const result = await transferFamily(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        fromFamilyId,
        input.toFamilyId,
        input.reason ?? null,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof FamilyError) {
        return c.json({ error: familyErrorToJson(err) }, mapFamilyErrorStatus(err.code));
      }
      throw err;
    }
  },
);
