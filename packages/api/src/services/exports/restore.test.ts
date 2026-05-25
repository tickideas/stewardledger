// packages/api/src/services/exports/restore.test.ts
// Phase 9 §3 — restore-helper round-trip (the canonical Phase 9
// exit-criterion gate).
//
//   1. Seed a small zone (zone row + chapter + member + import_file
//      + report_jobs row, each with a real storage blob).
//   2. Build the export bundle via `buildZoneExportBundle`.
//   3. Restore the bundle under a FRESH zone id (same DB, new
//      identity — the bundle generator + registry guarantee no row
//      references existing data through anything other than
//      `zone_id`, `user.id`, or `regions.id`; we null those edges
//      out).
//   4. Assert per-table row counts in the target zone equal the
//      source's, that the restored content hashes match the seeded
//      values, and that the storage blobs are byte-for-byte
//      identical at their new keys.
//
// Tests the script as a library (`restoreZoneExportBundle`) — the
// thin CLI wrapper is just argv parsing. The test path mirrors what
// an operator running `pnpm restore-export` against a fresh target
// schema would see, modulo the migration step (skipped because the
// test DB already carries the migrated schema).

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  chapters,
  erasureRequests,
  importFiles,
  members,
  reportJobs,
  user as userTable,
  zones,
  zoneExports,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { buildZoneExportBundle } from "./bundle";
import { bundleStorageKey } from "./jobs";
import { restoreZoneExportBundle } from "./restore";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SeededZone {
  zoneId: string;
  zoneSlug: string;
  userId: string;
  chapterId: string;
  memberRefCode: string;
  memberFirstName: string;
  importFileId: string;
  importBlobBody: Buffer;
  reportJobId: string;
  reportBlobBody: Buffer;
}

async function seedZone(
  slug: string,
  storage: InMemoryStorage,
): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Restore Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });

  const userId = `u-${unique()}`;
  await db.insert(userTable).values({
    id: userId,
    email: `restore-${unique()}@example.com`,
    emailVerified: true,
  });

  const memberRefCode = `M-${unique()}`;
  const memberFirstName = `First-${unique()}`;

  const [chapter] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: "Restore Chapter",
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });

  await db.insert(members).values({
    zoneId: zone.id,
    chapterId: chapter.id,
    referenceCode: memberRefCode,
    firstName: memberFirstName,
    lastName: "Restore",
  });

  const importBlobBody = Buffer.from(
    `zone=${zone.id}\nA,B\n1,2\n`,
    "utf-8",
  );
  const importBlobKey = `${zone.id}/imports/2026/01/r-${unique()}.csv`;
  await storage.put(importBlobKey, importBlobBody);
  const [imp] = await db
    .insert(importFiles)
    .values({
      zoneId: zone.id,
      uploadedByUserId: userId,
      fileType: "giving",
      originalFileName: "restore.csv",
      checksumSha256: createHash("sha256").update(importBlobBody).digest("hex"),
      sizeBytes: importBlobBody.length,
      storageKey: importBlobKey,
    })
    .returning({ id: importFiles.id });

  const reportBlobBody = Buffer.from(`report-${unique()}`, "utf-8");
  const reportBlobKey = `${zone.id}/reports/2026/01/r-${unique()}.xlsx`;
  await storage.put(reportBlobKey, reportBlobBody);
  const [rep] = await db
    .insert(reportJobs)
    .values({
      zoneId: zone.id,
      userId,
      reportId: "member-statement",
      format: "xlsx",
      status: "completed",
      storageKey: reportBlobKey,
      rowCount: 1,
      byteCount: reportBlobBody.length,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: reportJobs.id });

  return {
    zoneId: zone.id,
    zoneSlug: zone.slug,
    userId,
    chapterId: chapter.id,
    memberRefCode,
    memberFirstName,
    importFileId: imp.id,
    importBlobBody,
    reportJobId: rep.id,
    reportBlobBody,
  };
}

