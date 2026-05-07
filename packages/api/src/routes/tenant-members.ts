// packages/api/src/routes/tenant-members.ts
// Member CRUD, addresses, lookups, and merge proposals. Mounted onto
// tenantRouter so it inherits the same middleware stack
// (tenantMiddleware → requireSession → requireTenantAuth).

import { zValidator } from "@hono/zod-validator";
import {
  CHAPTER_ROLES,
  ZONE_ROLES,
  lookupCreateSchema,
  lookupUpdateSchema,
  memberAddressCreateSchema,
  memberAddressUpdateSchema,
  memberCreateSchema,
  memberListQuerySchema,
  memberMergeApplySchema,
  memberMergeProposalListQuerySchema,
  memberMergeProposeSchema,
  memberUpdateSchema,
  titleCreateSchema,
  titleUpdateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  chapters,
  maritalStatuses,
  memberAddresses,
  memberMergeProposals,
  memberTypes,
  members,
  titles,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { writeAudit } from "../services/audit";
import { nextMemberReferenceCode } from "../services/member-codes";
import {
  applyMergeProposal,
  clearOtherPrimaryAddresses,
  MemberError,
} from "../services/members";

export const tenantMembersRouter = new Hono();

const ZONE_MEMBER_WRITE_ROLES = [ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN] as const;

const CHAPTER_MEMBER_WRITE_ROLES = [CHAPTER_ROLES.CHAPTER_ADMIN] as const;

const ZONE_MEMBER_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

const CHAPTER_MEMBER_READ_ROLES = [
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
  CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER,
] as const;

const LOOKUP_READ_ROLES = [...ZONE_MEMBER_READ_ROLES, ...CHAPTER_MEMBER_READ_ROLES] as const;

function forbidden(c: { json: (b: unknown, s: number) => Response }, msg = "Insufficient role"): Response {
  return c.json({ error: { code: "forbidden", message: msg } }, 403);
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const direct = err as { code?: unknown; cause?: unknown };
  if (direct.code === "23505") return true;
  const cause = direct.cause;
  return Boolean(cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505");
}

function conflict(c: { json: (b: unknown, s: number) => Response }, code: string, message: string) {
  return c.json({ error: { code, message } }, 409);
}

async function ensureChapterInZone(zoneId: string, chapterId: string): Promise<boolean> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.id, chapterId), eq(chapters.zoneId, zoneId)))
    .limit(1);
  return rows.length > 0;
}

async function ensureLookupInZone(
  zoneId: string,
  table: typeof titles | typeof maritalStatuses | typeof memberTypes,
  id: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.zoneId, zoneId)))
    .limit(1);
  return rows.length > 0;
}

async function loadActiveMemberInZone(
  zoneId: string,
  memberId: string,
): Promise<{ id: string; chapterId: string | null } | null> {
  const [row] = await db
    .select({ id: members.id, chapterId: members.chapterId })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.zoneId, zoneId), isNull(members.deletedAt)))
    .limit(1);
  return row ?? null;
}

function hasZoneMemberRead(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...ZONE_MEMBER_READ_ROLES);
}

function hasChapterMemberRead(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((code) => (CHAPTER_MEMBER_READ_ROLES as readonly string[]).includes(code));
}

function hasZoneMemberWrite(ctx: AuthorizedContext): boolean {
  return hasAnyRole(ctx, ...ZONE_MEMBER_WRITE_ROLES);
}

function hasChapterMemberWrite(ctx: AuthorizedContext): boolean {
  return ctx.roleCodes.some((code) => (CHAPTER_MEMBER_WRITE_ROLES as readonly string[]).includes(code));
}

function canReadMember(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneMemberRead(ctx)) return true;
  return chapterId !== null && hasChapterMemberRead(ctx) && ctx.chapterIds.includes(chapterId);
}

function canWriteMember(ctx: AuthorizedContext, chapterId: string | null): boolean {
  if (hasZoneMemberWrite(ctx)) return true;
  return chapterId !== null && hasChapterMemberWrite(ctx) && ctx.chapterIds.includes(chapterId);
}

