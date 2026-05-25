// packages/api/src/services/exports/cleanup.test.ts
// Phase 9 §3 — cleanup pass: deletes expired blobs, flips rows to
// `expired`, writes a platform-scope audit row, and survives a
// storage backend that refuses to delete. Mirror of
// `reports/cleanup.test.ts`.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  user as userTable,
  zoneExports,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { cleanupExpiredZoneExports } from "./cleanup";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("zone export cleanup — cleanupExpiredZoneExports", () => {
  let zoneId: string;
  let userId: string;
  let storage: InMemoryStorage;
  const slugs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("cleanup.test.ts requires a *_test DATABASE_URL");
    }
    const slug = `xcl-${unique()}`;
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
      .returning({ id: zones.id });
    zoneId = zone.id;
    slugs.push(slug);

    userId = `u-${unique()}`;
    await db.insert(userTable).values({
      id: userId,
      email: `xcl-${unique()}@example.com`,
      emailVerified: true,
    });
    userIds.push(userId);

    // Wipe any platform-scope cleanup audits from a prior test run.
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.action, "platform.zone.export.cleanup.run"));
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
    await db.delete(zoneExports).where(eq(zoneExports.zoneId, zoneId));
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.action, "platform.zone.export.cleanup.run"));
    setStorageForTesting(null);
  });

  async function insertExport(opts: {
    status: "queued" | "running" | "completed" | "failed" | "expired";
    storageKey: string | null;
    /**
     * Whether the row should appear expired to the sweep. The DB
     * CHECK `expires_at > created_at` forbids inserting an
     * already-expired row directly, so we insert fresh and then
     * use raw SQL to push `expires_at` back into the past. The
     * CHECK doesn't fire on UPDATE either — wait, it does — so
     * we instead push `created_at` forward (a row that thinks it
     * was created in the future is still consistent with
     * `expires_at > created_at` after we move both).
     */
    expired?: boolean;
  }): Promise<string> {
    const now = Date.now();
    const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(zoneExports)
      .values({
        zoneId,
        requestedByUserId: userId,
        status: opts.status,
        storageKey: opts.storageKey,
        byteCount: opts.storageKey ? 1024 : null,
        tableCount: opts.storageKey ? 40 : null,
        fileCount: opts.storageKey ? 1 : null,
        artefactCount: opts.storageKey ? 0 : null,
        expiresAt,
      })
      .returning({ id: zoneExports.id });
    if (opts.expired) {
      // Move `created_at` to 8 days ago and `expires_at` to 1 day
      // ago. Both still satisfy `expires_at > created_at`.
      // ISO strings + the `::timestamptz` cast keep the bind-type
      // away from `postgres-js`'s reflexive Date → timestamp
      // mapping, which the driver doesn't accept in raw template
      // params.
      const pastCreated = new Date(
        now - 8 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const pastExpiry = new Date(
        now - 24 * 60 * 60 * 1000,
      ).toISOString();
      await db.execute(
        sql`update zone_exports
              set created_at = ${pastCreated}::timestamptz,
                  expires_at = ${pastExpiry}::timestamptz
            where id = ${row.id}`,
      );
    }
    return row.id;
  }

  it("deletes expired completed bundles + writes the platform audit", async () => {
    storage = new InMemoryStorage();
    setStorageForTesting(storage);
    const key = `${zoneId}/exports/2026/01/expired.tar.gz`;
    await storage.put(key, Buffer.from("gz-bytes"));
    const id = await insertExport({
      status: "completed",
      storageKey: key,
      expired: true,
    });

    const summary = await cleanupExpiredZoneExports(db);
    expect(summary.scanned).toBe(1);
    expect(summary.deletedArtefacts).toBe(1);
    expect(summary.expiredRows).toBe(1);

    const [row] = await db
      .select({ status: zoneExports.status, storageKey: zoneExports.storageKey })
      .from(zoneExports)
      .where(eq(zoneExports.id, id));
    expect(row.status).toBe("expired");
    expect(row.storageKey).toBeNull();

    const audits = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "platform.zone.export.cleanup.run"));
    expect(audits).toHaveLength(1);
  });

  it("skips fresh + non-completed bundles", async () => {
    storage = new InMemoryStorage();
    setStorageForTesting(storage);
    const freshKey = `${zoneId}/exports/2026/01/fresh.tar.gz`;
    await storage.put(freshKey, Buffer.from("fresh"));
    const fresh = await insertExport({
      status: "completed",
      storageKey: freshKey,
      // Default expiry is 7 days in the future — not expired.
    });
    const failed = await insertExport({
      status: "failed",
      storageKey: null,
      expired: true,
    });

    const summary = await cleanupExpiredZoneExports(db);
    expect(summary.scanned).toBe(0);

    for (const id of [fresh, failed]) {
      const [row] = await db
        .select({ status: zoneExports.status })
        .from(zoneExports)
        .where(eq(zoneExports.id, id));
      expect(row.status).not.toBe("expired");
    }
  });

  it("still flips the row when blob delete throws (storage best-effort)", async () => {
    storage = new InMemoryStorage();
    setStorageForTesting({
      put: storage.put.bind(storage),
      get: storage.get.bind(storage),
      // Throwing delete simulates an S3 outage.
      delete: async () => {
        throw new Error("simulated storage outage");
      },
    });
    const id = await insertExport({
      status: "completed",
      storageKey: `${zoneId}/exports/2026/01/orphan.tar.gz`,
      expired: true,
    });

    const summary = await cleanupExpiredZoneExports(db);
    expect(summary.scanned).toBe(1);
    expect(summary.deletedArtefacts).toBe(0);
    expect(summary.expiredRows).toBe(1);

    const [row] = await db
      .select({ status: zoneExports.status })
      .from(zoneExports)
      .where(eq(zoneExports.id, id));
    expect(row.status).toBe("expired");
  });
});
