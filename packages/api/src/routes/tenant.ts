// packages/api/src/routes/tenant.ts
// Tenant-scoped API. Mounted under tenantMiddleware + requireSession + requireTenantAuth.

import { zValidator } from "@hono/zod-validator";
import {
  ZONE_ROLES,
  chapterCreateSchema,
  invitationCreateSchema,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { chapters, invitations, zones } from "@stewardledger/db/schema";
import { db } from "../db";
import { hasAnyRole, requireSession, requireTenantAuth } from "../middleware/auth";
import { tenantMiddleware, type TenantBindings } from "../middleware/tenant";
import { writeAudit } from "../services/audit";
import { nextChapterReferenceCode } from "../services/chapter-codes";
import {
  createInvitation,
  isChapterRole,
} from "../services/invitations";
import { brandedEmailHtml, escapeHtml, sendEmail } from "../services/email";
import { env } from "../env";
import { tenantGivingEventsRouter } from "./tenant-giving-events";
import { tenantGivingMethodsRouter } from "./tenant-giving-methods";
import { tenantGivingRouter } from "./tenant-giving";
import { tenantMembersRouter } from "./tenant-members";

export const tenantRouter = new Hono();

tenantRouter.use("*", tenantMiddleware, requireSession, requireTenantAuth);

// Member-domain routes live in their own module to keep this file small.
tenantRouter.route("/", tenantMembersRouter);
tenantRouter.route("/", tenantGivingRouter);
tenantRouter.route("/", tenantGivingMethodsRouter);
tenantRouter.route("/", tenantGivingEventsRouter);

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

// ─── Chapters ─────────────────────────────────────────────────────────

tenantRouter.get("/chapters", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const rows = await db
    .select({
      id: chapters.id,
      referenceCode: chapters.referenceCode,
      name: chapters.name,
      countryCode: chapters.countryCode,
      dateFrom: chapters.dateFrom,
      dateTo: chapters.dateTo,
      createdAt: chapters.createdAt,
    })
    .from(chapters)
    .where(and(eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt)))
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
    const referenceCode = await nextChapterReferenceCode(tx, ctx.zoneId);
    const [zone] = await tx
      .select({ regionId: zones.regionId })
      .from(zones)
      .where(eq(zones.id, ctx.zoneId))
      .limit(1);
    const [row] = await tx
      .insert(chapters)
      .values({
        zoneId: ctx.zoneId,
        regionId: zone?.regionId ?? null,
        referenceCode,
        name: input.name,
        countryCode: input.countryCode ?? null,
        dateFrom: input.dateFrom ?? today,
      })
      .returning({
        id: chapters.id,
        referenceCode: chapters.referenceCode,
        name: chapters.name,
      });
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "chapter.create",
      entityType: "chapter",
      entityId: row.id,
      after: row,
    });
    return row;
  });
  return c.json({ chapter: result }, 201);
});

// ─── Invitations ──────────────────────────────────────────────────────

tenantRouter.get("/invitations", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) {
    return c.json({ error: { code: "forbidden", message: "Zone admin required" } }, 403);
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
    .where(eq(invitations.zoneId, ctx.zoneId))
    .orderBy(desc(invitations.createdAt));
  return c.json({ items: rows });
});

tenantRouter.post("/invitations", zValidator("json", invitationCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) {
    return c.json({ error: { code: "forbidden", message: "Zone admin required" } }, 403);
  }
  const input = c.req.valid("json");

  // Cross-tenant fuzz guard: if the input has a chapterId, it MUST belong to
  // this zone. The shared schema checks shape; the DB check enforces tenancy.
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
  if (isChapterRole(input.roleCode) && !input.chapterId) {
    return c.json(
      { error: { code: "chapter_required", message: "chapterId required for chapter roles" } },
      400,
    );
  }
  if (!isChapterRole(input.roleCode) && input.chapterId) {
    return c.json(
      { error: { code: "chapter_forbidden", message: "chapterId not allowed for this role" } },
      400,
    );
  }
  // Disallow inviting someone as zone_owner via the team flow; ownership is
  // bootstrapped at signup only.
  if (input.roleCode === ZONE_ROLES.ZONE_OWNER) {
    return c.json(
      { error: { code: "owner_invite_forbidden", message: "Cannot invite a second owner" } },
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
      createdByUserId: ctx.userId,
    });
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "invitation.create",
      entityType: "invitation",
      entityId: inv.id,
      after: { email: input.email, roleCode: input.roleCode, chapterId: input.chapterId ?? null },
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
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) {
    return c.json({ error: { code: "forbidden", message: "Zone admin required" } }, 403);
  }
  const id = c.req.param("id");
  const result = await db
    .update(invitations)
    .set({ revokedAt: new Date(), revokedByUserId: ctx.userId })
    .where(
      and(
        eq(invitations.id, id),
        eq(invitations.zoneId, ctx.zoneId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ id: invitations.id });
  if (!result[0])
    return c.json({ error: { code: "not_found", message: "Invitation not revocable" } }, 404);
  await writeAudit(db, {
    zoneId: ctx.zoneId,
    actorUserId: ctx.userId,
    action: "invitation.revoke",
    entityType: "invitation",
    entityId: id,
  });
  return c.json({ status: "revoked" });
});

function buildAcceptUrl(slug: string, token: string): string {
  if (env.PUBLIC_TENANT_DOMAIN === "localhost") {
    return `${env.PUBLIC_APP_URL}/invite/${encodeURIComponent(token)}`;
  }
  const url = new URL(env.PUBLIC_APP_URL);
  url.host = `${slug}.${env.PUBLIC_TENANT_DOMAIN}`;
  url.pathname = `/invite/${encodeURIComponent(token)}`;
  return url.toString();
}