function memberUpdateValues(
  input: Record<string, unknown>,
  userId: string,
): Partial<typeof members.$inferInsert> {
  return {
    ...(input.chapterId !== undefined ? { chapterId: input.chapterId as string | null } : {}),
    ...(input.titleId !== undefined ? { titleId: input.titleId as string | null } : {}),
    ...(input.firstName !== undefined ? { firstName: input.firstName as string } : {}),
    ...(input.middleNames !== undefined ? { middleNames: input.middleNames as string | null } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName as string | null } : {}),
    ...(input.gender !== undefined ? { gender: input.gender as string | null } : {}),
    ...(input.email !== undefined
      ? { email: typeof input.email === "string" ? input.email.toLowerCase() : null }
      : {}),
    ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth as string | null } : {}),
    ...(input.mobile !== undefined ? { mobile: input.mobile as string | null } : {}),
    ...(input.telephone !== undefined ? { telephone: input.telephone as string | null } : {}),
    ...(input.kingschatUsername !== undefined
      ? { kingschatUsername: input.kingschatUsername as string | null }
      : {}),
    ...(input.maritalStatusId !== undefined
      ? { maritalStatusId: input.maritalStatusId as string | null }
      : {}),
    ...(input.memberTypeId !== undefined ? { memberTypeId: input.memberTypeId as string | null } : {}),
    ...(input.dateJoinedMinistry !== undefined
      ? { dateJoinedMinistry: input.dateJoinedMinistry as string | null }
      : {}),
    ...(input.foundationSchoolGraduationDate !== undefined
      ? { foundationSchoolGraduationDate: input.foundationSchoolGraduationDate as string | null }
      : {}),
    ...(input.isCell !== undefined ? { isCell: input.isCell as boolean } : {}),
    ...(input.isDepartment !== undefined ? { isDepartment: input.isDepartment as boolean } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive as boolean } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    updatedByUserId: userId,
    updatedAt: new Date(),
  };
}

// ─── Members ─────────────────────────────────────────────────────────

tenantMembersRouter.get(
  "/members",
  zValidator("query", memberListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneMemberRead(ctx) && !hasChapterMemberRead(ctx)) return forbidden(c);
    const q = c.req.valid("query");

    const conditions = [eq(members.zoneId, ctx.zoneId), isNull(members.deletedAt)];
    if (hasZoneMemberRead(ctx)) {
      if (q.chapterId) conditions.push(eq(members.chapterId, q.chapterId));
    } else {
      if (ctx.chapterIds.length === 0) return forbidden(c);
      if (q.chapterId && !ctx.chapterIds.includes(q.chapterId)) return forbidden(c);
      conditions.push(q.chapterId ? eq(members.chapterId, q.chapterId) : inArray(members.chapterId, ctx.chapterIds));
    }
    if (q.isActive !== undefined) conditions.push(eq(members.isActive, q.isActive));
    if (q.q) {
      const needle = `%${q.q.toLowerCase()}%`;
      conditions.push(
        or(
          sql`lower(${members.fullName}) like ${needle}`,
          sql`lower(${members.email}) like ${needle}`,
          sql`lower(${members.referenceCode}) like ${needle}`,
        )!,
      );
    }

    const rows = await db
      .select({
        id: members.id,
        referenceCode: members.referenceCode,
        firstName: members.firstName,
        middleNames: members.middleNames,
        lastName: members.lastName,
        fullName: members.fullName,
        gender: members.gender,
        email: members.email,
        mobile: members.mobile,
        chapterId: members.chapterId,
        isActive: members.isActive,
        createdAt: members.createdAt,
      })
      .from(members)
      .where(and(...conditions))
      .orderBy(asc(members.referenceCode))
      .limit(q.limit)
      .offset(q.offset);
    return c.json({ items: rows, limit: q.limit, offset: q.offset });
  },
);

tenantMembersRouter.get("/members/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneMemberRead(ctx) && !hasChapterMemberRead(ctx)) return forbidden(c);
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(members)
    .where(and(eq(members.id, id), eq(members.zoneId, ctx.zoneId), isNull(members.deletedAt)))
    .limit(1);
  if (!row || !canReadMember(ctx, row.chapterId)) {
    return c.json({ error: { code: "not_found", message: "Member not found" } }, 404);
  }
  return c.json({ member: row });
});

