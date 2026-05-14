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
});
