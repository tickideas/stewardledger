// packages/api/src/routes/tenant-contributions.ts
// Phase 5 — tenant-scoped contribution + batch write paths.
// Mounted onto tenantRouter so it inherits the same middleware stack
// (tenantMiddleware → requireSession → requireTenantAuth).

import { zValidator } from "@hono/zod-validator";
import {
  CHAPTER_ROLES,
  ZONE_ROLES,
  contributionBatchCreateSchema,
  contributionBatchListQuerySchema,
  contributionBatchUpdateSchema,
  contributionBatchVoidSchema,
  contributionCreateSchema,
  contributionListQuerySchema,
  contributionReverseSchema,
  contributionUpdateSchema,
  contributionVoidSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { Hono } from "hono";
import { hasAnyRole, requireChapterScope, visibleChapterIds } from "../middleware/auth";
import {
  ContributionError,
  createContribution,
  deleteDraftContribution,
  errorStatusFor,
  getContribution,
  listContributions,
  postContribution,
  reverseContribution,
  updateDraftContribution,
  voidContribution,
} from "../services/contributions";
import {
  approveBatch,
  createBatch,
  getBatch,
  listBatches,
  postBatch,
  submitBatch,
  updateDraftBatch,
  voidBatch,
} from "../services/contribution-batches";
import { db } from "../db";

export const tenantContributionsRouter = new Hono();

// Roles that can read contributions zone-wide.
const CONTRIB_ZONE_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

// Chapter-scoped read.
const CONTRIB_CHAPTER_READ_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
  CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER,
] as const;

// Roles that can create / edit drafts.
const CONTRIB_ZONE_WRITE_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
] as const;

const CONTRIB_CHAPTER_WRITE_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
] as const;

// Roles that can post / void / reverse. Bookkeeper is intentionally
// excluded — they draft, they don't approve money out the door.
const CONTRIB_ZONE_POST_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
] as const;

const CONTRIB_CHAPTER_POST_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
] as const;

function hasZoneRead(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...CONTRIB_ZONE_READ_ROLES);
}
function hasChapterRead(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) => (CONTRIB_CHAPTER_READ_ROLES as readonly string[]).includes(c));
}
function hasZoneWrite(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...CONTRIB_ZONE_WRITE_ROLES);
}
function hasChapterWrite(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) => (CONTRIB_CHAPTER_WRITE_ROLES as readonly string[]).includes(c));
}
function hasZonePost(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...CONTRIB_ZONE_POST_ROLES);
}
function hasChapterPost(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) => (CONTRIB_CHAPTER_POST_ROLES as readonly string[]).includes(c));
}

function canReadContribution(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneRead(ctx)) return true;
  return chapterId !== null && hasChapterRead(ctx) && ctx.chapterIds.includes(chapterId);
}

function canWriteContribution(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneWrite(ctx)) return true;
  return chapterId !== null && hasChapterWrite(ctx) && ctx.chapterIds.includes(chapterId);
}

function canPostContribution(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZonePost(ctx)) return true;
  return chapterId !== null && hasChapterPost(ctx) && ctx.chapterIds.includes(chapterId);
}

function forbidden(c: { json: (b: unknown, s: number) => Response }, msg = "Insufficient role"): Response {
  return c.json({ error: { code: "forbidden", message: msg } }, 403);
}

function handleError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ContributionError) {
    return c.json({ error: { code: err.code, message: err.message } }, errorStatusFor(err.code));
  }
  throw err;
}

// ─── Contributions ───────────────────────────────────────────────────

