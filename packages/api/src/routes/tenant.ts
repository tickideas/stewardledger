// packages/api/src/routes/tenant.ts
// Tenant-scoped API. Mounted under tenantMiddleware + requireSession + requireTenantAuth.

import { zValidator } from "@hono/zod-validator";
import {
  chapterBatchTemplates,
  chapterGroupHistory,
  chapters,
  groups,
  invitations,
  members,
  roles as rolesTable,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import {
  type AuthorizedContext,
  CHAPTER_ROLES,
  GROUP_ROLES,
  chapterBankingSettingsSchema,
  chapterCreateSchema,
  chapterProfileSchema,
  contributionBatchTemplateCreateSchema,
  invitationCreateSchema,
  uuidSchema,
  ZONE_ROLES,
} from "@stewardledger/shared";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import {
  hasAnyRole,
  requireChapterScope,
  visibleChapterIds,
  requireSession,
  requireTenantAuth,
} from "../middleware/auth";
import { type TenantBindings, tenantMiddleware } from "../middleware/tenant";
import { writeAudit } from "../services/audit";
import { nextChapterReferenceCode } from "../services/chapter-codes";
import {
  assignChapterToGroupPreEnable,
  ChapterNotFoundError,
  GroupNotFoundError,
  GroupsNotEnabledError,
} from "../services/groups";
import { brandedEmailHtml, escapeHtml, sendEmail } from "../services/email";
import {
  buildAcceptUrl,
  createInvitation,
  isChapterRole,
  isGroupRole,
  revokeOpenInvitations,
} from "../services/invitations";
import { tenantContributionsRouter } from "./tenant-contributions";
import { tenantDashboardRouter } from "./tenant-dashboard";
import { tenantGivingRouter } from "./tenant-giving";
import { tenantGroupsRouter } from "./tenant-groups";
import { tenantGivingEventsRouter } from "./tenant-giving-events";
import { tenantGivingMethodsRouter } from "./tenant-giving-methods";
import { tenantImportsRouter } from "./tenant-imports";
import { tenantMembersRouter } from "./tenant-members";
import { tenantReportsRouter } from "./tenant-reports";
import { tenantPayingInBooksRouter } from "./tenant-paying-in-books";
import { tenantPeriodsRouter } from "./tenant-periods";
import { tenantTargetsRouter } from "./tenant-targets";
import { tenantZonesRouter } from "./tenant-zones";

export const tenantRouter = new Hono();

tenantRouter.use("*", tenantMiddleware, requireSession, requireTenantAuth);

// Member-domain routes live in their own module to keep this file small.
tenantRouter.route("/", tenantMembersRouter);
tenantRouter.route("/", tenantGivingRouter);
tenantRouter.route("/", tenantGroupsRouter);
tenantRouter.route("/", tenantGivingMethodsRouter);
tenantRouter.route("/", tenantGivingEventsRouter);
tenantRouter.route("/", tenantContributionsRouter);
tenantRouter.route("/", tenantImportsRouter);
tenantRouter.route("/", tenantReportsRouter);
tenantRouter.route("/", tenantDashboardRouter);
tenantRouter.route("/", tenantTargetsRouter);
tenantRouter.route("/", tenantPayingInBooksRouter);
tenantRouter.route("/", tenantPeriodsRouter);
tenantRouter.route("/", tenantZonesRouter);

/** Current user's authorization context for the resolved zone. */
tenantRouter.get("/me", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const tenant = c.get("tenant") as TenantBindings;
  const [zone] = await db
    .select({ id: zones.id, slug: zones.slug, name: zones.name, status: zones.status })
    .from(zones)
    .where(eq(zones.id, tenant.zoneId))
    .limit(1);
  return c.json({ user: { id: ctx.userId }, zone, auth: ctx });
});

/** Zone metadata including the groups_enabled toggle state. */
tenantRouter.get("/zone", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const [row] = await db
    .select({
      id: zones.id,
      slug: zones.slug,
      name: zones.name,
      groupsEnabled: zones.groupsEnabled,
    })
    .from(zones)
    .where(eq(zones.id, ctx.zoneId))
    .limit(1);
  if (!row) return c.json({ error: { code: "not_found", message: "Zone not found" } }, 404);
  return c.json({ zone: row });
});

// ─── Chapters ─────────────────────────────────────────────────────────

// Roles that can read any chapter in the zone. Mirrors the list used by
// the chapter-list GET handler so `requireChapterScope` agrees with the
// implicit “which chapters can I see” gate.
const CHAPTER_READ_ZONE_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

// Banking + roster writes. Chapter admins manage their own chapter; zone
// owners/admins manage any chapter in the zone. Finance admins are NOT
// included — they can read banking refs but shouldn't grant roles.
const CHAPTER_SETTINGS_WRITE_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  GROUP_ROLES.GROUP_ADMIN,
  CHAPTER_ROLES.CHAPTER_ADMIN,
] as const;
const CHAPTER_SETTINGS_ZONE_WRITE_ROLES = [ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN] as const;
const ADMIN_BINDING_WRITE_ROLES = [ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN] as const;

