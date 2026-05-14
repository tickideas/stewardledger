// packages/api/src/routes/public.ts
// Routes that do not require a session or a resolved tenant. Mounted on the
// platform/marketing host (apex domain). See ARCHITECTURE.md §5.

import { zValidator } from "@hono/zod-validator";
import {
  chapters,
  regions,
  roles as rolesTable,
  userRoleBindings,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import {
  invitationAcceptSchema,
  regionTypeaheadSchema,
} from "@stewardledger/shared";
import { and, asc, eq, ilike, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../auth";
import { db } from "../db";
import { log } from "../logger";
import {
  applyAcceptedInvitation,
  findInvitationByToken,
  InvitationError,
} from "../services/invitations";
import { mfaRequiredInZone } from "../services/mfa-policy";

export const publicRouter = new Hono();

/** Region typeahead for the signup form. Active regions only. */
publicRouter.get(
  "/regions/typeahead",
  zValidator(
    "query",
    regionTypeaheadSchema.extend({
      limit: regionTypeaheadSchema.shape.limit.optional().default(10),
    }),
  ),
  async (c) => {
    const { q, limit } = c.req.valid("query");
    const rows = await db
      .select({
        id: regions.id,
        name: regions.name,
        shortCode: regions.shortCode,
        countryCode: regions.countryCode,
      })
      .from(regions)
      .where(and(eq(regions.isActive, true), ilike(regions.name, `%${q}%`)))
      .orderBy(asc(regions.name))
      .limit(limit);
    return c.json({ items: rows });
  },
);

/** Current session's zones. Used by local-dev login before tenant host routing exists. */
publicRouter.get("/session-zones", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: { code: "unauthenticated", message: "Sign in required" } }, 401);
  }

  // Two independent reads — fire them in parallel. This endpoint is hit on
  // every navigation by the session store; the extra round-trip from a
  // sequential pair was material. The bindings query pulls role code + scope
  // so the client can decide which dashboard surface to land on (and which
  // sidebar to render) without a follow-up call.
  const [userRows, bindingRows] = await Promise.all([
    db
      .select({
        isSuperAdmin: userTable.isSuperAdmin,
        name: userTable.name,
        email: userTable.email,
        twoFactorEnabled: userTable.twoFactorEnabled,
      })
      .from(userTable)
      .where(eq(userTable.id, session.user.id))
      .limit(1),
    // Left-join chapters because zone-scope bindings have no chapterId. The
    // joined name is `null` for those rows and gets discarded below.
    db
      .select({
        zoneId: zones.id,
        zoneSlug: zones.slug,
        zoneName: zones.name,
        zoneMfaRequiredRoleCodes: zones.mfaRequiredRoleCodes,
        chapterId: userRoleBindings.chapterId,
        chapterName: chapters.name,
        roleCode: rolesTable.code,
        roleScope: rolesTable.scope,
      })
      .from(userRoleBindings)
      .innerJoin(zones, eq(userRoleBindings.zoneId, zones.id))
      .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
      // Left-join chapters, but EXCLUDE soft-deleted ones from the join.
      // For a chapter-scope binding whose chapter has been deleted, the
      // join columns come back null and the aggregator below drops the row
      // — better than handing the UI a chapter id that 404s on every call.
      .leftJoin(
        chapters,
        and(eq(userRoleBindings.chapterId, chapters.id), isNull(chapters.deletedAt)),
      )
      .where(
        and(
          eq(userRoleBindings.userId, session.user.id),
          isNull(userRoleBindings.revokedAt),
          isNull(zones.deletedAt),
        ),
      )
      .orderBy(asc(zones.name), asc(chapters.name)),
  ]);
  const userRow = userRows[0];

  // Collapse the binding rows into one entry per zone. A user can hold
  // multiple bindings within the same zone (e.g. zone_admin AND a chapter
  // binding); the UI wants the union, deduplicated. Chapter rows carry the
  // chapter name so the church-admin sidebar can render a switcher without
  // a second round-trip.
  type ChapterRole = { chapterId: string; chapterName: string; roleCode: string };
  type ZoneItem = {
    id: string;
    slug: string;
    name: string;
    zoneRoles: string[];
    chapterRoles: ChapterRole[];
    /**
     * True when at least one of the user's role codes in this zone
     * is on the zone's `mfa_required_role_codes` list. The web shell
     * uses this to redirect MFA-less users to /account/security.
     */
    mfaRequired: boolean;
    /**
     * Internal: the zone's enforcement list. Carried on the
     * aggregator so we can compute `mfaRequired` after all bindings
     * have been collected. Dropped before serialising.
     */
    _mfaRequiredRoleCodes: string[];
  };
  const byZone = new Map<string, ZoneItem>();
  for (const b of bindingRows) {
    let z = byZone.get(b.zoneId);
    if (!z) {
      z = {
        id: b.zoneId,
        slug: b.zoneSlug,
        name: b.zoneName,
        zoneRoles: [],
        chapterRoles: [],
        mfaRequired: false,
        _mfaRequiredRoleCodes: b.zoneMfaRequiredRoleCodes ?? [],
      };
      byZone.set(b.zoneId, z);
    }
    if (b.roleScope === "zone" && !z.zoneRoles.includes(b.roleCode)) {
      z.zoneRoles.push(b.roleCode);
    } else if (b.roleScope === "chapter" && b.chapterId && b.chapterName) {
      const exists = z.chapterRoles.some(
        (r) => r.chapterId === b.chapterId && r.roleCode === b.roleCode,
      );
      if (!exists) {
        z.chapterRoles.push({
          chapterId: b.chapterId,
          chapterName: b.chapterName,
          roleCode: b.roleCode,
        });
      }
    }
  }
  const items = [...byZone.values()].map((z) => {
    const userRoleCodes = [
      ...z.zoneRoles,
      ...z.chapterRoles.map((r) => r.roleCode),
    ];
    const mfaRequired = mfaRequiredInZone(
      z._mfaRequiredRoleCodes,
      userRoleCodes,
    );
    // Strip the internal helper before serialising.
    const { _mfaRequiredRoleCodes: _drop, ...rest } = z;
    void _drop;
    return { ...rest, mfaRequired };
  });

  return c.json({
    items,
    isSuperAdmin: userRow?.isSuperAdmin ?? false,
    user: {
      id: session.user.id,
      email: userRow?.email ?? session.user.email,
      name: userRow?.name ?? null,
      twoFactorEnabled: userRow?.twoFactorEnabled ?? false,
    },
  });
});

