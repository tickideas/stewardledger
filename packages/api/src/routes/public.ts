// packages/api/src/routes/public.ts
// Routes that do not require a session or a resolved tenant. Mounted on the
// platform/marketing host (apex domain). See ARCHITECTURE.md §5.

import { zValidator } from "@hono/zod-validator";
import {
  invitationAcceptSchema,
  regionTypeaheadSchema,
  zoneSignupSchema,
} from "@stewardledger/shared";
import { and, asc, eq, ilike, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { regions, user as userTable, userRoleBindings, zones } from "@stewardledger/db/schema";
import { auth } from "../auth";
import { db } from "../db";
import { log } from "../logger";
import {
  applyAcceptedInvitation,
  findInvitationByToken,
  InvitationError,
} from "../services/invitations";
import { signupZone, SignupError } from "../services/signup";

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
  // sequential pair was material.
  const [userRows, rows] = await Promise.all([
    db
      .select({ isSuperAdmin: userTable.isSuperAdmin })
      .from(userTable)
      .where(eq(userTable.id, session.user.id))
      .limit(1),
    db
      .select({ id: zones.id, slug: zones.slug, name: zones.name })
      .from(userRoleBindings)
      .innerJoin(zones, eq(userRoleBindings.zoneId, zones.id))
      .where(and(eq(userRoleBindings.userId, session.user.id), isNull(userRoleBindings.revokedAt)))
      .orderBy(asc(zones.name)),
  ]);
  const userRow = userRows[0];

  const seen = new Set<string>();
  const items = rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  return c.json({ items, isSuperAdmin: userRow?.isSuperAdmin ?? false });
});

/** Public zone signup. Always invites the owner immediately (no admin gate). */
publicRouter.post("/signup", zValidator("json", zoneSignupSchema), async (c) => {
  const input = c.req.valid("json");
  try {
    const result = await signupZone(db, input);
    log.info({ zoneId: result.zoneId, slug: input.slug }, "zone signup created");
    return c.json({ status: "invited", zoneId: result.zoneId }, 201);
  } catch (err) {
    if (err instanceof SignupError) {
      return c.json({ error: { code: err.code, message: err.message } }, 409);
    }
    throw err;
  }
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
