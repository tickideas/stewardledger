// packages/api/src/bootstrap-super-admin.ts
// Optional startup hook that ensures a super-admin user exists. Driven by
// env vars so operators can bootstrap production from Dokploy without
// shelling into a running container.
//
// Behaviour:
//   • If BOOTSTRAP_SUPER_ADMIN_EMAIL is unset → no-op.
//   • If the user does not exist and BOOTSTRAP_SUPER_ADMIN_PASSWORD is set,
//     create the user via Better Auth and flip is_super_admin = true.
//   • If the user exists, only flip is_super_admin = true (idempotent).
//     The password is never rewritten on an existing account.
//   • Errors are logged but do not crash the API — the server still comes
//     up so other tenants are not blocked by a misconfigured bootstrap.

import { eq } from "drizzle-orm";
import * as schema from "@stewardledger/db/schema";
import { auth } from "./auth";
import { db } from "./db";
import { env } from "./env";
import { log } from "./logger";

export async function bootstrapSuperAdminFromEnv(): Promise<void> {
  // Production-only. Local dev should use `pnpm create-admin` so that a
  // stray BOOTSTRAP_SUPER_ADMIN_EMAIL in a developer's .env can't silently
  // elevate accounts in the wrong environment.
  if (env.NODE_ENV !== "production") {
    if (process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL) {
      log.warn(
        { nodeEnv: env.NODE_ENV },
        "bootstrap super-admin: skipped because NODE_ENV is not 'production'. Use 'pnpm create-admin' for local bootstrap.",
      );
    }
    return;
  }

  const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;

  const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_SUPER_ADMIN_NAME?.trim() || "Admin";

  try {
    const existing = await db
      .select({
        id: schema.user.id,
        email: schema.user.email,
        isSuperAdmin: schema.user.isSuperAdmin,
      })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);

    let userId: string;
    if (existing[0]) {
      userId = existing[0].id;
      if (existing[0].isSuperAdmin) {
        log.info({ email }, "bootstrap super-admin: already provisioned, no change");
        return;
      }
      log.info({ email }, "bootstrap super-admin: elevating existing user");
    } else {
      if (!password) {
        log.error(
          { email },
          "bootstrap super-admin: user does not exist and BOOTSTRAP_SUPER_ADMIN_PASSWORD is not set; cannot create",
        );
        return;
      }
      const result = await auth.api.signUpEmail({
        body: { name, email, password },
        asResponse: false,
      });
      userId = result.user.id;
      log.info({ email, userId }, "bootstrap super-admin: created user");
    }

    await db
      .update(schema.user)
      .set({ isSuperAdmin: true })
      .where(eq(schema.user.id, userId));

    log.info({ email }, "bootstrap super-admin: is_super_admin=true");
  } catch (err) {
    log.error({ err, email }, "bootstrap super-admin: failed");
  }
}