tenantMembersRouter.post(
  "/members",
  zValidator("json", memberCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneMemberWrite(ctx) && !hasChapterMemberWrite(ctx)) return forbidden(c);
    const input = c.req.valid("json");

    if (!hasZoneMemberWrite(ctx) && (!input.chapterId || !ctx.chapterIds.includes(input.chapterId))) {
      return forbidden(c);
    }

    if (input.chapterId && !(await ensureChapterInZone(ctx.zoneId, input.chapterId))) {
      return c.json(
        { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
        404,
      );
    }
    if (input.titleId && !(await ensureLookupInZone(ctx.zoneId, titles, input.titleId))) {
      return c.json({ error: { code: "title_not_found", message: "Title not in this zone" } }, 404);
    }
    if (
      input.maritalStatusId &&
      !(await ensureLookupInZone(ctx.zoneId, maritalStatuses, input.maritalStatusId))
    ) {
      return c.json(
        { error: { code: "marital_status_not_found", message: "Marital status not in this zone" } },
        404,
      );
    }
    if (
      input.memberTypeId &&
      !(await ensureLookupInZone(ctx.zoneId, memberTypes, input.memberTypeId))
    ) {
      return c.json(
        { error: { code: "member_type_not_found", message: "Member type not in this zone" } },
        404,
      );
    }

    const result = await db.transaction(async (tx) => {
      const referenceCode = await nextMemberReferenceCode(tx, ctx.zoneId);
      const [zone] = await tx
        .select({ regionId: zones.regionId })
        .from(zones)
        .where(eq(zones.id, ctx.zoneId))
        .limit(1);
      const [row] = await tx
        .insert(members)
        .values({
          zoneId: ctx.zoneId,
          regionId: zone?.regionId ?? null,
          chapterId: input.chapterId ?? null,
          referenceCode,
          titleId: input.titleId ?? null,
          firstName: input.firstName,
          middleNames: input.middleNames ?? null,
          lastName: input.lastName ?? null,
          gender: input.gender ?? null,
          email: input.email?.toLowerCase() ?? null,
          dateOfBirth: input.dateOfBirth ?? null,
          mobile: input.mobile ?? null,
          telephone: input.telephone ?? null,
          kingschatUsername: input.kingschatUsername ?? null,
          maritalStatusId: input.maritalStatusId ?? null,
          memberTypeId: input.memberTypeId ?? null,
          dateJoinedMinistry: input.dateJoinedMinistry ?? null,
          foundationSchoolGraduationDate: input.foundationSchoolGraduationDate ?? null,
          isCell: input.isCell ?? false,
          isDepartment: input.isDepartment ?? false,
          isActive: input.isActive ?? true,
          metadata: input.metadata ?? {},
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning();
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "member.create",
        entityType: "member",
        entityId: row.id,
        after: { referenceCode, firstName: row.firstName, lastName: row.lastName },
      });
      return row;
    });
    return c.json({ member: result }, 201);
  },
);

tenantMembersRouter.patch(
  "/members/:id",
  zValidator("json", memberUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneMemberWrite(ctx) && !hasChapterMemberWrite(ctx)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");

    const existingMember = await loadActiveMemberInZone(ctx.zoneId, id);
    if (!existingMember || !canWriteMember(ctx, existingMember.chapterId)) {
      return c.json({ error: { code: "not_found", message: "Member not found" } }, 404);
    }
    if (input.chapterId !== undefined && !canWriteMember(ctx, input.chapterId)) {
      return forbidden(c);
    }

    if (input.chapterId && !(await ensureChapterInZone(ctx.zoneId, input.chapterId))) {
      return c.json(
        { error: { code: "chapter_not_found", message: "Chapter not in this zone" } },
        404,
      );
    }
    if (input.titleId && !(await ensureLookupInZone(ctx.zoneId, titles, input.titleId))) {
      return c.json({ error: { code: "title_not_found", message: "Title not in this zone" } }, 404);
    }
    if (
      input.maritalStatusId &&
      !(await ensureLookupInZone(ctx.zoneId, maritalStatuses, input.maritalStatusId))
    ) {
      return c.json(
        { error: { code: "marital_status_not_found", message: "Marital status not in this zone" } },
        404,
      );
    }
    if (
      input.memberTypeId &&
      !(await ensureLookupInZone(ctx.zoneId, memberTypes, input.memberTypeId))
    ) {
      return c.json(
        { error: { code: "member_type_not_found", message: "Member type not in this zone" } },
        404,
      );
    }

    const updates = memberUpdateValues(input, ctx.userId);

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(members)
        .set(updates)
        .where(
          and(eq(members.id, id), eq(members.zoneId, ctx.zoneId), isNull(members.deletedAt)),
        )
        .returning();
      if (!row) return null;
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "member.update",
        entityType: "member",
        entityId: row.id,
        after: input,
      });
      return row;
    });
    if (!result) return c.json({ error: { code: "not_found", message: "Member not found" } }, 404);
    return c.json({ member: result });
  },
);

