// packages/api/src/routes/tenant-imports.ts
// Phase 6 — tenant-scoped import pipeline.
// Mounted onto tenantRouter so it inherits the same middleware stack
// (tenantMiddleware → requireSession → requireTenantAuth).

import { zValidator } from "@hono/zod-validator";
import {
  CHAPTER_ROLES,
  ZONE_ROLES,
  importCreateSchema,
  importListQuerySchema,
  importRollbackSchema,
  importRowListQuerySchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { Hono } from "hono";
import { hasAnyRole, requireChapterScope, visibleChapterIds } from "../middleware/auth";
import { db } from "../db";
import {
  ImportError,
  commitImport,
  errorStatusFor,
  getImport,
  listImportRows,
  listImports,
  publicMessageForImportError,
  rollbackImport,
  scheduleImport,
  uploadImport,
} from "../services/imports";

export const tenantImportsRouter = new Hono();

// Zone-wide roles can read every import in their zone.
const IMPORT_ZONE_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
] as const;

// Chapter-scoped read: only when the import's chapter is in their
// `chapterIds` list. Bookkeepers also read so they can preview
// before a treasurer schedules.
const IMPORT_CHAPTER_READ_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
] as const;

// Write = upload + edit before commit. Bookkeepers can upload + draft.
const IMPORT_ZONE_WRITE_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
] as const;
const IMPORT_CHAPTER_WRITE_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
] as const;

// Commit / rollback / schedule — money out the door. Bookkeepers are
// intentionally excluded; they draft, they don't post.
const IMPORT_ZONE_COMMIT_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
] as const;
const IMPORT_CHAPTER_COMMIT_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
] as const;

function hasZoneRead(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...IMPORT_ZONE_READ_ROLES);
}
function hasChapterRead(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) =>
    (IMPORT_CHAPTER_READ_ROLES as readonly string[]).includes(c),
  );
}
function hasZoneWrite(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...IMPORT_ZONE_WRITE_ROLES);
}
function hasChapterWrite(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) =>
    (IMPORT_CHAPTER_WRITE_ROLES as readonly string[]).includes(c),
  );
}
function hasZoneCommit(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...IMPORT_ZONE_COMMIT_ROLES);
}
function hasChapterCommit(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((c) =>
    (IMPORT_CHAPTER_COMMIT_ROLES as readonly string[]).includes(c),
  );
}

/**
 * Authorise an action against the import's chapter scope. A null
 * `chapterId` means the import is zone-wide; only zone-level roles may
 * touch it.
 */
function canReadImport(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneRead(ctx)) return true;
  return (
    chapterId !== null &&
    hasChapterRead(ctx) &&
    ctx.chapterIds.includes(chapterId)
  );
}
function canWriteImport(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneWrite(ctx)) return true;
  return (
    chapterId !== null &&
    hasChapterWrite(ctx) &&
    ctx.chapterIds.includes(chapterId)
  );
}
function canCommitImport(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneCommit(ctx)) return true;
  return (
    chapterId !== null &&
    hasChapterCommit(ctx) &&
    ctx.chapterIds.includes(chapterId)
  );
}

function forbidden(c: { json: (b: unknown, s: number) => Response }, msg = "Insufficient role"): Response {
  return c.json({ error: { code: "forbidden", message: msg } }, 403);
}

function handleError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ImportError) {
    return c.json(
      { error: { code: err.code, message: publicMessageForImportError(err.code, err.message) } },
      errorStatusFor(err.code),
    );
  }
  throw err;
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // 20MB ceiling for v1

