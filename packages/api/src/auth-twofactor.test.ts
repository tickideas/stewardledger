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

  it("mounts /api/auth/two-factor/enable and rejects unauthenticated callers", async () => {
    // No session cookie → Better Auth's session middleware rejects
    // before the plugin handler runs. The route MUST be mounted, so
    // we expect a 4xx (not a 404). A 404 here would mean the plugin
    // isn't wired up.
    const res = await app.fetch(
      new Request(`${URL}/api/auth/two-factor/enable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "irrelevant" }),
      }),
    );
    expect(res.status).not.toBe(404);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
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