/** Soft-delete only. Members are never hard-deleted (PRD §7.3). */
tenantMembersRouter.delete("/members/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) return forbidden(c);
  const id = c.req.param("id");
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(members)
      .set({ deletedAt: new Date(), isActive: false, updatedByUserId: ctx.userId })
      .where(
        and(eq(members.id, id), eq(members.zoneId, ctx.zoneId), isNull(members.deletedAt)),
      )
      .returning({ id: members.id });
    if (!row) return null;
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "member.delete",
      entityType: "member",
      entityId: row.id,
    });
    return row;
  });
  if (!result) return c.json({ error: { code: "not_found", message: "Member not found" } }, 404);
  return c.json({ status: "deleted" });
});

// ─── Member addresses ────────────────────────────────────────────────

tenantMembersRouter.get("/members/:id/addresses", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneMemberRead(ctx) && !hasChapterMemberRead(ctx)) return forbidden(c);
  const memberId = c.req.param("id");
  const member = await loadActiveMemberInZone(ctx.zoneId, memberId);
  if (!member || !canReadMember(ctx, member.chapterId)) {
    return c.json({ error: { code: "not_found", message: "Member not found" } }, 404);
  }
  const rows = await db
    .select()
    .from(memberAddresses)
    .where(and(eq(memberAddresses.zoneId, ctx.zoneId), eq(memberAddresses.memberId, memberId)))
    .orderBy(desc(memberAddresses.dateFrom));
  return c.json({ items: rows });
});

tenantMembersRouter.post(
  "/members/:id/addresses",
  zValidator("json", memberAddressCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneMemberWrite(ctx) && !hasChapterMemberWrite(ctx)) return forbidden(c);
    const memberId = c.req.param("id");
    const input = c.req.valid("json");
    const member = await loadActiveMemberInZone(ctx.zoneId, memberId);
    if (!member || !canWriteMember(ctx, member.chapterId)) {
      return c.json({ error: { code: "not_found", message: "Member not found" } }, 404);
    }

    const today = new Date().toISOString().slice(0, 10);
    const result = await db.transaction(async (tx) => {
      if (input.isPrimary) {
        await clearOtherPrimaryAddresses(tx, { memberId });
      }
      const [row] = await tx
        .insert(memberAddresses)
        .values({
          zoneId: ctx.zoneId,
          memberId,
          isPrimary: input.isPrimary ?? false,
          line1: input.line1 ?? null,
          line2: input.line2 ?? null,
          city: input.city ?? null,
          regionText: input.regionText ?? null,
          postcode: input.postcode ?? null,
          countryCode: input.countryCode ?? null,
          dateFrom: input.dateFrom ?? today,
        })
        .returning();
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "member.address.create",
        entityType: "member_address",
        entityId: row.id,
        after: row,
      });
      return row;
    });
    return c.json({ address: result }, 201);
  },
);

tenantMembersRouter.patch(
  "/members/:memberId/addresses/:addressId",
  zValidator("json", memberAddressUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneMemberWrite(ctx) && !hasChapterMemberWrite(ctx)) return forbidden(c);
    const { memberId, addressId } = c.req.param();
    const input = c.req.valid("json");

    const result = await db.transaction(async (tx) => {
      const [parent] = await tx
        .select({ id: members.id, chapterId: members.chapterId })
        .from(members)
        .where(
          and(eq(members.id, memberId), eq(members.zoneId, ctx.zoneId), isNull(members.deletedAt)),
        )
        .limit(1);
      if (!parent || !canWriteMember(ctx, parent.chapterId)) return null;

      // Tenancy + ownership in one shot.
      const [existing] = await tx
        .select({ id: memberAddresses.id })
        .from(memberAddresses)
        .where(
          and(
            eq(memberAddresses.id, addressId),
            eq(memberAddresses.zoneId, ctx.zoneId),
            eq(memberAddresses.memberId, memberId),
          ),
        )
        .limit(1);
      if (!existing) return null;
      if (input.isPrimary) {
        await clearOtherPrimaryAddresses(tx, { memberId, exceptAddressId: addressId });
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) updates[k] = v;
      }
      const [row] = await tx
        .update(memberAddresses)
        .set(updates)
        .where(eq(memberAddresses.id, addressId))
        .returning();
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "member.address.update",
        entityType: "member_address",
        entityId: row.id,
        after: input,
      });
      return row;
    });
    if (!result)
      return c.json({ error: { code: "not_found", message: "Address not found" } }, 404);
    return c.json({ address: result });
  },
);