const EMPTY_CHAPTER_PROFILE = {
  address: {
    line1: null,
    line2: null,
    city: null,
    county: null,
    postcode: null,
    countryCode: null,
  },
  pastorName: null,
  pastorEmail: null,
  pastorPhone: null,
  officeEmail: null,
  officePhone: null,
  website: null,
  notes: null,
} as const;

function forbidden(c: { json: (b: unknown, s: number) => Response }, msg = "Insufficient role") {
  return c.json({ error: { code: "forbidden", message: msg } }, 403);
}

async function canWriteChapterSettings(ctx: AuthorizedContext, chapterId: string): Promise<boolean> {
  if (hasAnyRole(ctx, ...CHAPTER_SETTINGS_ZONE_WRITE_ROLES)) return true;
  if (ctx.roleCodes.includes(GROUP_ROLES.GROUP_ADMIN)) {
    const [chapter] = await db
      .select({ groupId: chapters.groupId })
      .from(chapters)
      .where(
        and(
          eq(chapters.id, chapterId),
          eq(chapters.zoneId, ctx.zoneId),
          isNull(chapters.deletedAt),
        ),
      )
      .limit(1);
    if (chapter?.groupId && ctx.groupIds.includes(chapter.groupId)) return true;
  }
  if (!ctx.roleCodes.includes(CHAPTER_ROLES.CHAPTER_ADMIN)) return false;
  const [binding] = await db
    .select({ id: userRoleBindings.id })
    .from(userRoleBindings)
    .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
    .where(
      and(
        eq(userRoleBindings.userId, ctx.userId),
        eq(userRoleBindings.zoneId, ctx.zoneId),
        eq(userRoleBindings.chapterId, chapterId),
        eq(rolesTable.code, CHAPTER_ROLES.CHAPTER_ADMIN),
        isNull(userRoleBindings.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(binding);
}

tenantRouter.get("/chapters", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const scope = await visibleChapterIds(ctx, CHAPTER_READ_ZONE_ROLES);
  if (scope.kind === "list" && scope.ids.length === 0) return c.json({ items: [] });
  const conditions = [eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt)];
  if (scope.kind === "list") conditions.push(inArray(chapters.id, scope.ids));
  const rows = await db
    .select({
      id: chapters.id,
      referenceCode: chapters.referenceCode,
      name: chapters.name,
      countryCode: chapters.countryCode,
      dateFrom: chapters.dateFrom,
      dateTo: chapters.dateTo,
      createdAt: chapters.createdAt,
      groupId: chapters.groupId,
      activeMemberCount: sql<number>`count(${members.id})::int`,
    })
    .from(chapters)
    .leftJoin(
      members,
      and(
        eq(members.zoneId, chapters.zoneId),
        eq(members.chapterId, chapters.id),
        eq(members.isActive, true),
        isNull(members.deletedAt),
      ),
    )
    .where(and(...conditions))
    .groupBy(chapters.id)
    .orderBy(asc(chapters.referenceCode));
  return c.json({ items: rows });
});

tenantRouter.post("/chapters", zValidator("json", chapterCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) {
    return c.json({ error: { code: "forbidden", message: "Zone admin required" } }, 403);
  }
  const input = c.req.valid("json");
  const today = new Date().toISOString().slice(0, 10);
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${ctx.zoneId}, 0))`,
    );
    const referenceCode = await nextChapterReferenceCode(tx, ctx.zoneId);
    const [zone] = await tx
      .select({ regionId: zones.regionId, groupsEnabled: zones.groupsEnabled })
      .from(zones)
      .where(eq(zones.id, ctx.zoneId))
      .limit(1);

    if (zone?.groupsEnabled && !input.groupId) {
      return {
        error: {
          status: 400 as const,
          code: "group_required",
          message: "groupId is required when groups are enabled",
        },
      } as const;
    }
    if (input.groupId) {
      const [grp] = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(
          and(
            eq(groups.id, input.groupId),
            eq(groups.zoneId, ctx.zoneId),
            isNull(groups.deletedAt),
          ),
        )
        .limit(1);
      if (!grp) {
        return {
          error: {
            status: 404 as const,
            code: "group_not_found",
            message: "Group not in this zone",
          },
        } as const;
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.groupId}, 0))`,
      );
      const [grp2] = await tx
        .select({ deletedAt: groups.deletedAt })
        .from(groups)
        .where(eq(groups.id, input.groupId))
        .limit(1);
      if (!grp2 || grp2.deletedAt) {
        return {
          error: {
            status: 404 as const,
            code: "group_not_found",
            message: "Group not in this zone",
          },
        } as const;
      }
    }

    const dateFrom = input.dateFrom ?? today;

    const [row] = await tx
      .insert(chapters)
      .values({
        zoneId: ctx.zoneId,
        regionId: zone?.regionId ?? null,
        groupId: input.groupId ?? null,
        referenceCode,
        name: input.name,
        countryCode: input.countryCode ?? null,
        dateFrom,
      })
      .returning({
        id: chapters.id,
        referenceCode: chapters.referenceCode,
        name: chapters.name,
        groupId: chapters.groupId,
      });

    if (zone?.groupsEnabled && input.groupId) {
      await tx.insert(chapterGroupHistory).values({
        zoneId: ctx.zoneId,
        chapterId: row.id,
        groupId: input.groupId,
        dateFrom,
      });
    }
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "chapter.create",
      entityType: "chapter",
      entityId: row.id,
      after: row,
    });
    return { ok: row } as const;
  });
  if ("error" in result && result.error) {
    return c.json({ error: result.error }, result.error.status);
  }
  return c.json({ chapter: result.ok }, 201);
});

