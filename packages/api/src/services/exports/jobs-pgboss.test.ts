// packages/api/src/services/exports/jobs-pgboss.test.ts
// Phase 9 §3 — recoverStaleRunningExports: a worker crash between
// claimExportById + finalizeExport leaves the row in `running`
// forever because the next pg-boss redelivery would bail on the
// non-`queued` status. The boot sweep flips these back to `queued`
// so the re-publish + claim cycle picks them up. Mirror of the
// report-queue sibling test.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  zoneExports,
  zones,
  user as userTable,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { recoverStaleRunningExports } from "./jobs-pgboss";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("recoverStaleRunningExports", () => {
  let zoneId: string;
  let userId: string;
  const slugs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("jobs-pgboss.test.ts requires a *_test DATABASE_URL");
    }
    const slug = `xb-${unique()}`;
    const [zone] = await db
      .insert(zones)
      .values({
        slug,
        name: `Export Recovery Zone ${unique()}`,
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
      email: `xb-${unique()}@example.com`,
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

  async function insertRunning(opts: { startedMinutesAgo: number }): Promise<string> {
    const startedAt = new Date(Date.now() - opts.startedMinutesAgo * 60_000);
    const [row] = await db
      .insert(zoneExports)
      .values({
        zoneId,
        requestedByUserId: userId,
        status: "running",
        startedAt,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: zoneExports.id });
    return row.id;
  }

  it("flips a `running` row older than 30m back to `queued`", async () => {
    const stale = await insertRunning({ startedMinutesAgo: 45 });
    const reset = await recoverStaleRunningExports(db);
    expect(reset).toContain(stale);
    const [after] = await db
      .select({ status: zoneExports.status, startedAt: zoneExports.startedAt })
      .from(zoneExports)
      .where(eq(zoneExports.id, stale));
    expect(after.status).toBe("queued");
    expect(after.startedAt).toBeNull();
  });

  it("leaves a fresh `running` row alone", async () => {
    const fresh = await insertRunning({ startedMinutesAgo: 5 });
    const reset = await recoverStaleRunningExports(db);
    expect(reset).not.toContain(fresh);
    const [after] = await db
      .select({ status: zoneExports.status })
      .from(zoneExports)
      .where(eq(zoneExports.id, fresh));
    expect(after.status).toBe("running");
  });

  it("respects a custom age threshold", async () => {
    const id = await insertRunning({ startedMinutesAgo: 10 });
    // With a 5-minute threshold the 10-minute-old row qualifies.
    const reset = await recoverStaleRunningExports(db, 5 * 60_000);
    expect(reset).toContain(id);
  });
});