/** Soft-archive: set date_to=today and clear isPrimary. */
tenantMembersRouter.delete("/members/:memberId/addresses/:addressId", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasZoneMemberWrite(ctx) && !hasChapterMemberWrite(ctx)) return forbidden(c);
  const { memberId, addressId } = c.req.param();
  const today = new Date().toISOString().slice(0, 10);
  const result = await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ id: members.id, chapterId: members.chapterId })
      .from(members)
      .where(
        and(eq(members.id, memberId), eq(members.zoneId, ctx.zoneId), isNull(members.deletedAt)),
      )
      .limit(1);
    if (!parent || !canWriteMember(ctx, parent.chapterId)) return null;

    const [row] = await tx
      .update(memberAddresses)
      .set({ dateTo: today, isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(memberAddresses.id, addressId),
          eq(memberAddresses.zoneId, ctx.zoneId),
          eq(memberAddresses.memberId, memberId),
          isNull(memberAddresses.dateTo),
        ),
      )
      .returning({ id: memberAddresses.id });
    if (!row) return null;
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "member.address.archive",
      entityType: "member_address",
      entityId: row.id,
    });
    return row;
  });
  if (!result)
    return c.json({ error: { code: "not_found", message: "Address not found" } }, 404);
  return c.json({ status: "archived" });
});

// ─── Lookup tables ───────────────────────────────────────────────────

const LOOKUP_WRITE_ROLES = [ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN] as const;

tenantMembersRouter.get("/lookups/titles", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...LOOKUP_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(titles)
    .where(eq(titles.zoneId, ctx.zoneId))
    .orderBy(asc(titles.ordinal), asc(titles.name));
  return c.json({ items: rows });
});

tenantMembersRouter.post(
  "/lookups/titles",
  zValidator("json", titleCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...LOOKUP_WRITE_ROLES)) return forbidden(c);
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .insert(titles)
        .values({
          zoneId: ctx.zoneId,
          name: input.name,
          gender: input.gender ?? null,
          ordinal: input.ordinal ?? 0,
          isActive: input.isActive ?? true,
        })
        .returning();
      return c.json({ title: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "title_exists", "Title already exists.");
      throw err;
    }
  },
);

tenantMembersRouter.patch(
  "/lookups/titles/:id",
  zValidator("json", titleUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...LOOKUP_WRITE_ROLES)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) updates[k] = v;
    }
    try {
      const [row] = await db
        .update(titles)
        .set(updates)
        .where(and(eq(titles.id, id), eq(titles.zoneId, ctx.zoneId)))
        .returning();
      if (!row) return c.json({ error: { code: "not_found", message: "Title not found" } }, 404);
      return c.json({ title: row });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "title_exists", "Title already exists.");
      throw err;
    }
  },
);

tenantMembersRouter.get("/lookups/marital-statuses", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...LOOKUP_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(maritalStatuses)
    .where(eq(maritalStatuses.zoneId, ctx.zoneId))
    .orderBy(asc(maritalStatuses.ordinal), asc(maritalStatuses.name));
  return c.json({ items: rows });
});

tenantMembersRouter.post(
  "/lookups/marital-statuses",
  zValidator("json", lookupCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...LOOKUP_WRITE_ROLES)) return forbidden(c);
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .insert(maritalStatuses)
        .values({
          zoneId: ctx.zoneId,
          name: input.name,
          ordinal: input.ordinal ?? 0,
          isActive: input.isActive ?? true,
        })
        .returning();
      return c.json({ maritalStatus: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return conflict(c, "marital_status_exists", "Marital status already exists.");
      }
      throw err;
    }
  },
);

tenantMembersRouter.patch(
  "/lookups/marital-statuses/:id",
  zValidator("json", lookupUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...LOOKUP_WRITE_ROLES)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) updates[k] = v;
    }
    try {
      const [row] = await db
        .update(maritalStatuses)
        .set(updates)
        .where(and(eq(maritalStatuses.id, id), eq(maritalStatuses.zoneId, ctx.zoneId)))
        .returning();
      if (!row)
        return c.json({ error: { code: "not_found", message: "Marital status not found" } }, 404);
      return c.json({ maritalStatus: row });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return conflict(c, "marital_status_exists", "Marital status already exists.");
      }
      throw err;
    }
  },
);