/**
 * One chapter, with everything `/church/settings` needs in a single read:
 *   - the registry record (referenceCode, name, etc.)
 *   - the editable banking block, lifted out of `metadata.banking`
 *
 * Anyone who can scope to the chapter sees it; banking edits are gated
 * separately on the PATCH endpoint below.
 */
tenantRouter.get("/chapters/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const scope = await requireChapterScope(ctx, id, CHAPTER_READ_ZONE_ROLES);
  if (!scope.ok)
    return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
  const [row] = await db
    .select({
      id: chapters.id,
      referenceCode: chapters.referenceCode,
      name: chapters.name,
      countryCode: chapters.countryCode,
      dateFrom: chapters.dateFrom,
      dateTo: chapters.dateTo,
      metadata: chapters.metadata,
      groupId: chapters.groupId,
      createdAt: chapters.createdAt,
      updatedAt: chapters.updatedAt,
    })
    .from(chapters)
    .where(and(eq(chapters.id, id), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt)))
    .limit(1);
  if (!row) return c.json({ error: { code: "not_found", message: "Chapter not found" } }, 404);
  const meta = (row.metadata ?? {}) as { banking?: unknown; profile?: unknown };
  // If older data is malformed we hand back the defaults rather than
  // 500ing the whole settings page; the next PATCH will rewrite it.
  const parsed = chapterBankingSettingsSchema.safeParse(meta.banking);
  const banking = parsed.success
    ? { primaryCurrency: parsed.data.primaryCurrency ?? null, references: parsed.data.references ?? [] }
    : { primaryCurrency: null, references: [] };
  const parsedProfile = chapterProfileSchema.safeParse(meta.profile);
  const profile = parsedProfile.success
    ? {
        ...EMPTY_CHAPTER_PROFILE,
        ...parsedProfile.data,
        address: { ...EMPTY_CHAPTER_PROFILE.address, ...parsedProfile.data.address },
      }
    : EMPTY_CHAPTER_PROFILE;
  return c.json({
    chapter: {
      id: row.id,
      referenceCode: row.referenceCode,
      name: row.name,
      countryCode: row.countryCode,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
      groupId: row.groupId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      banking,
      profile,
    },
  });
});

tenantRouter.patch(
  "/chapters/:id/profile",
  zValidator("json", chapterProfileSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const id = c.req.param("id");
    if (!hasAnyRole(ctx, ...CHAPTER_SETTINGS_WRITE_ROLES)) return forbidden(c);
    const scope = await requireChapterScope(ctx, id, CHAPTER_READ_ZONE_ROLES);
    if (!scope.ok)
      return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
    if (!(await canWriteChapterSettings(ctx, id))) return forbidden(c);
    const input = c.req.valid("json");

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ metadata: chapters.metadata })
        .from(chapters)
        .where(
          and(eq(chapters.id, id), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt)),
        )
        .limit(1);
      if (!existing) return null;
      const prevMeta = (existing.metadata ?? {}) as Record<string, unknown>;
      const prevProfile = (prevMeta.profile as unknown) ?? null;
      const nextProfile = {
        ...EMPTY_CHAPTER_PROFILE,
        ...input,
        address: { ...EMPTY_CHAPTER_PROFILE.address, ...input.address },
      };
      await tx
        .update(chapters)
        .set({
          metadata: sql`jsonb_set(coalesce(${chapters.metadata}, '{}'::jsonb), '{profile}', ${JSON.stringify(nextProfile)}::jsonb, true)`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(chapters.id, id), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt)),
        );
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "chapter.profile.update",
        entityType: "chapter",
        entityId: id,
        before: prevProfile,
        after: nextProfile,
      });
      return nextProfile;
    });
    if (!result)
      return c.json({ error: { code: "not_found", message: "Chapter not found" } }, 404);
    return c.json({ profile: result });
  },
);