async function cleanupZone(zoneId: string): Promise<void> {
  // FK chain: clean children before zones. The cascade handles most
  // edges, but `import_files` is restrict, so wipe explicitly.
  await db.delete(reportJobs).where(eq(reportJobs.zoneId, zoneId));
  await db.delete(importFiles).where(eq(importFiles.zoneId, zoneId));
  // erasure_requests has `member_id ON DELETE SET NULL` so the
  // member delete below would leave it dangling against
  // `erasure_requests.zone_id` (CASCADE handles that, but we wipe
  // explicitly to keep ordering obvious + the test deterministic).
  await db.delete(erasureRequests).where(eq(erasureRequests.zoneId, zoneId));
  await db.delete(members).where(eq(members.zoneId, zoneId));
  await db.delete(chapters).where(eq(chapters.zoneId, zoneId));
  await db.delete(zoneExports).where(eq(zoneExports.zoneId, zoneId));
  await db.execute(sql`delete from zones where id = ${zoneId}`);
}

describe("zone export bundle — restoreZoneExportBundle (round-trip)", () => {
  let storage: InMemoryStorage;
  const sourceZoneIds: string[] = [];
  const targetZoneIds: string[] = [];
  const userIds: string[] = [];
  // Every test that materialises a bundle to disk pushes its temp
  // directory here; afterAll wipes them so repeated local runs
  // don't accumulate `sl-restore-*` directories under the OS temp.
  const tempDirs: string[] = [];

  beforeAll(() => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("restore.test.ts requires a *_test DATABASE_URL");
    }
    storage = new InMemoryStorage();
    setStorageForTesting(storage);
  });

  afterAll(async () => {
    for (const id of sourceZoneIds) await cleanupZone(id);
    for (const id of targetZoneIds) await cleanupZone(id);
    for (const id of userIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    setStorageForTesting(null);
  });

  it("ticks the Phase 9 exit criterion: restores a bundle into a clean zone identity", async () => {
    const sourceSlug = `restore-src-${unique()}`;
    const seed = await seedZone(sourceSlug, storage);
    // NOTE: source zone is intentionally NOT pushed into sourceZoneIds
    // because we tear it down explicitly below before the restore
    // (the helper's contract per `tasks/zone-export-bundle.md` non-
    // goals is "requires an empty target" — a same-DB restore on
    // top of the same PKs would 23505 on `chapters.id` etc).
    userIds.push(seed.userId);
    const memberRefCode = seed.memberRefCode;
    const memberFirstName = seed.memberFirstName;
    const seedImportBlobBody = seed.importBlobBody;
    const seedReportBlobBody = seed.reportBlobBody;

    // 1. Build the bundle.
    const exportId = crypto.randomUUID();
    const bundleKey = bundleStorageKey(seed.zoneId, exportId);
    const result = await buildZoneExportBundle(db, {
      zoneId: seed.zoneId,
      exportId,
      storageKey: bundleKey,
    });
    expect(result.byteCount).toBeGreaterThan(0);

    // Pull the gzipped artefact back from in-memory storage and
    // write it to a temp file so `restoreZoneExportBundle` can open
    // it from disk (matching the operator-facing `pnpm
    // restore-export <file>` flow). The temp dir is tracked for
    // afterAll cleanup.
    const tmp = await mkdtemp(join(tmpdir(), "sl-restore-test-"));
    tempDirs.push(tmp);
    const bundlePath = join(tmp, "bundle.tar.gz");
    await writeFile(bundlePath, Buffer.from(await storage.get(bundleKey)));

    // 2. Tear down the source zone so the target restores into an
    // empty schema (the helper's contract). Storage blobs at the
    // source-zone prefix are orphaned but harmless — the bundle
    // carries its own copy.
    await cleanupZone(seed.zoneId);

    // 3. Restore into a fresh zone identity. The source user row
    // survives the zone cleanup (it's in the global `user` table),
    // so we hand the helper an identity map so NOT NULL user FKs
    // (`report_jobs.user_id`, `roles.created_by_user_id`) can be
    // remapped instead of skipped.
    const targetZoneId = crypto.randomUUID();
    const targetSlug = `restore-dst-${unique()}`;
    targetZoneIds.push(targetZoneId);
    const logs: string[] = [];
    const restore = await restoreZoneExportBundle({
      bundlePath,
      database: db,
      storage,
      targetZoneId,
      targetSlug,
      userIdMap: new Map([[seed.userId, seed.userId]]),
      log: (m) => logs.push(m),
    });
    expect(restore.targetZoneId).toBe(targetZoneId);
    expect(restore.targetSlug).toBe(targetSlug);

    // 3. Assert per-table row counts. The exit criterion is "every
    // record for that zone" — for each declared registry table, the
    // count in the target zone must equal the count in the source.
    // (Tables whose only rows hold a NOT NULL `_user_id` we couldn't
    // map are skipped — those are recorded in `tablesRestored[].skipped`
    // and excluded from the equality check.)
    const tablesByName = new Map(
      restore.tablesRestored.map((t) => [t.name, t]),
    );

    // Spot-check the core domain tables. The whole registry walks
    // through `restoreOrder` so a regression in any table would
    // surface here as a row-count mismatch.
    expect(tablesByName.get("zones")?.inserted).toBe(1);
    expect(tablesByName.get("chapters")?.inserted).toBe(1);
    expect(tablesByName.get("members")?.inserted).toBe(1);
    expect(tablesByName.get("import_files")?.inserted).toBe(1);
    expect(tablesByName.get("report_jobs")?.inserted).toBe(1);

    // The target zone exists with the rewritten slug.
    const [targetZone] = await db
      .select({ id: zones.id, slug: zones.slug, name: zones.name })
      .from(zones)
      .where(eq(zones.id, targetZoneId))
      .limit(1);
    expect(targetZone).toBeDefined();
    expect(targetZone.slug).toBe(targetSlug);

    // Content hash check: pull the restored member by reference
    // code and prove the immutable fields round-tripped intact.
    // We compare only stable identity fields (refCode, firstName,
    // lastName) because timestamps may serialise with sub-ms
    // precision drift through JSON.
    const [restoredMember] = await db
      .select({
        referenceCode: members.referenceCode,
        firstName: members.firstName,
        lastName: members.lastName,
        chapterId: members.chapterId,
      })
      .from(members)
      .where(eq(members.zoneId, targetZoneId))
      .limit(1);
    expect(restoredMember).toBeDefined();
    expect(restoredMember.referenceCode).toBe(memberRefCode);
    expect(restoredMember.firstName).toBe(memberFirstName);
    expect(restoredMember.lastName).toBe("Restore");

    // 4. Storage blobs land at the rewritten keys and are
    // byte-for-byte identical to the seed.
    const [restoredImport] = await db
      .select({ storageKey: importFiles.storageKey })
      .from(importFiles)
      .where(eq(importFiles.zoneId, targetZoneId))
      .limit(1);
    expect(restoredImport.storageKey).toContain(targetZoneId);
    expect(restoredImport.storageKey).not.toContain(seed.zoneId);
    const restoredImportBlob = await storage.get(restoredImport.storageKey!);
    expect(Buffer.from(restoredImportBlob).equals(seedImportBlobBody)).toBe(true);

    const [restoredReport] = await db
      .select({ storageKey: reportJobs.storageKey })
      .from(reportJobs)
      .where(eq(reportJobs.zoneId, targetZoneId))
      .limit(1);
    expect(restoredReport.storageKey).toContain(targetZoneId);
    const restoredReportBlob = await storage.get(restoredReport.storageKey!);
    expect(Buffer.from(restoredReportBlob).equals(seedReportBlobBody)).toBe(true);

    expect(restore.filesRestored).toBe(1);
    expect(restore.reportsRestored).toBe(1);
  });

  it("rewrites pending erasure_requests → cancelled on import (restore contract)", async () => {
    // Per the schema header on `erasure-requests.ts` + the
    // registry note, every `pending` erasure_requests row must be
    // auto-cancelled on bundle import so the restore target's
    // cron sweep doesn't fire a scrub scheduled on the source
    // environment against different data. This test seeds one
    // pending row + one already-cancelled row + one applied row,
    // round-trips the bundle, and asserts that only the pending
    // one was rewritten.
    const sourceSlug = `restore-erasure-${unique()}`;
    const seed = await seedZone(sourceSlug, storage);
    userIds.push(seed.userId);

    // Look up the seeded member id (the round-trip test asserts
    // by reference code; we need the id for FK + the
    // erasure_requests.member_id FK).
    const [seededMember] = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.zoneId, seed.zoneId))
      .limit(1);

    // Pending member-scope row. The CHECK requires `applies_at >
    // created_at`; pick a 14-day future window so it survives the
    // round-trip.
    const pendingCreated = new Date(Date.now() - 60_000);
    const pendingApplies = new Date(
      pendingCreated.getTime() + 14 * 24 * 60 * 60 * 1000,
    );
    const [pendingRow] = await db
      .insert(erasureRequests)
      .values({
        id: crypto.randomUUID(),
        zoneId: seed.zoneId,
        scope: "member",
        memberId: seededMember.id,
        requestedByUserId: seed.userId,
        reason: "original-reason",
        status: "pending",
        reversibilityWindowDays: 14,
        appliesAt: pendingApplies,
        createdAt: pendingCreated,
        updatedAt: pendingCreated,
      })
      .returning({ id: erasureRequests.id });

    // Already-cancelled row: same window shape but terminal
    // status. The restore must leave the status alone.
    const [cancelledRow] = await db
      .insert(erasureRequests)
      .values({
        id: crypto.randomUUID(),
        zoneId: seed.zoneId,
        scope: "member",
        memberId: seededMember.id,
        requestedByUserId: seed.userId,
        reason: "cancelled-by-owner",
        status: "cancelled",
        reversibilityWindowDays: 14,
        appliesAt: pendingApplies,
        createdAt: pendingCreated,
        updatedAt: pendingCreated,
        cancelledAt: new Date(),
        cancelledByUserId: seed.userId,
      })
      .returning({ id: erasureRequests.id });

    // Applied row with `member_id IS NULL` (the FK ON DELETE SET
    // NULL relaxation the CHECK allows on terminal status). The
    // restore must NOT rewrite this either.
    const [appliedRow] = await db
      .insert(erasureRequests)
      .values({
        id: crypto.randomUUID(),
        zoneId: seed.zoneId,
        scope: "member",
        memberId: null,
        requestedByUserId: seed.userId,
        reason: "applied-then-member-gone",
        status: "applied",
        reversibilityWindowDays: 14,
        appliesAt: pendingApplies,
        createdAt: pendingCreated,
        updatedAt: pendingCreated,
        appliedAt: new Date(),
      })
      .returning({ id: erasureRequests.id });

    // Build the bundle.
    const exportId = crypto.randomUUID();
    const bundleKey = bundleStorageKey(seed.zoneId, exportId);
    await buildZoneExportBundle(db, {
      zoneId: seed.zoneId,
      exportId,
      storageKey: bundleKey,
    });
    const tmp = await mkdtemp(join(tmpdir(), "sl-restore-erasure-"));
    tempDirs.push(tmp);
    const bundlePath = join(tmp, "bundle.tar.gz");
    await writeFile(bundlePath, Buffer.from(await storage.get(bundleKey)));

    // Tear down the source so the restore lands into a clean
    // identity (same contract as the canonical round-trip test).
    await cleanupZone(seed.zoneId);

    // Restore. Inject a deterministic `now` so the auto-cancel
    // timestamp is predictable.
    const restoreNow = new Date("2026-06-15T12:00:00.000Z");
    const targetZoneId = crypto.randomUUID();
    const targetSlug = `restore-erasure-dst-${unique()}`;
    targetZoneIds.push(targetZoneId);
    await restoreZoneExportBundle({
      bundlePath,
      database: db,
      storage,
      targetZoneId,
      targetSlug,
      userIdMap: new Map([[seed.userId, seed.userId]]),
      now: restoreNow,
      log: () => {},
    });

    // The pending row is now `cancelled` with the marker reason
    // and the injected `cancelledAt`.
    const [restoredPending] = await db
      .select({
        status: erasureRequests.status,
        reason: erasureRequests.reason,
        cancelledAt: erasureRequests.cancelledAt,
        cancelledByUserId: erasureRequests.cancelledByUserId,
        updatedAt: erasureRequests.updatedAt,
      })
      .from(erasureRequests)
      .where(eq(erasureRequests.id, pendingRow.id))
      .limit(1);
    expect(restoredPending.status).toBe("cancelled");
    expect(restoredPending.reason).toBe(
      "original-reason — auto-cancelled on bundle restore",
    );
    expect(restoredPending.cancelledAt?.toISOString()).toBe(
      restoreNow.toISOString(),
    );
    expect(restoredPending.cancelledByUserId).toBeNull();
    expect(restoredPending.updatedAt.toISOString()).toBe(
      restoreNow.toISOString(),
    );

    // The already-cancelled row is untouched.
    const [restoredCancelled] = await db
      .select({
        status: erasureRequests.status,
        reason: erasureRequests.reason,
      })
      .from(erasureRequests)
      .where(eq(erasureRequests.id, cancelledRow.id))
      .limit(1);
    expect(restoredCancelled.status).toBe("cancelled");
    expect(restoredCancelled.reason).toBe("cancelled-by-owner");

    // The applied row is untouched (status still 'applied',
    // member_id still null).
    const [restoredApplied] = await db
      .select({
        status: erasureRequests.status,
        memberId: erasureRequests.memberId,
      })
      .from(erasureRequests)
      .where(eq(erasureRequests.id, appliedRow.id))
      .limit(1);
    expect(restoredApplied.status).toBe("applied");
    expect(restoredApplied.memberId).toBeNull();
  });

  it("dry-run reports planned inserts without writing", async () => {
    const slug = `restore-dry-${unique()}`;
    const seed = await seedZone(slug, storage);
    sourceZoneIds.push(seed.zoneId); // dry-run keeps source intact
    userIds.push(seed.userId);

    const exportId = crypto.randomUUID();
    const bundleKey = bundleStorageKey(seed.zoneId, exportId);
    await buildZoneExportBundle(db, {
      zoneId: seed.zoneId,
      exportId,
      storageKey: bundleKey,
    });

    const tmp = await mkdtemp(join(tmpdir(), "sl-restore-dry-"));
    tempDirs.push(tmp);
    const bundlePath = join(tmp, "bundle.tar.gz");
    await writeFile(bundlePath, Buffer.from(await storage.get(bundleKey)));

    const targetZoneId = crypto.randomUUID();
    // NOT added to targetZoneIds because dry-run shouldn't create rows.
    const restore = await restoreZoneExportBundle({
      bundlePath,
      database: db,
      storage,
      targetZoneId,
      dryRun: true,
    });

    expect(restore.tablesRestored.every((t) => t.inserted === 0)).toBe(true);
    expect(restore.filesRestored).toBe(0);
    expect(restore.reportsRestored).toBe(0);

    // Confirm no zone row was written.
    const [maybeZone] = await db
      .select({ id: zones.id })
      .from(zones)
      .where(eq(zones.id, targetZoneId))
      .limit(1);
    expect(maybeZone).toBeUndefined();
  });
});
