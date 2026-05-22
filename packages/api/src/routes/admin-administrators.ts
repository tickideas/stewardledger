// packages/api/src/routes/admin-administrators.ts
// Routes for managing platform administrators. All require super-admin.
// Mounted under /api/admin/administrators. Every mutation writes an audit
// row inside the service layer; this file only validates input, resolves
// the actor, and shapes the response.
//
// RELEVANT FILES: packages/api/src/services/admin/administrators.ts, packages/api/src/services/admin/platform-invitations.ts, packages/api/src/routes/admin.ts

import { zValidator } from "@hono/zod-validator";
import { PLATFORM_ROLES } from "@stewardledger/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { log } from "../logger";
import {
  requirePlatformRole,
  requireSession,
  type SessionUser,
} from "../middleware/auth";
import {
  AdminError,
  demote,
  elevate,
  findUserByEmail,
  grantRole,
  listAdministrators,
  revokeRole,
} from "../services/admin/administrators";
import {
  createPlatformInvitation,
  listOpenPlatformInvitations,
  PlatformInvitationError,
  revokePlatformInvitation,
} from "../services/admin/platform-invitations";
import {
  sendPlatformAdminGrantNoticeEmail,
  sendPlatformAdminInviteEmail,
} from "../services/admin/platform-admin-emails";
import { parseForwardedIp } from "../services/request-meta";

export const adminAdministratorsRouter = new Hono();

adminAdministratorsRouter.use(
  "*",
  requireSession,
  requirePlatformRole(PLATFORM_ROLES.SUPER_ADMIN),
);

const ROLE_VALUES = [
  PLATFORM_ROLES.SUPPORT_ADMIN,
  PLATFORM_ROLES.BILLING_ADMIN,
  PLATFORM_ROLES.REGION_CURATOR,
] as const;

const inviteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  roleCode: z.enum(ROLE_VALUES),
  superAdmin: z.boolean().default(false),
});

const grantSchema = z.object({
  roleCode: z.enum(ROLE_VALUES),
});

const grantByEmailSchema = z.object({
  email: z.string().trim().email().max(254),
  roleCode: z.enum(ROLE_VALUES),
  /**
   * Default-true: notify the recipient by email. Operators can opt
   * out when granting silently (e.g. when transferring a long-time
   * staff member's role and the email has already been agreed on
   * another channel).
   */
  notify: z.boolean().default(true),
});

function actor(c: Context): {
  actorUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
} {
  const user = c.get("user") as SessionUser;
  return {
    actorUserId: user.id,
    ipAddress: parseForwardedIp(c.req.header("x-forwarded-for")),
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.req.header("x-request-id") ?? null,
  };
}

function logAdmin(c: Context, event: string, extra: Record<string, unknown> = {}): void {
  const user = c.get("user") as SessionUser;
  log.info(
    {
      event,
      userId: user.id,
      userEmail: user.email,
      requestId: c.req.header("x-request-id") ?? null,
      ...extra,
    },
    "admin access",
  );
}

function adminErrorToResponse(c: Context, err: AdminError): Response {
  const status =
    err.code === "user_not_found"
      ? 404
      : err.code === "last_super_admin" ||
          err.code === "already_granted" ||
          err.code === "already_super_admin" ||
          err.code === "not_super_admin"
        ? 409
        : err.code === "not_granted"
          ? 404
          : 400;
  return c.json({ error: { code: err.code, message: err.message } }, status);
}

function inviteErrorToResponse(c: Context, err: PlatformInvitationError): Response {
  const status =
    err.code === "invitation_not_found"
      ? 404
      : err.code === "email_already_user" ||
          err.code === "invitation_revoked" ||
          err.code === "invitation_already_accepted"
        ? 409
        : err.code === "invitation_expired"
          ? 410
          : 400;
  return c.json({ error: { code: err.code, message: err.message } }, status);
}

adminAdministratorsRouter.get("/", async (c) => {
  logAdmin(c, "admin.administrators.list");
  const items = await listAdministrators(db);
  const invitations = await listOpenPlatformInvitations(db);
  return c.json({ items, invitations });
});

adminAdministratorsRouter.post(
  "/invite",
  zValidator("json", inviteSchema),
  async (c) => {
    const input = c.req.valid("json");
    logAdmin(c, "admin.administrators.invite", {
      email: input.email,
      roleCode: input.roleCode,
      superAdmin: input.superAdmin,
    });
    try {
      const result = await createPlatformInvitation(
        db,
        {
          email: input.email,
          name: input.name,
          roleCode: input.roleCode,
          superAdmin: input.superAdmin,
          createdByUserId: (c.get("user") as SessionUser).id,
        },
        actor(c),
      );
      // Side-effect: send the invitation email. We send AFTER the
      // service returns so a 5xx out of the email transport doesn't
      // leak a half-created invitation. The token is intentionally
      // NOT returned in the API response — only the email carries it.
      // We DO surface the email-send outcome so the operator UI can
      // tell the admin to copy a fresh URL out of the dev log (in dev)
      // or to fix the transport (in prod) instead of silently failing.
      let emailSent = true;
      let emailError: string | null = null;
      try {
        await sendPlatformAdminInviteEmail({
          to: input.email,
          name: input.name,
          roleCode: input.roleCode,
          superAdmin: input.superAdmin,
          token: result.token,
        });
      } catch (err) {
        emailSent = false;
        emailError = err instanceof Error ? err.message : "unknown_error";
        log.warn(
          { err, invitationId: result.id },
          "platform invite email failed to send; invitation row stands",
        );
      }
      return c.json(
        {
          status: "invited",
          invitationId: result.id,
          expiresAt: result.expiresAt.toISOString(),
          emailSent,
          emailError,
        },
        201,
      );
    } catch (err) {
      if (err instanceof PlatformInvitationError) return inviteErrorToResponse(c, err);
      throw err;
    }
  },
);