tenantContributionsRouter.get(
  "/contributions",
  zValidator("query", contributionListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
    const q = c.req.valid("query");
    // Reject cross-zone or unauthorised chapter ids loudly. Without this,
    // `?chapterId=<other-zone-uuid>` silently returns an empty list.
    if (q.chapterId) {
      const scope = await requireChapterScope(ctx, q.chapterId, CONTRIB_ZONE_READ_ROLES);
      if (!scope.ok) {
        return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
      }
    }
    const scope = await visibleChapterIds(ctx, CONTRIB_ZONE_READ_ROLES);
    if (scope.kind === "list" && scope.ids.length === 0) {
      return c.json({ items: [], total: 0, limit: q.limit, offset: q.offset });
    }
    const result = await listContributions(db, ctx.zoneId, q, {
      chapterIds: scope.kind === "all" ? undefined : scope.ids,
    });
    return c.json(result);
  },
);

tenantContributionsRouter.get("/contributions/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
  const id = c.req.param("id");
  const detail = await getContribution(db, ctx.zoneId, id);
  if (!detail) return c.json({ error: { code: "not_found", message: "Contribution not found" } }, 404);
  if (!canReadContribution(ctx, detail.contribution.chapterId)) return forbidden(c);
  return c.json({ contribution: detail.contribution, lines: detail.lines, members: detail.members });
});