tenantRouter.patch(
  "/chapters/:id/banking",
  zValidator("json", chapterBankingSettingsSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const id = c.req.param("id");
    // Fast-fail on role *before* hitting the DB for the chapter lookup.
    // Auditors / pastor-viewers can read banking but shouldn't pay the
    // extra round-trip just to land on a 403.
    if (!hasAnyRole(ctx, ...CHAPTER_SETTINGS_WRITE_ROLES)) return forbidden(c);
    const scope = await requireChapterScope(ctx, id, CHAPTER_READ_ZONE_ROLES);
    if (!scope.ok)
      return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
    if (!(await canWriteChapterSettings(ctx, id))) return forbidden(c);
    const input = c.req.valid("json");

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ metadata: chapters.metadata })
        .from(chapters)
        .where(
          and(eq(chapters.id, id), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt)),
        )
        .limit(1);
      if (!existing) return null;
      const prevMeta = (existing.metadata ?? {}) as Record<string, unknown>;
      const prevBanking = (prevMeta.banking as unknown) ?? null;
      // Normalise: undefined keys become null/empty so stored data is tidy.
      const nextBanking = {
        primaryCurrency: input.primaryCurrency ?? null,
        references: input.references ?? [],
      };
      await tx
        .update(chapters)
        .set({
          metadata: sql`jsonb_set(coalesce(${chapters.metadata}, '{}'::jsonb), '{banking}', ${JSON.stringify(nextBanking)}::jsonb, true)`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(chapters.id, id), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt)),
        );
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "chapter.banking.update",
        entityType: "chapter",
        entityId: id,
        before: prevBanking,
        after: nextBanking,
      });
      return nextBanking;
    });
    if (!result)
      return c.json({ error: { code: "not_found", message: "Chapter not found" } }, 404);
    return c.json({ banking: result });
  },
);

tenantRouter.patch(
  "/chapters/:id",
  zValidator("json", z.object({ groupId: uuidSchema }).strict()),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");

    try {
      await assignChapterToGroupPreEnable(db, {
        zoneId: ctx.zoneId,
        chapterId: id,
        groupId: input.groupId,
        actorUserId: ctx.userId,
      });
    } catch (e) {
      if (e instanceof GroupsNotEnabledError) {
        return c.json(
          {
            error: {
              code: "use_move_group",
              message: "Use POST /chapters/:id/move-group when groups are enabled",
            },
          },
          400,
        );
      }
      if (e instanceof GroupNotFoundError) {
        return c.json(
          { error: { code: "group_not_found", message: "Group not in this zone" } },
          404,
        );
      }
      if (e instanceof ChapterNotFoundError) {
        return c.json(
          { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
          404,
        );
      }
      throw e;
    }
    return c.json({ status: "assigned" });
  },
);

/**
 * Roster: every active user with a chapter-scope role binding in this
 * chapter. Returns one row per (user, role) so the UI shows all bindings
 * explicitly — the same user with two chapter roles appears twice.
 */
tenantRouter.get("/chapters/:id/roster", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const scope = await requireChapterScope(ctx, id, CHAPTER_READ_ZONE_ROLES);
  if (!scope.ok)
    return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
  const rows = await db
    .select({
      bindingId: userRoleBindings.id,
      userId: userTable.id,
      email: userTable.email,
      name: userTable.name,
      roleId: rolesTable.id,
      roleCode: rolesTable.code,
      roleName: rolesTable.name,
      grantedAt: userRoleBindings.grantedAt,
    })
    .from(userRoleBindings)
    .innerJoin(userTable, eq(userRoleBindings.userId, userTable.id))
    .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
    .where(
      and(
        eq(userRoleBindings.zoneId, ctx.zoneId),
        eq(userRoleBindings.chapterId, id),
        isNull(userRoleBindings.revokedAt),
      ),
    )
    .orderBy(asc(userTable.email), asc(rolesTable.code));
  return c.json({ items: rows });
});

/**
 * Revoke a chapter-scope binding. Same write-gate as banking; chapter
 * admins manage their own chapter, zone admins manage any chapter.
 * Cannot revoke the caller's own `chapter_admin` binding when they're
 * acting through that role — that would lock them out of the page they
 * just used. Zone admins can still revoke it (they're not affected).
 */