adminAdministratorsRouter.post(
  "/grant",
  zValidator("json", grantByEmailSchema),
  async (c) => {
    const input = c.req.valid("json");
    logAdmin(c, "admin.administrators.grant", {
      email: input.email,
      roleCode: input.roleCode,
    });
    const target = await findUserByEmail(db, input.email);
    if (!target) {
      return c.json(
        { error: { code: "user_not_found", message: "No user with that email." } },
        404,
      );
    }
    let result: { bindingId: string };
    try {
      result = await grantRole(
        db,
        { targetUserId: target.id, roleCode: input.roleCode },
        actor(c),
      );
    } catch (err) {
      if (err instanceof AdminError) return adminErrorToResponse(c, err);
      throw err;
    }

    // Side-effect: notify the user that they now hold the role. Same
    // best-effort shape as the invite email — the grant itself
    // already succeeded (audit row written, binding in place); if the
    // transport blows up we surface that on the response so the UI
    // can warn the operator instead of silently failing.
    let emailSent = false;
    let emailError: string | null = null;
    if (input.notify) {
      try {
        await sendPlatformAdminGrantNoticeEmail({
          to: target.email,
          name: target.name,
          roleCode: input.roleCode,
        });
        emailSent = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : "unknown_error";
        log.warn(
          { err, bindingId: result.bindingId, email: target.email },
          "platform grant-notice email failed to send; binding stands",
        );
      }
    }
    return c.json(
      {
        status: "granted",
        bindingId: result.bindingId,
        notified: input.notify,
        emailSent,
        emailError,
      },
      201,
    );
  },
);

adminAdministratorsRouter.post(
  "/:userId/roles",
  zValidator("json", grantSchema),
  async (c) => {
    const userId = c.req.param("userId");
    const input = c.req.valid("json");
    logAdmin(c, "admin.administrators.grant_by_id", {
      targetUserId: userId,
      roleCode: input.roleCode,
    });
    try {
      const result = await grantRole(
        db,
        { targetUserId: userId, roleCode: input.roleCode },
        actor(c),
      );
      return c.json({ status: "granted", bindingId: result.bindingId }, 201);
    } catch (err) {
      if (err instanceof AdminError) return adminErrorToResponse(c, err);
      throw err;
    }
  },
);

adminAdministratorsRouter.delete(
  "/:userId/roles/:roleCode",
  async (c) => {
    const userId = c.req.param("userId");
    const roleCode = c.req.param("roleCode");
    logAdmin(c, "admin.administrators.revoke", { targetUserId: userId, roleCode });
    try {
      await revokeRole(db, { targetUserId: userId, roleCode }, actor(c));
      return c.json({ status: "revoked" });
    } catch (err) {
      if (err instanceof AdminError) return adminErrorToResponse(c, err);
      throw err;
    }
  },
);

adminAdministratorsRouter.post(
  "/:userId/super-admin",
  async (c) => {
    const userId = c.req.param("userId");
    logAdmin(c, "admin.administrators.elevate", { targetUserId: userId });
    try {
      await elevate(db, { targetUserId: userId }, actor(c));
      return c.json({ status: "elevated" });
    } catch (err) {
      if (err instanceof AdminError) return adminErrorToResponse(c, err);
      throw err;
    }
  },
);

adminAdministratorsRouter.delete(
  "/:userId/super-admin",
  async (c) => {
    const userId = c.req.param("userId");
    logAdmin(c, "admin.administrators.demote", { targetUserId: userId });
    try {
      await demote(db, { targetUserId: userId }, actor(c));
      return c.json({ status: "demoted" });
    } catch (err) {
      if (err instanceof AdminError) return adminErrorToResponse(c, err);
      throw err;
    }
  },
);

adminAdministratorsRouter.delete(
  "/invitations/:invitationId",
  async (c) => {
    const invitationId = c.req.param("invitationId");
    logAdmin(c, "admin.administrators.invite_revoke", { invitationId });
    try {
      await revokePlatformInvitation(db, { invitationId }, actor(c));
      return c.json({ status: "revoked" });
    } catch (err) {
      if (err instanceof PlatformInvitationError) return inviteErrorToResponse(c, err);
      throw err;
    }
  },
);