tenantContributionsRouter.post(
  "/contributions",
  zValidator("json", contributionCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const input = c.req.valid("json");
    if (!canWriteContribution(ctx, input.chapterId)) return forbidden(c);
    try {
      const detail = await createContribution(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        input,
      );
      return c.json(
        { contribution: detail.contribution, lines: detail.lines, members: detail.members },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  },
);

tenantContributionsRouter.patch(
  "/contributions/:id",
  zValidator("json", contributionUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const existing = await getContribution(db, ctx.zoneId, id);
    if (!existing)
      return c.json({ error: { code: "not_found", message: "Contribution not found" } }, 404);
    if (!canWriteContribution(ctx, existing.contribution.chapterId)) return forbidden(c);
    try {
      const detail = await updateDraftContribution(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        id,
        input,
      );
      return c.json({ contribution: detail.contribution, lines: detail.lines, members: detail.members });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

tenantContributionsRouter.delete("/contributions/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const existing = await getContribution(db, ctx.zoneId, id);
  if (!existing)
    return c.json({ error: { code: "not_found", message: "Contribution not found" } }, 404);
  if (!canWriteContribution(ctx, existing.contribution.chapterId)) return forbidden(c);
  try {
    await deleteDraftContribution(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id);
    return c.json({ status: "deleted" });
  } catch (err) {
    return handleError(c, err);
  }
});

tenantContributionsRouter.post("/contributions/:id/post", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const existing = await getContribution(db, ctx.zoneId, id);
  if (!existing)
    return c.json({ error: { code: "not_found", message: "Contribution not found" } }, 404);
  if (!canPostContribution(ctx, existing.contribution.chapterId)) return forbidden(c);
  try {
    const posted = await postContribution(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id);
    return c.json({ contribution: posted });
  } catch (err) {
    return handleError(c, err);
  }
});

tenantContributionsRouter.post(
  "/contributions/:id/void",
  zValidator("json", contributionVoidSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const existing = await getContribution(db, ctx.zoneId, id);
    if (!existing)
      return c.json({ error: { code: "not_found", message: "Contribution not found" } }, 404);
    if (!canPostContribution(ctx, existing.contribution.chapterId)) return forbidden(c);
    try {
      const voided = await voidContribution(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        id,
        input,
      );
      return c.json({ contribution: voided });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

tenantContributionsRouter.post(
  "/contributions/:id/reverse",
  zValidator("json", contributionReverseSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const existing = await getContribution(db, ctx.zoneId, id);
    if (!existing)
      return c.json({ error: { code: "not_found", message: "Contribution not found" } }, 404);
    if (!canPostContribution(ctx, existing.contribution.chapterId)) return forbidden(c);
    try {
      const detail = await reverseContribution(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        id,
        input,
      );
      return c.json(
        { contribution: detail.contribution, lines: detail.lines, members: detail.members },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  },
);

// ─── Batches ─────────────────────────────────────────────────────────

tenantContributionsRouter.get(
  "/contribution-batches",
  zValidator("query", contributionBatchListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
    const q = c.req.valid("query");
    if (q.chapterId) {
      const scope = await requireChapterScope(ctx, q.chapterId, CONTRIB_ZONE_READ_ROLES);
      if (!scope.ok) {
        return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
      }
    }
    const scope = await visibleChapterIds(ctx, CONTRIB_ZONE_READ_ROLES);
    if (scope.kind === "list" && scope.ids.length === 0) {
      return c.json({ items: [], total: 0, limit: q.limit, offset: q.offset });
    }
    const result = await listBatches(db, ctx.zoneId, q, {
      chapterIds: scope.kind === "all" ? undefined : scope.ids,
    });
    return c.json(result);
  },
);

tenantContributionsRouter.get("/contribution-batches/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
  const id = c.req.param("id");
  const batch = await getBatch(db, ctx.zoneId, id);
  if (!batch) return c.json({ error: { code: "not_found", message: "Batch not found" } }, 404);
  if (!canReadContribution(ctx, batch.chapterId)) return forbidden(c);
  return c.json({ batch });
});

tenantContributionsRouter.post(
  "/contribution-batches",
  zValidator("json", contributionBatchCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const input = c.req.valid("json");
    if (!canWriteContribution(ctx, input.chapterId)) return forbidden(c);
    try {
      const batch = await createBatch(db, { zoneId: ctx.zoneId, userId: ctx.userId }, input);
      return c.json({ batch }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  },
);

tenantContributionsRouter.patch(
  "/contribution-batches/:id",
  zValidator("json", contributionBatchUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const existing = await getBatch(db, ctx.zoneId, id);
    if (!existing) return c.json({ error: { code: "not_found", message: "Batch not found" } }, 404);
    if (!canWriteContribution(ctx, existing.chapterId)) return forbidden(c);
    try {
      const batch = await updateDraftBatch(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        id,
        input,
      );
      return c.json({ batch });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

tenantContributionsRouter.post("/contribution-batches/:id/submit", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const existing = await getBatch(db, ctx.zoneId, id);
  if (!existing) return c.json({ error: { code: "not_found", message: "Batch not found" } }, 404);
  if (!canWriteContribution(ctx, existing.chapterId)) return forbidden(c);
  try {
    const batch = await submitBatch(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id);
    return c.json({ batch });
  } catch (err) {
    return handleError(c, err);
  }
});

tenantContributionsRouter.post("/contribution-batches/:id/approve", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const existing = await getBatch(db, ctx.zoneId, id);
  if (!existing) return c.json({ error: { code: "not_found", message: "Batch not found" } }, 404);
  if (!canPostContribution(ctx, existing.chapterId)) return forbidden(c);
  try {
    const batch = await approveBatch(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id);
    return c.json({ batch });
  } catch (err) {
    return handleError(c, err);
  }
});

tenantContributionsRouter.post("/contribution-batches/:id/post", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const existing = await getBatch(db, ctx.zoneId, id);
  if (!existing) return c.json({ error: { code: "not_found", message: "Batch not found" } }, 404);
  if (!canPostContribution(ctx, existing.chapterId)) return forbidden(c);
  try {
    const result = await postBatch(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id);
    return c.json({ batch: result.batch, postedCount: result.postedCount });
  } catch (err) {
    return handleError(c, err);
  }
});

tenantContributionsRouter.post(
  "/contribution-batches/:id/void",
  zValidator("json", contributionBatchVoidSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const existing = await getBatch(db, ctx.zoneId, id);
    if (!existing) return c.json({ error: { code: "not_found", message: "Batch not found" } }, 404);
    if (!canPostContribution(ctx, existing.chapterId)) return forbidden(c);
    try {
      const batch = await voidBatch(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id, input);
      return c.json({ batch });
    } catch (err) {
      return handleError(c, err);
    }
  },
);