tenantRouter.delete("/chapters/:id/roster/:bindingId", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const chapterId = c.req.param("id");
  const bindingId = c.req.param("bindingId");
  if (!hasAnyRole(ctx, ...CHAPTER_SETTINGS_WRITE_ROLES)) return forbidden(c);
  const scope = await requireChapterScope(ctx, chapterId, CHAPTER_READ_ZONE_ROLES);
  if (!scope.ok)
    return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);

  const result = await db.transaction(async (tx) => {
    const [binding] = await tx
      .select({
        id: userRoleBindings.id,
        userId: userRoleBindings.userId,
        chapterId: userRoleBindings.chapterId,
        roleId: userRoleBindings.roleId,
        roleCode: rolesTable.code,
        roleScope: rolesTable.scope,
      })
      .from(userRoleBindings)
      .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
      .where(
        and(
          eq(userRoleBindings.id, bindingId),
          eq(userRoleBindings.zoneId, ctx.zoneId),
          eq(userRoleBindings.chapterId, chapterId),
          isNull(userRoleBindings.revokedAt),
        ),
      )
      .limit(1);
    if (!binding) return { kind: "not_found" as const };
    if (binding.roleScope !== "chapter") return { kind: "forbidden" as const };

    const callerIsZoneAdmin = hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN);
    if (
      !callerIsZoneAdmin &&
      binding.userId === ctx.userId &&
      binding.roleCode === CHAPTER_ROLES.CHAPTER_ADMIN
    ) {
      return { kind: "self_lockout" as const };
    }

    await tx
      .update(userRoleBindings)
      .set({ revokedAt: new Date() })
      .where(eq(userRoleBindings.id, binding.id));
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "chapter.roster.revoke",
      entityType: "user_role_binding",
      entityId: binding.id,
      before: {
        userId: binding.userId,
        chapterId: binding.chapterId,
        roleCode: binding.roleCode,
      },
    });
    return { kind: "ok" as const };
  });
  if (result.kind === "not_found")
    return c.json({ error: { code: "not_found", message: "Binding not found" } }, 404);
  if (result.kind === "forbidden")
    return c.json(
      {
        error: { code: "forbidden", message: "Only chapter-scope bindings can be revoked here" },
      },
      403,
    );
  if (result.kind === "self_lockout")
    return c.json(
      {
        error: {
          code: "self_lockout",
          message: "Cannot revoke your own chapter_admin binding.",
        },
      },
      409,
    );
  return c.json({ status: "revoked" });
});

// ─── Batch templates ─────────────────────────────────────────────────

/** List a chapter's batch templates. Anyone scoped to the chapter can read. */
tenantRouter.get("/chapters/:id/batch-templates", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const chapterId = c.req.param("id");
  const scope = await requireChapterScope(ctx, chapterId, CHAPTER_READ_ZONE_ROLES);
  if (!scope.ok)
    return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
  const rows = await db
    .select({
      id: chapterBatchTemplates.id,
      name: chapterBatchTemplates.name,
      payload: chapterBatchTemplates.payload,
      createdAt: chapterBatchTemplates.createdAt,
      updatedAt: chapterBatchTemplates.updatedAt,
    })
    .from(chapterBatchTemplates)
    .where(
      and(
        eq(chapterBatchTemplates.zoneId, ctx.zoneId),
        eq(chapterBatchTemplates.chapterId, chapterId),
      ),
    )
    .orderBy(asc(chapterBatchTemplates.name));
  return c.json({ items: rows });
});

/** Create a batch template. Same write-bucket as banking. */
tenantRouter.post(
  "/chapters/:id/batch-templates",
  zValidator("json", contributionBatchTemplateCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    const chapterId = c.req.param("id");
    if (!hasAnyRole(ctx, ...CHAPTER_SETTINGS_WRITE_ROLES)) return forbidden(c);
    const scope = await requireChapterScope(ctx, chapterId, CHAPTER_READ_ZONE_ROLES);
    if (!scope.ok)
      return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
    const input = c.req.valid("json");

    type TemplateInsertRow = {
      id: string;
      name: string;
      payload: unknown;
      createdAt: Date;
      updatedAt: Date;
    };
    let result: { kind: "ok"; row: TemplateInsertRow } | { kind: "duplicate" };
    try {
      result = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(chapterBatchTemplates)
          .values({
            zoneId: ctx.zoneId,
            chapterId,
            name: input.name,
            // Validated above by `contributionBatchTemplateCreateSchema`
            // (`.strict()`), so `input.payload` lands in the `payload jsonb`
            // column as a known-good object without further coercion.
            payload: input.payload,
            createdByUserId: ctx.userId,
          })
          .returning({
            id: chapterBatchTemplates.id,
            name: chapterBatchTemplates.name,
            payload: chapterBatchTemplates.payload,
            createdAt: chapterBatchTemplates.createdAt,
            updatedAt: chapterBatchTemplates.updatedAt,
          });
        await writeAudit(tx, {
          zoneId: ctx.zoneId,
          actorUserId: ctx.userId,
          action: "chapter.batch_template.create",
          entityType: "chapter_batch_template",
          entityId: row.id,
          after: { name: row.name, payload: row.payload },
        });
        return { kind: "ok" as const, row };
      });
    } catch (err) {
      // Unique (chapter_id, name) collision → 409. The error escapes the
      // transaction wrapper, so we have to catch it here rather than inside.
      const direct = (err as { code?: string }).code;
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      if (direct === "23505" || cause === "23505") {
        result = { kind: "duplicate" };
      } else {
        throw err;
      }
    }
    if (result.kind === "duplicate")
      return c.json(
        {
          error: {
            code: "template_name_exists",
            message: "A template with that name already exists.",
          },
        },
        409,
      );
    return c.json({ template: result.row }, 201);
  },
);

