// packages/api/src/services/reports/cleanup.test.ts
// Phase 7 PR 2 \u2014 cleanup pass: deletes expired blobs, flips rows
// to `expired`, writes a platform-scope audit, and survives a
// storage backend that refuses to delete.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  reportJobs,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { cleanupExpiredArtefacts } from "./cleanup";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SeededZone {
  id: string;
  slug: string;
}

async function seedZone(slug: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Cleanup Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  return { id: zone.id, slug: zone.slug };
}

describe("report cleanup \u2014 cleanupExpiredArtefacts", () => {
  let zone: SeededZone;
  let userId: string;
  const slugs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("cleanup.test.ts requires a *_test DATABASE_URL");
    }
    zone = await seedZone(`cl-${unique()}`);
    slugs.push(zone.slug);
    // Wipe any platform-scope cleanup audits left over from a
    // prior test run — those rows are zone-less and the per-zone
    // afterEach can't catch them.
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.action, "platform.report.cleanup.run"));
    userId = `u-${unique()}`;
    await db.insert(userTable).values({
      id: userId,
      email: `cl-${unique()}@example.com`,
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
    setStorageForTesting(null);
  });

  afterEach(async () => {
    await db.delete(reportJobs).where(eq(reportJobs.zoneId, zone.id));
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.action, "platform.report.cleanup.run"));
    setStorageForTesting(null);
  });

  async function insertJob(opts: {
    status: "queued" | "running" | "completed" | "failed" | "expired";
    storageKey: string | null;
    expiresInMs: number;
  }): Promise<string> {
    const expiresAt = new Date(Date.now() + opts.expiresInMs);
    const [row] = await db
      .insert(reportJobs)
      .values({
        zoneId: zone.id,
        userId,
        reportId: "member-statement",
        format: "xlsx",
        status: opts.status,
        storageKey: opts.storageKey,
        expiresAt,
      })
      .returning({ id: reportJobs.id });
    return row.id;
  }

  it("returns a zero-row summary when nothing is expired", async () => {
    const summary = await cleanupExpiredArtefacts(db);
    expect(summary).toEqual({ scanned: 0, deletedArtefacts: 0, expiredRows: 0 });
    // No audit on no-op runs \u2014 nothing happened.
    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "platform.report.cleanup.run"));
    expect(audits).toHaveLength(0);
  });

  it("deletes blob + flips row to expired for completed expired jobs", async () => {
    const storage = new InMemoryStorage();
    setStorageForTesting(storage);
    const key = `${zone.id}/reports/2024/01/blob.xlsx`;
    await storage.put(key, new Uint8Array([1, 2, 3]));
    const jobId = await insertJob({
      status: "completed",
      storageKey: key,
      expiresInMs: -60_000,
    });

    const summary = await cleanupExpiredArtefacts(db);
    expect(summary).toEqual({ scanned: 1, deletedArtefacts: 1, expiredRows: 1 });
    expect(storage.size()).toBe(0);

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, jobId));
    expect(row.status).toBe("expired");
    expect(row.storageKey).toBeNull();

    const audits = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "platform.report.cleanup.run"));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({
      scanned: 1,
      deletedArtefacts: 1,
      expiredRows: 1,
    });
  });

  it("skips non-completed rows even when expired", async () => {
    const storage = new InMemoryStorage();
    setStorageForTesting(storage);
    const failedKey = `${zone.id}/reports/2024/01/failed.xlsx`;
    // A `failed` row should never have a storage_key, but if one
    // did slip through we still wouldn't touch it.
    await storage.put(failedKey, new Uint8Array([9]));
    const failedJob = await insertJob({
      status: "failed",
      storageKey: failedKey,
      expiresInMs: -60_000,
    });
    const queuedJob = await insertJob({
      status: "queued",
      storageKey: null,
      expiresInMs: -60_000,
    });

    const summary = await cleanupExpiredArtefacts(db);
    expect(summary).toEqual({ scanned: 0, deletedArtefacts: 0, expiredRows: 0 });
    expect(storage.size()).toBe(1);

    const rows = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.zoneId, zone.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(failedJob)?.status).toBe("failed");
    expect(byId.get(queuedJob)?.status).toBe("queued");
  });

  it("flips the row even when the blob delete throws", async () => {
    const failing = {
      put: async (): Promise<void> => {},
      get: async (): Promise<Uint8Array> => new Uint8Array(),
      delete: async (): Promise<void> => {
        throw new Error("simulated storage outage");
      },
    };
    setStorageForTesting(failing);
    const jobId = await insertJob({
      status: "completed",
      storageKey: `${zone.id}/reports/2024/01/poison.xlsx`,
      expiresInMs: -60_000,
    });

    const summary = await cleanupExpiredArtefacts(db);
    expect(summary.scanned).toBe(1);
    expect(summary.deletedArtefacts).toBe(0);
    expect(summary.expiredRows).toBe(1);

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, jobId));
    expect(row.status).toBe("expired");
    expect(row.storageKey).toBeNull();
  });
});
