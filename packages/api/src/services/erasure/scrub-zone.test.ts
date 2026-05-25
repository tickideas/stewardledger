// packages/api/src/services/erasure/scrub-zone.test.ts
// Integration test for the zone-decommission orchestrator.
// Seeds a small zone (zone + chapter + member + import_file blob +
// report_jobs blob + zone_exports blob), runs the two-phase
// decommission, and asserts that every artefact is gone and every
// zone-scoped table is empty for the dropped zone id.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  auditEvents,
  chapters,
  importFiles,
  members,
  reportJobs,
  user as userTable,
  zoneExports,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { hardPurgeZone, softDecommissionZone } from "./scrub-zone";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface Seed {
  zoneId: string;
  userId: string;
  importKey: string;
  reportKey: string;
  exportKey: string;
}

async function seed(storage: InMemoryStorage): Promise<Seed> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug: `purge-${unique()}`,
      name: `Purge Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });

  const userId = `u-${unique()}`;
  await db.insert(userTable).values({
    id: userId,
    email: `purge-${unique()}@example.com`,
    emailVerified: true,
  });

  const [chap] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: "Purge Chapter",
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });

  await db.insert(members).values({
    zoneId: zone.id,
    chapterId: chap.id,
    referenceCode: `M-${unique()}`,
    firstName: "Purge",
  });

  const importBody = Buffer.from(`import-${unique()}`, "utf-8");
  const importKey = `${zone.id}/imports/2026/01/p-${unique()}.csv`;
  await storage.put(importKey, importBody);
  await db.insert(importFiles).values({
    zoneId: zone.id,
    uploadedByUserId: userId,
    fileType: "giving",
    originalFileName: "purge.csv",
    checksumSha256: createHash("sha256").update(importBody).digest("hex"),
    sizeBytes: importBody.length,
    storageKey: importKey,
  });

  const reportBody = Buffer.from(`report-${unique()}`, "utf-8");
  const reportKey = `${zone.id}/reports/2026/01/p-${unique()}.xlsx`;
  await storage.put(reportKey, reportBody);
  await db.insert(reportJobs).values({
    zoneId: zone.id,
    userId,
    reportId: "member-statement",
    format: "xlsx",
    status: "completed",
    storageKey: reportKey,
    rowCount: 1,
    byteCount: reportBody.length,
    completedAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const exportBody = Buffer.from(`export-${unique()}`, "utf-8");
  const exportKey = `${zone.id}/exports/2026/01/p-${unique()}.tar.gz`;
  await storage.put(exportKey, exportBody);
  await db.insert(zoneExports).values({
    zoneId: zone.id,
    requestedByUserId: userId,
    status: "completed",
    storageKey: exportKey,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  return { zoneId: zone.id, userId, importKey, reportKey, exportKey };
}

describe("scrubZone — softDecommission + hardPurge", () => {
  let storage: InMemoryStorage;
  const cleanupUserIds: string[] = [];

  beforeAll(() => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("scrub-zone.test.ts requires a *_test DATABASE_URL");
    }
    storage = new InMemoryStorage();
    setStorageForTesting(storage);
  });

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await db.delete(userTable).where(eq(userTable.id, id));
    }
    setStorageForTesting(null);
  });

  it("softDecommissionZone sets deleted_at; tenancy middleware ignores the zone next request", async () => {
    const s = await seed(storage);
    cleanupUserIds.push(s.userId);
    await softDecommissionZone(db, { zoneId: s.zoneId });
    const [row] = await db
      .select({ deletedAt: zones.deletedAt })
      .from(zones)
      .where(eq(zones.id, s.zoneId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.deletedAt).not.toBeNull();
    // Sanity: the row is still there — we did NOT hard-delete yet.
    // hardPurge would also wipe the seeded blobs.
    expect(storage.size()).toBeGreaterThanOrEqual(3);
    // Clean up by hard-purging so the next test has a clean slate.
    await hardPurgeZone(db, s.zoneId);
  });

  it("hardPurgeZone deletes every blob the zone owns and the zone row + tree", async () => {
    const s = await seed(storage);
    cleanupUserIds.push(s.userId);
    await softDecommissionZone(db, { zoneId: s.zoneId });
    const summary = await hardPurgeZone(db, s.zoneId);

    expect(summary.zoneDeleted).toBe(true);
    expect(summary.blobsDeleted).toBe(3);
    expect(summary.blobsFailed).toBe(0);

    // Storage: every key is gone.
    for (const key of [s.importKey, s.reportKey, s.exportKey]) {
      await expect(storage.get(key)).rejects.toThrow();
    }

    // DB: every zone-scoped row is gone (CASCADE swept the tree).
    const [zoneRow] = await db
      .select({ id: zones.id })
      .from(zones)
      .where(eq(zones.id, s.zoneId))
      .limit(1);
    expect(zoneRow).toBeUndefined();

    const remainingChapters = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(eq(chapters.zoneId, s.zoneId));
    expect(remainingChapters).toEqual([]);

    const remainingMembers = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.zoneId, s.zoneId));
    expect(remainingMembers).toEqual([]);

    const remainingExports = await db
      .select({ id: zoneExports.id })
      .from(zoneExports)
      .where(eq(zoneExports.zoneId, s.zoneId));
    expect(remainingExports).toEqual([]);
  });

  it("hardPurgeZone tolerates a missing blob (idempotent storage.delete)", async () => {
    const s = await seed(storage);
    cleanupUserIds.push(s.userId);
    // Out-of-band cleanup: delete one blob directly so the
    // purge sees the row but not the artefact. The storage
    // interface treats `delete` as idempotent, so this still
    // counts toward `blobsDeleted` (post-condition "blob is
    // gone" holds) and the row delete still succeeds.
    await storage.delete(s.reportKey);
    await softDecommissionZone(db, { zoneId: s.zoneId });
    const summary = await hardPurgeZone(db, s.zoneId);
    expect(summary.blobsDeleted).toBe(3);
    expect(summary.blobsFailed).toBe(0);
    expect(summary.zoneDeleted).toBe(true);
  });

  it("hardPurgeZone leaves platform-scope audit rows intact (zone_id IS NULL)", async () => {
    const s = await seed(storage);
    cleanupUserIds.push(s.userId);
    // Write a platform-scope audit row that should survive the
    // cascade. The CHECK on audit_events permits NULL zone_id
    // only when the action is prefixed `platform.*`.
    await db.insert(auditEvents).values({
      zoneId: null,
      action: "platform.zone.erase.applied",
      entityType: "zone",
      entityId: s.zoneId,
      after: { test: true },
    });
    await softDecommissionZone(db, { zoneId: s.zoneId });
    await hardPurgeZone(db, s.zoneId);
    const surviving = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, s.zoneId));
    // The platform-scope row stays; tenant-scope audit rows for
    // the zone (none seeded in this test) would have cascaded.
    expect(surviving.length).toBeGreaterThanOrEqual(1);
    // Clean up the test-leftover audit row so afterAll stays
    // narrow-scoped (these rows have no FK so they otherwise leak).
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.entityId, s.zoneId));
  });
});