/** Hard-delete a batch template. Audited. */
tenantRouter.delete("/chapters/:id/batch-templates/:templateId", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const chapterId = c.req.param("id");
  const templateId = c.req.param("templateId");
  if (!hasAnyRole(ctx, ...CHAPTER_SETTINGS_WRITE_ROLES)) return forbidden(c);
  const scope = await requireChapterScope(ctx, chapterId, CHAPTER_READ_ZONE_ROLES);
  if (!scope.ok)
    return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(chapterBatchTemplates)
      .where(
        and(
          eq(chapterBatchTemplates.id, templateId),
          eq(chapterBatchTemplates.zoneId, ctx.zoneId),
          eq(chapterBatchTemplates.chapterId, chapterId),
        ),
      )
      .returning({
        id: chapterBatchTemplates.id,
        name: chapterBatchTemplates.name,
        payload: chapterBatchTemplates.payload,
      });
    if (!row) return null;
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "chapter.batch_template.delete",
      entityType: "chapter_batch_template",
      entityId: row.id,
      before: { name: row.name, payload: row.payload },
    });
    return row;
  });
  if (!result)
    return c.json({ error: { code: "not_found", message: "Template not found" } }, 404);
  return c.json({ status: "deleted" });
});

// ─── Administrator bindings ──────────────────────────────────────────

tenantRouter.get("/administrators", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ADMIN_BINDING_WRITE_ROLES)) return forbidden(c, "Zone admin required");

  const rows = await db
    .select({
      bindingId: userRoleBindings.id,
      userId: userTable.id,
      email: userTable.email,
      name: userTable.name,
      roleId: rolesTable.id,
      roleCode: rolesTable.code,
      roleName: rolesTable.name,
      roleScope: rolesTable.scope,
      chapterId: userRoleBindings.chapterId,
      chapterName: chapters.name,
      chapterReferenceCode: chapters.referenceCode,
      groupId: userRoleBindings.groupId,
      groupName: groups.name,
      groupSlug: groups.slug,
      grantedAt: userRoleBindings.grantedAt,
    })
    .from(userRoleBindings)
    .innerJoin(userTable, eq(userRoleBindings.userId, userTable.id))
    .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
    .leftJoin(
      chapters,
      and(eq(chapters.zoneId, userRoleBindings.zoneId), eq(chapters.id, userRoleBindings.chapterId)),
    )
    .leftJoin(
      groups,
      and(eq(groups.zoneId, userRoleBindings.zoneId), eq(groups.id, userRoleBindings.groupId)),
    )
    .where(
      and(
        eq(userRoleBindings.zoneId, ctx.zoneId),
        isNull(userRoleBindings.revokedAt),
        inArray(rolesTable.scope, ["zone", "group", "chapter"]),
      ),
    )
    .orderBy(asc(userTable.email), asc(rolesTable.scope), asc(rolesTable.code));

  return c.json({ items: rows });
});

tenantRouter.delete("/administrators/:bindingId", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ADMIN_BINDING_WRITE_ROLES)) return forbidden(c, "Zone admin required");
  const bindingId = c.req.param("bindingId");

  const result = await db.transaction(async (tx) => {
    const [binding] = await tx
      .select({
        id: userRoleBindings.id,
        userId: userRoleBindings.userId,
        chapterId: userRoleBindings.chapterId,
        groupId: userRoleBindings.groupId,
        roleCode: rolesTable.code,
        roleScope: rolesTable.scope,
      })
      .from(userRoleBindings)
      .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
      .where(
        and(
          eq(userRoleBindings.id, bindingId),
          eq(userRoleBindings.zoneId, ctx.zoneId),
          isNull(userRoleBindings.revokedAt),
        ),
      )
      .limit(1);
    if (!binding) return { kind: "not_found" as const };
    if (
      binding.roleScope !== "zone" &&
      binding.roleScope !== "group" &&
      binding.roleScope !== "chapter"
    ) {
      return { kind: "forbidden" as const };
    }
    if (
      binding.userId === ctx.userId &&
      (binding.roleCode === ZONE_ROLES.ZONE_OWNER || binding.roleCode === ZONE_ROLES.ZONE_ADMIN)
    ) {
      return { kind: "self_lockout" as const };
    }
    if (binding.roleCode === ZONE_ROLES.ZONE_OWNER) {
      const [ownerCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(userRoleBindings)
        .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
        .where(
          and(
            eq(userRoleBindings.zoneId, ctx.zoneId),
            eq(rolesTable.code, ZONE_ROLES.ZONE_OWNER),
            isNull(userRoleBindings.revokedAt),
          ),
        );
      if ((ownerCount?.count ?? 0) <= 1) return { kind: "sole_owner" as const };
    }

    await tx
      .update(userRoleBindings)
      .set({ revokedAt: new Date() })
      .where(eq(userRoleBindings.id, binding.id));
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "administrator.role_binding.revoke",
      entityType: "user_role_binding",
      entityId: binding.id,
      before: {
        userId: binding.userId,
        chapterId: binding.chapterId,
        groupId: binding.groupId,
        roleCode: binding.roleCode,
      },
    });
    return { kind: "ok" as const };
  });

  if (result.kind === "not_found")
    return c.json({ error: { code: "not_found", message: "Binding not found" } }, 404);
  if (result.kind === "forbidden")
    return c.json(
      { error: { code: "forbidden", message: "Only tenant role bindings can be revoked here" } },
      403,
    );
  if (result.kind === "self_lockout")
    return c.json(
      { error: { code: "self_lockout", message: "Cannot revoke your own zone admin access." } },
      409,
    );
  if (result.kind === "sole_owner")
    return c.json(
      { error: { code: "sole_owner", message: "Cannot revoke the zone's only owner." } },
      409,
    );
  return c.json({ status: "revoked" });
});

