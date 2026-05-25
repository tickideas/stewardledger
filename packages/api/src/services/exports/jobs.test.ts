// packages/api/src/services/exports/jobs.test.ts
// Phase 9 \u00a73 \u2014 queueExport cooldown semantics, including the
// concurrent-POST race the advisory lock closes.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  zoneExports,
  zones,
  user as userTable,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { ExportJobError, queueExport } from "./jobs";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("queueExport \u2014 cooldown", () => {
  let zoneId: string;
  let userId: string;
  const slugs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("jobs.test.ts requires a *_test DATABASE_URL");
    }
    const slug = `xq-${unique()}`;
    const [zone] = await db
      .insert(zones)
      .values({
        slug,
        name: `Queue Zone ${unique()}`,
        countryCode: "GB",
        defaultCurrencyCode: "GBP",
        defaultTimeZone: "Europe/London",
        regionNameUnverified: `Region ${unique()}`,
        status: "active",
      })
      .returning({ id: zones.id });
    zoneId = zone.id;
    slugs.push(slug);

    userId = `u-${unique()}`;
    await db.insert(userTable).values({
      id: userId,
      email: `xq-${unique()}@example.com`,
      emailVerified: true,
    });
    userIds.push(userId);
  });

  afterAll(async () => {
    for (const slug of slugs) {
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of userIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(async () => {
    await db.delete(zoneExports).where(eq(zoneExports.zoneId, zoneId));
  });

  it("the second concurrent POST sees rate_limited (advisory lock serialises them)", async () => {
    // Without the `pg_advisory_xact_lock` inside queueExport, both
    // promises would race the SELECT, both find no recent row, and
    // both INSERT. The lock serialises them: the loser sees the
    // first's row + a rate_limited error.
    const results = await Promise.allSettled([
      queueExport(db, { zoneId, requestedByUserId: userId }),
      queueExport(db, { zoneId, requestedByUserId: userId }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(ExportJobError);
    expect((rejection.reason as ExportJobError).code).toBe("rate_limited");

    // Only one row landed.
    const rows = await db
      .select({ id: zoneExports.id })
      .from(zoneExports)
      .where(eq(zoneExports.zoneId, zoneId));
    expect(rows).toHaveLength(1);
  });

  it("a `failed` row in the cooldown window does NOT block a retry", async () => {
    const [failed] = await db
      .insert(zoneExports)
      .values({
        zoneId,
        requestedByUserId: userId,
        status: "failed",
        errorCode: "build_failed",
        errorMessage: "simulated",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: zoneExports.id });
    // queueExport should ignore the failed row and create a fresh queued row.
    const next = await queueExport(db, {
      zoneId,
      requestedByUserId: userId,
    });
    expect(next.status).toBe("queued");
    expect(next.id).not.toBe(failed.id);
  });

  it("a `completed` row in the cooldown window blocks a retry with rate_limited details", async () => {
    const [completed] = await db
      .insert(zoneExports)
      .values({
        zoneId,
        requestedByUserId: userId,
        status: "completed",
        storageKey: `${zoneId}/exports/test.tar.gz`,
        byteCount: 100,
        tableCount: 45,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: zoneExports.id });
    await expect(
      queueExport(db, { zoneId, requestedByUserId: userId }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      details: { existingExportId: completed.id },
    });
  });
});