/** Look up an invitation by token (used by the accept page to render context). */
publicRouter.get("/invitations/:token", async (c) => {
  const token = c.req.param("token");
  const inv = await findInvitationByToken(db, token);
  if (!inv) return c.json({ error: { code: "invitation_not_found", message: "Not found" } }, 404);
  if (inv.revokedAt)
    return c.json({ error: { code: "invitation_revoked", message: "Revoked" } }, 410);
  if (inv.acceptedAt)
    return c.json({ error: { code: "invitation_already_accepted", message: "Used" } }, 410);
  if (inv.expiresAt.getTime() < Date.now())
    return c.json({ error: { code: "invitation_expired", message: "Expired" } }, 410);
  return c.json({
    invitation: {
      email: inv.email,
      roleCode: inv.roleCode,
      zoneSlug: inv.zoneSlug,
      zoneName: inv.zoneName,
      expiresAt: inv.expiresAt.toISOString(),
    },
  });
});

/**
 * Accept an invitation:
 *   1. Look up by token, validate.
 *   2. Sign the user up via Better Auth (email pinned to the invitation).
 *   3. Bind the new user to the zone via `applyAcceptedInvitation`.
 */
publicRouter.post("/invitations/accept", zValidator("json", invitationAcceptSchema), async (c) => {
  const { token, name, password } = c.req.valid("json");
  const inv = await findInvitationByToken(db, token);
  if (!inv) return c.json({ error: { code: "invitation_not_found", message: "Not found" } }, 404);
  if (inv.revokedAt)
    return c.json({ error: { code: "invitation_revoked", message: "Revoked" } }, 410);
  if (inv.acceptedAt)
    return c.json({ error: { code: "invitation_already_accepted", message: "Used" } }, 410);
  if (inv.expiresAt.getTime() < Date.now())
    return c.json({ error: { code: "invitation_expired", message: "Expired" } }, 410);

  let userId: string;
  try {
    const result = await auth.api.signUpEmail({
      body: { name, email: inv.email, password },
      headers: c.req.raw.headers,
      asResponse: false,
    });
    userId = result.user.id;
  } catch (err) {
    log.warn({ err, email: inv.email }, "signUpEmail failed during invitation accept");
    return c.json(
      { error: { code: "signup_failed", message: "Could not create account." } },
      400,
    );
  }

  try {
    await applyAcceptedInvitation(db, { invitationId: inv.id, userId });
  } catch (err) {
    if (err instanceof InvitationError) {
      return c.json({ error: { code: err.code, message: err.message } }, 409);
    }
    throw err;
  }
  return c.json({ status: "accepted", zoneSlug: inv.zoneSlug });
});