// ─── Invitations ──────────────────────────────────────────────────────

tenantRouter.get("/invitations", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const isZoneAdmin = hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN);
  const isChapterAdmin = ctx.roleCodes.includes(CHAPTER_ROLES.CHAPTER_ADMIN);
  const isGroupAdmin = ctx.roleCodes.includes(GROUP_ROLES.GROUP_ADMIN);
  if (!isZoneAdmin && !isChapterAdmin && !isGroupAdmin) {
    return c.json({ error: { code: "forbidden", message: "Admin role required" } }, 403);
  }
  // Optional `?chapterId=` filter for the church-admin surface, which
  // shows only the active chapter's open invitations. Honoured for zone
  // admins too. Chapter admins are clamped to their bindings below.
  const requested = c.req.query("chapterId");
  if (requested) {
    const scope = await requireChapterScope(ctx, requested, CHAPTER_READ_ZONE_ROLES);
    if (!scope.ok)
      return c.json({ error: { code: scope.code, message: scope.message } }, scope.status);
  }
  const conditions = [eq(invitations.zoneId, ctx.zoneId)];
  if (requested) {
    conditions.push(eq(invitations.chapterId, requested));
  } else if (!isZoneAdmin) {
    // Chapter admin without a filter → only see invitations for chapters
    // they administer. Empty list when they're somehow unbound.
    const scope = await visibleChapterIds(ctx, CHAPTER_READ_ZONE_ROLES);
    if (scope.kind === "list") {
      if (scope.ids.length === 0) return c.json({ items: [] });
      conditions.push(inArray(invitations.chapterId, scope.ids));
    }
  }
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      roleCode: invitations.roleCode,
      chapterId: invitations.chapterId,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(and(...conditions))
    .orderBy(desc(invitations.createdAt));
  return c.json({ items: rows });
});