tenantMembersRouter.get("/lookups/member-types", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...LOOKUP_READ_ROLES)) return forbidden(c);
  const rows = await db
    .select()
    .from(memberTypes)
    .where(eq(memberTypes.zoneId, ctx.zoneId))
    .orderBy(asc(memberTypes.ordinal), asc(memberTypes.name));
  return c.json({ items: rows });
});

tenantMembersRouter.post(
  "/lookups/member-types",
  zValidator("json", lookupCreateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...LOOKUP_WRITE_ROLES)) return forbidden(c);
    const input = c.req.valid("json");
    try {
      const [row] = await db
        .insert(memberTypes)
        .values({
          zoneId: ctx.zoneId,
          name: input.name,
          ordinal: input.ordinal ?? 0,
          isActive: input.isActive ?? true,
        })
        .returning();
      return c.json({ memberType: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "member_type_exists", "Member type already exists.");
      throw err;
    }
  },
);

tenantMembersRouter.patch(
  "/lookups/member-types/:id",
  zValidator("json", lookupUpdateSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ...LOOKUP_WRITE_ROLES)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) updates[k] = v;
    }
    try {
      const [row] = await db
        .update(memberTypes)
        .set(updates)
        .where(and(eq(memberTypes.id, id), eq(memberTypes.zoneId, ctx.zoneId)))
        .returning();
      if (!row)
        return c.json({ error: { code: "not_found", message: "Member type not found" } }, 404);
      return c.json({ memberType: row });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(c, "member_type_exists", "Member type already exists.");
      throw err;
    }
  },
);

// ─── Merge proposals ─────────────────────────────────────────────────

tenantMembersRouter.get(
  "/members/merge/proposals",
  zValidator("query", memberMergeProposalListQuerySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasZoneMemberRead(ctx)) return forbidden(c);
    const q = c.req.valid("query");
    const conditions = [eq(memberMergeProposals.zoneId, ctx.zoneId)];
    if (q.status) conditions.push(eq(memberMergeProposals.status, q.status));
    const rows = await db
      .select()
      .from(memberMergeProposals)
      .where(and(...conditions))
      .orderBy(desc(memberMergeProposals.proposedAt))
      .limit(q.limit)
      .offset(q.offset);
    return c.json({ items: rows, limit: q.limit, offset: q.offset });
  },
);

tenantMembersRouter.post(
  "/members/merge/proposals",
  zValidator("json", memberMergeProposeSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) return forbidden(c);
    const input = c.req.valid("json");

    // Both sides must belong to this zone.
    const sides = await db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.zoneId, ctx.zoneId),
          isNull(members.deletedAt),
          sql`${members.id} in (${input.primaryMemberId}, ${input.duplicateMemberId})`,
        ),
      );
    if (sides.length !== 2) {
      return c.json(
        { error: { code: "members_missing", message: "Both members must exist in this zone" } },
        404,
      );
    }

    try {
      const [row] = await db
        .insert(memberMergeProposals)
        .values({
          zoneId: ctx.zoneId,
          primaryMemberId: input.primaryMemberId,
          duplicateMemberId: input.duplicateMemberId,
          matchedFields: [],
          matchScore: "0.00",
          notes: input.notes ?? null,
          proposedByUserId: ctx.userId,
          status: "pending",
        })
        .returning();
      return c.json({ proposal: row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return conflict(c, "merge_proposal_exists", "An open proposal already exists for this pair.");
      }
      throw err;
    }
  },
);

tenantMembersRouter.post(
  "/members/merge/apply",
  zValidator("json", memberMergeApplySchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) return forbidden(c);
    const input = c.req.valid("json");
    try {
      const result = await applyMergeProposal(db, {
        proposalId: input.proposalId,
        zoneId: ctx.zoneId,
        reviewedByUserId: ctx.userId,
      });
      return c.json({ status: "applied", ...result });
    } catch (err) {
      if (err instanceof MemberError) {
        const status =
          err.code === "proposal_not_found" || err.code === "members_missing" ? 404 : 409;
        return c.json({ error: { code: err.code, message: err.message } }, status);
      }
      throw err;
    }
  },
);
