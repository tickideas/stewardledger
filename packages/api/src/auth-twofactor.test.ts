// packages/api/src/auth-twofactor.test.ts
// Phase 9 §5 (PR 1) — smoke coverage for the two-factor plugin
// registration. The plugin's cryptographic surface is tested upstream
// in better-auth; we just need to confirm:
//   * the endpoint is mounted under /api/auth/two-factor/enable
//   * unauthenticated callers are rejected
//   * the user.two_factor_enabled column exists and defaults to false
// RELEVANT FILES: packages/api/src/auth.ts, packages/db/src/schema/auth.ts

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user as userTable } from "@stewardledger/db/schema";
import { createApp } from "./app";
import { db } from "./db";

const app = createApp();
const URL = "http://localhost";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("two-factor plugin", () => {
  const cleanupUserIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("auth-twofactor.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  it("mounts /api/auth/two-factor/enable and rejects unauthenticated callers with 401", async () => {
    // The plugin endpoint declares `use: [sessionMiddleware]`, so a
    // request without a session cookie short-circuits at 401 before
    // the handler runs. Pinning to the exact status (rather than
    // "any 4xx") means a future regression — e.g. an adapter
    // bootstrap crash returning 500, or the route falling through
    // to a 404 because the plugin failed to register — fails this
    // test instead of sneaking through.
    const res = await app.fetch(
      new Request(`${URL}/api/auth/two-factor/enable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "irrelevant" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("user.two_factor_enabled column exists and defaults to false", async () => {
    // Direct DB read: the migration added the column with a default.
    // A new user inserted via Drizzle picks up the column default.
    const id = `u-${unique()}`;
    cleanupUserIds.push(id);
    await db.insert(userTable).values({
      id,
      email: `mfa+${unique()}@example.com`,
      emailVerified: true,
    });
    const [row] = await db
      .select({
        twoFactorEnabled: userTable.twoFactorEnabled,
      })
      .from(userTable)
      .where(sql`${userTable.id} = ${id}`)
      .limit(1);
    expect(row.twoFactorEnabled).toBe(false);
  });

  // ─── MFA bypass closure (PR 2) ──────────────────────────────────
  // Each test seeds an MFA-enrolled user, fires the offending
  // Better Auth endpoint, and asserts a 409 / mfa_required rejection.
  // A control case for each path asserts non-MFA users are unaffected.

  async function seedUser(opts: { mfa: boolean }): Promise<{
    id: string;
    email: string;
  }> {
    const id = `u-${unique()}`;
    const email = `mfa-policy+${unique()}@example.com`;
    cleanupUserIds.push(id);
    await db.insert(userTable).values({
      id,
      email,
      emailVerified: true,
      twoFactorEnabled: opts.mfa,
    });
    return { id, email };
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`${URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("refuses /sign-in/magic-link for an MFA-enrolled user", async () => {
    const { email } = await seedUser({ mfa: true });
    const res = await post("/api/auth/sign-in/magic-link", { email });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("mfa_required");
  });

  it("refuses /email-otp/send-verification-otp (type=sign-in) for an MFA-enrolled user", async () => {
    const { email } = await seedUser({ mfa: true });
    const res = await post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(res.status).toBe(409);
  });

  it("refuses /sign-in/email-otp for an MFA-enrolled user", async () => {
    const { email } = await seedUser({ mfa: true });
    const res = await post("/api/auth/sign-in/email-otp", {
      email,
      otp: "123456",
    });
    expect(res.status).toBe(409);
  });

  it("lets /email-otp/send-verification-otp type=email-verification through for an MFA user", async () => {
    // Email-verification path is not a sign-in bypass; refusing it
    // would block password resets / new-email flows for MFA users.
    const { email } = await seedUser({ mfa: true });
    const res = await post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "email-verification",
    });
    // Better Auth may 200 (queued) or 400 (the email path needs an
    // existing verification context) depending on internal state,
    // but it MUST NOT be our 409 / mfa_required and MUST NOT be a
    // 5xx (which would indicate the hook crashed).
    expect(res.status).not.toBe(409);
    expect(res.status).toBeLessThan(500);
  });

  it("does not block a non-MFA user from /sign-in/magic-link", async () => {
    const { email } = await seedUser({ mfa: false });
    const res = await post("/api/auth/sign-in/magic-link", { email });
    // The magic-link plugin completes successfully (200) for a
    // known email — the email is sent (or queued). Either way,
    // our hook MUST NOT have intercepted with a 409 and MUST NOT
    // crash with 5xx.
    expect(res.status).not.toBe(409);
    expect(res.status).toBeLessThan(500);
  });
});