tenantRouter.post("/invitations", zValidator("json", invitationCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const isZoneAdmin = hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN);
  const isChapterAdmin = ctx.roleCodes.includes(CHAPTER_ROLES.CHAPTER_ADMIN);
  const isGroupAdmin = ctx.roleCodes.includes(GROUP_ROLES.GROUP_ADMIN);
  if (!isZoneAdmin && !isChapterAdmin && !isGroupAdmin) {
    return c.json({ error: { code: "forbidden", message: "Admin role required" } }, 403);
  }
  const input = c.req.valid("json");

  // Disallow inviting someone as zone_owner via the team flow; ownership is
  // bootstrapped at signup only.
  if (input.roleCode === ZONE_ROLES.ZONE_OWNER) {
    return c.json(
      { error: { code: "owner_invite_forbidden", message: "Cannot invite a second owner" } },
      400,
    );
  }

  // Role-gate by admin scope. Non-zone admins can only invite chapter
  // roles, and mixed group_admin + chapter_admin bindings are additive:
  // either a bound group or a bound chapter is sufficient.
  if (!isZoneAdmin) {
    if (!isChapterRole(input.roleCode)) {
      return forbidden(c, "Scoped admins can only invite chapter roles");
    }
    if (!input.chapterId) {
      return c.json(
        { error: { code: "chapter_required", message: "chapterId required" } },
        400,
      );
    }
    const [chap] = await db
      .select({ groupId: chapters.groupId })
      .from(chapters)
      .where(
        and(
          eq(chapters.id, input.chapterId),
          eq(chapters.zoneId, ctx.zoneId),
          isNull(chapters.deletedAt),
        ),
      )
      .limit(1);
    if (!chap) {
      return c.json(
        { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
        404,
      );
    }
    const hasGroupScope = Boolean(chap.groupId && ctx.groupIds.includes(chap.groupId));
    const hasChapterScope = ctx.chapterIds.includes(input.chapterId);
    if (!hasGroupScope && !hasChapterScope) {
      return forbidden(c, "Chapter is outside your scope");
    }
  }

  // Cross-tenant fuzz guards: ids must belong to this zone.
  if (input.chapterId) {
    const ok = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.id, input.chapterId), eq(chapters.zoneId, ctx.zoneId)))
      .limit(1);
    if (!ok[0]) {
      return c.json(
        { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
        404,
      );
    }
  }
  if (input.groupId) {
    const ok = await db
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.id, input.groupId),
          eq(groups.zoneId, ctx.zoneId),
          isNull(groups.deletedAt),
        ),
      )
      .limit(1);
    if (!ok[0]) {
      return c.json(
        { error: { code: "group_not_found", message: "Group not in this zone" } },
        404,
      );
    }
  }

  // Shape: group roles need groupId; chapter roles need chapterId; zone roles take neither.
  if (isGroupRole(input.roleCode) && !input.groupId) {
    return c.json(
      { error: { code: "group_required", message: "groupId required for group roles" } },
      400,
    );
  }
  if (isChapterRole(input.roleCode) && !input.chapterId) {
    return c.json(
      { error: { code: "chapter_required", message: "chapterId required for chapter roles" } },
      400,
    );
  }
  if (
    !isGroupRole(input.roleCode) &&
    !isChapterRole(input.roleCode) &&
    (input.chapterId || input.groupId)
  ) {
    return c.json(
      { error: { code: "scope_forbidden", message: "Zone roles take no chapter/group" } },
      400,
    );
  }

  const [zone] = await db
    .select({ slug: zones.slug, name: zones.name })
    .from(zones)
    .where(eq(zones.id, ctx.zoneId))
    .limit(1);
  if (!zone) return c.json({ error: { code: "zone_missing", message: "Zone gone" } }, 404);

  const result = await db.transaction(async (tx) => {
    const inv = await createInvitation(tx, {
      zoneId: ctx.zoneId,
      email: input.email,
      roleCode: input.roleCode,
      chapterId: input.chapterId ?? null,
      groupId: input.groupId ?? null,
      createdByUserId: ctx.userId,
    });
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "invitation.create",
      entityType: "invitation",
      entityId: inv.id,
      after: {
        email: input.email,
        roleCode: input.roleCode,
        chapterId: input.chapterId ?? null,
        groupId: input.groupId ?? null,
      },
    });
    return inv;
  });

  const acceptUrl = buildAcceptUrl(zone.slug, result.token);
  await sendEmail({
    to: input.email,
    subject: `You're invited to ${zone.name} on StewardLedger`,
    body: `You've been invited to join ${zone.name}.\nAccept: ${acceptUrl}\nExpires in 7 days.`,
    html: brandedEmailHtml({
      zoneName: zone.name,
      body: `<p>You've been invited to <strong>${escapeHtml(zone.name)}</strong> as <code>${escapeHtml(input.roleCode)}</code>.</p>
        <p><a href="${acceptUrl}" style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Accept invitation</a></p>
        <p style="color:#6b7280;font-size:13px;">This link expires in 7 days.</p>`,
    }),
  });

  return c.json({ invitation: { id: result.id, expiresAt: result.expiresAt } }, 201);
});

tenantRouter.post("/invitations/:id/revoke", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const isZoneAdmin = hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN);
  const isChapterAdmin = ctx.roleCodes.includes(CHAPTER_ROLES.CHAPTER_ADMIN);
  const isGroupAdmin = ctx.roleCodes.includes(GROUP_ROLES.GROUP_ADMIN);
  if (!isZoneAdmin && !isChapterAdmin && !isGroupAdmin) {
    return c.json({ error: { code: "forbidden", message: "Admin role required" } }, 403);
  }
  const id = c.req.param("id");

  // Non-zone admins can only revoke invitations within their scope.
  if (!isZoneAdmin) {
    const [target] = await db
      .select({ chapterId: invitations.chapterId, groupId: invitations.groupId })
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.zoneId, ctx.zoneId)))
      .limit(1);
    if (!target)
      return c.json({ error: { code: "not_found", message: "Invitation not found" } }, 404);

    if (!target.chapterId) {
      return forbidden(c, "Scoped admins can only revoke chapter invites");
    }
    const [chap] = await db
      .select({ groupId: chapters.groupId })
      .from(chapters)
      .where(and(eq(chapters.id, target.chapterId), eq(chapters.zoneId, ctx.zoneId)))
      .limit(1);
    const hasGroupScope = Boolean(chap?.groupId && ctx.groupIds.includes(chap.groupId));
    const hasChapterScope = ctx.chapterIds.includes(target.chapterId);
    if (!hasGroupScope && !hasChapterScope) {
      return forbidden(c, "Invitation is outside your scope");
    }
  }

  const revoked = await db.transaction(async (tx) => {
    const { revokedIds } = await revokeOpenInvitations(
      tx,
      { zoneId: ctx.zoneId, invitationId: id },
      ctx.userId,
    );
    if (revokedIds.length === 0) return null;
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "invitation.revoke",
      entityType: "invitation",
      entityId: id,
    });
    return revokedIds[0];
  });
  if (!revoked) {
    return c.json({ error: { code: "not_found", message: "Invitation not revocable" } }, 404);
  }
  return c.json({ status: "revoked" });
});