// POST /api/tenant/imports — multipart upload (file + JSON fields).
// We accept either `multipart/form-data` (the canonical browser flow) or
// `application/octet-stream` with metadata in query params (curl-friendly).
tenantImportsRouter.post("/imports", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  // Cheap upfront gate: anyone allowed to write somewhere. Chapter scope
  // is re-checked below once we know the target chapter.
  if (!hasZoneWrite(ctx) && !hasChapterWrite(ctx)) return forbidden(c);

  // Pre-flight on Content-Length so a 1GB upload can't OOM the process
  // just by buffering through Hono's body parser. A misconfigured
  // reverse proxy can still pass a body whose declared length doesn't
  // match its actual bytes; the post-parse size check below remains the
  // authoritative guard against that.
  const contentLength = c.req.header("content-length");
  const declaredLength = contentLength === undefined ? NaN : Number(contentLength);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return c.json(
      {
        error: {
          code: "content_length_required",
          message: "Content-Length is required for import uploads.",
        },
      },
      411,
    );
  }
  if (declaredLength > MAX_IMPORT_BYTES) {
    return c.json(
      {
        error: {
          code: "file_too_large",
          message: `Content-Length ${declaredLength} exceeds ${MAX_IMPORT_BYTES} bytes`,
        },
      },
      413,
    );
  }

  const contentType = c.req.header("content-type") ?? "";
  let body: Uint8Array;
  let fileName = "upload.csv";
  let fileType = "statement";
  let sourceType = "generic_csv";
  let chapterId: string | null = null;

  if (contentType.startsWith("multipart/form-data")) {
    const form = await c.req.parseBody({ all: false });
    const file = form.file as File | undefined;
    if (!file) {
      return c.json(
        { error: { code: "file_required", message: "multipart field 'file' is required" } },
        400,
      );
    }
    if (file.size > MAX_IMPORT_BYTES) {
      return c.json(
        { error: { code: "file_too_large", message: `File exceeds ${MAX_IMPORT_BYTES} bytes` } },
        413,
      );
    }
    body = new Uint8Array(await file.arrayBuffer());
    fileName = file.name || fileName;
    if (typeof form.fileType === "string") fileType = form.fileType;
    if (typeof form.sourceType === "string") sourceType = form.sourceType;
    if (typeof form.chapterId === "string" && form.chapterId) chapterId = form.chapterId;
  } else {
    // Raw upload path. Metadata via query string + filename header.
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_IMPORT_BYTES) {
      return c.json(
        { error: { code: "file_too_large", message: `File exceeds ${MAX_IMPORT_BYTES} bytes` } },
        413,
      );
    }
    body = new Uint8Array(raw);
    fileName = c.req.query("fileName") ?? fileName;
    fileType = c.req.query("fileType") ?? fileType;
    sourceType = c.req.query("sourceType") ?? sourceType;
    chapterId = c.req.query("chapterId") ?? null;
  }

  if (body.byteLength === 0) {
    return c.json(
      { error: { code: "file_required", message: "Upload body is empty" } },
      400,
    );
  }

  if (fileType !== "statement") {
    return c.json(
      {
        error: {
          code: "unsupported_file_type",
          message: "Only statement CSV imports are supported in Phase 6.",
        },
      },
      400,
    );
  }

  const parsed = importCreateSchema.safeParse({
    fileType,
    sourceType,
    chapterId: chapterId ?? undefined,
  });
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "invalid_payload",
          message: parsed.error.issues[0]?.message ?? "Invalid import metadata",
        },
      },
      400,
    );
  }

  // Chapter scope enforcement. A chapter-scoped user MUST target one of
  // their own chapters; they cannot upload a zone-wide import (chapterId = null).
  const targetChapterId = parsed.data.chapterId ?? null;
  if (!canWriteImport(ctx, targetChapterId)) return forbidden(c);

  try {
    const result = await uploadImport(
      db,
      { zoneId: ctx.zoneId, userId: ctx.userId },
      { ...parsed.data, fileName, body },
    );
    return c.json(result, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

tenantImportsRouter.get(
  "/imports",
  zValidator("query", importListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
    const q = c.req.valid("query");
    if (q.chapterId) {
      const cscope = await requireChapterScope(ctx, q.chapterId, IMPORT_ZONE_READ_ROLES);
      if (!cscope.ok) {
        return c.json({ error: { code: cscope.code, message: cscope.message } }, cscope.status);
      }
    }
    const scope = await visibleChapterIds(ctx, IMPORT_ZONE_READ_ROLES);
    const result = await listImports(db, ctx.zoneId, q, {
      chapterIds: scope.kind === "all" ? undefined : scope.ids,
    });
    return c.json(result);
  },
);

tenantImportsRouter.get("/imports/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
  const id = c.req.param("id");
  const detail = await getImport(db, ctx.zoneId, id);
  if (!detail) return c.json({ error: { code: "not_found", message: "Import not found" } }, 404);
  if (!canReadImport(ctx, detail.file.chapterId)) return forbidden(c);
  return c.json(detail);
});

tenantImportsRouter.get(
  "/imports/:id/rows",
  zValidator("query", importRowListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneRead(ctx) && !hasChapterRead(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const q = c.req.valid("query");
    const detail = await getImport(db, ctx.zoneId, id);
    if (!detail) return c.json({ error: { code: "not_found", message: "Import not found" } }, 404);
    if (!canReadImport(ctx, detail.file.chapterId)) return forbidden(c);
    const result = await listImportRows(db, ctx.zoneId, id, q);
    return c.json(result);
  },
);

tenantImportsRouter.post("/imports/:id/schedule", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneCommit(ctx) && !hasChapterCommit(ctx)) return forbidden(c);
  const id = c.req.param("id");
  const detail = await getImport(db, ctx.zoneId, id);
  if (!detail) return c.json({ error: { code: "not_found", message: "Import not found" } }, 404);
  if (!canCommitImport(ctx, detail.file.chapterId)) return forbidden(c);
  try {
    const result = await scheduleImport(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

tenantImportsRouter.post("/imports/:id/commit", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneCommit(ctx) && !hasChapterCommit(ctx)) return forbidden(c);
  const id = c.req.param("id");
  const detail = await getImport(db, ctx.zoneId, id);
  if (!detail) return c.json({ error: { code: "not_found", message: "Import not found" } }, 404);
  if (!canCommitImport(ctx, detail.file.chapterId)) return forbidden(c);
  try {
    const result = await commitImport(db, { zoneId: ctx.zoneId, userId: ctx.userId }, id);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

tenantImportsRouter.post(
  "/imports/:id/rollback",
  zValidator("json", importRollbackSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneCommit(ctx) && !hasChapterCommit(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const detail = await getImport(db, ctx.zoneId, id);
    if (!detail) return c.json({ error: { code: "not_found", message: "Import not found" } }, 404);
    if (!canCommitImport(ctx, detail.file.chapterId)) return forbidden(c);
    try {
      const result = await rollbackImport(
        db,
        { zoneId: ctx.zoneId, userId: ctx.userId },
        id,
        input,
      );
      return c.json(result);
    } catch (err) {
      return handleError(c, err);
    }
  },
);
