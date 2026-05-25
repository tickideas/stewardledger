// packages/api/src/services/reports/jobs-pgboss.test.ts
// Phase 7 PR 2 — recoverStaleRunningJobs: a worker crash between
// claimJobById + finalizeJob leaves the row in `running` forever
// because the next pg-boss redelivery enters handleGenerate and
// bails on the non-`queued` status. The boot sweep flips these back
// to `queued` so the re-publish + claim cycle picks them up.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  reportJobs,
  user as userTable,
  zones,
  type ReportJob,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { recoverStaleRunningJobs } from "./jobs-pgboss";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("recoverStaleRunningJobs", () => {
  let zoneId: string;
  let userId: string;
  const slugs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("jobs-pgboss.test.ts requires a *_test DATABASE_URL");
    }
    const slug = `rb-${unique()}`;
    const [zone] = await db
      .insert(zones)
      .values({
        slug,
        name: `Recovery Zone ${unique()}`,
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
      email: `rb-${unique()}@example.com`,
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
    await db.delete(reportJobs).where(eq(reportJobs.zoneId, zoneId));
  });

  async function insertJob(args: {
    status: "queued" | "running" | "completed" | "failed";
    startedAt: Date | null;
  }): Promise<ReportJob> {
    const [row] = await db
      .insert(reportJobs)
      .values({
        zoneId,
        userId,
        reportId: "member-statement",
        format: "xlsx",
        status: args.status,
        startedAt: args.startedAt,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      .returning();
    return row;
  }

  it("flips a stale running row back to queued", async () => {
    const stale = await insertJob({
      status: "running",
      startedAt: new Date(Date.now() - 20 * 60_000),
    });

    const reset = await recoverStaleRunningJobs(db);
    expect(reset).toContain(stale.id);

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, stale.id));
    expect(row.status).toBe("queued");
    expect(row.startedAt).toBeNull();
  });

  it("leaves a fresh running row alone", async () => {
    const fresh = await insertJob({
      status: "running",
      startedAt: new Date(Date.now() - 30_000),
    });

    const reset = await recoverStaleRunningJobs(db);
    expect(reset).not.toContain(fresh.id);

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, fresh.id));
    expect(row.status).toBe("running");
    expect(row.startedAt).not.toBeNull();
  });

  it("ignores running rows with a null startedAt (never claimed)", async () => {
    // Defensive: a row with status='running' but startedAt=null
    // shouldn't exist (claimJobById always sets both atomically),
    // but if one slipped through we don't want to thrash it.
    const odd = await insertJob({ status: "running", startedAt: null });
    const reset = await recoverStaleRunningJobs(db);
    expect(reset).not.toContain(odd.id);
  });

  it("does not touch terminal rows", async () => {
    const done = await insertJob({
      status: "completed",
      startedAt: new Date(Date.now() - 60 * 60_000),
    });
    const reset = await recoverStaleRunningJobs(db);
    expect(reset).not.toContain(done.id);
  });

  it("respects a caller-supplied ageMs threshold", async () => {
    const twoMinutesOld = await insertJob({
      status: "running",
      startedAt: new Date(Date.now() - 2 * 60_000),
    });

    // Default threshold (15m) leaves it alone.
    const defaultReset = await recoverStaleRunningJobs(db);
    expect(defaultReset).not.toContain(twoMinutesOld.id);

    // A 1-minute threshold sweeps it.
    const tightReset = await recoverStaleRunningJobs(db, 60_000);
    expect(tightReset).toContain(twoMinutesOld.id);
  });
});
