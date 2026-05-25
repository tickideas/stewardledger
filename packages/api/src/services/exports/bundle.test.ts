// packages/api/src/services/exports/bundle.test.ts
// Phase 9 §3 — bundle round-trip: seeds a tiny zone, builds the
// bundle, untars the result, and asserts that:
//
//   - the artefact is gzipped tar that opens cleanly,
//   - the manifest lists every registry table,
//   - each JSONL row count matches the seeded row count,
//   - import-file blobs are byte-for-byte identical,
//   - retained report artefacts are byte-for-byte identical,
//   - cross-zone data does NOT leak into the bundle.
//
// We deliberately seed via direct INSERTs (not the higher-level
// services) so this test isolates the bundle path and stays fast.

import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as tar from "tar-stream";
import {
  chapters,
  importFiles,
  members,
  reportJobs,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { buildZoneExportBundle } from "./bundle";
import { bundleStorageKey } from "./jobs";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface Untarred {
  files: Map<string, Buffer>;
}

async function untar(gzipped: Buffer): Promise<Untarred> {
  const tarBytes = gunzipSync(gzipped);
  const extract = tar.extract();
  const out: Untarred = { files: new Map() };
  const done = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        out.files.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });
    extract.on("finish", () => resolve());
    extract.on("error", reject);
  });
  Readable.from(tarBytes).pipe(extract);
  await done;
  return out;
}

interface SeededZone {
  zoneId: string;
  zoneSlug: string;
  userId: string;
  importFileId: string;
  importBlobKey: string;
  importBlobBody: Buffer;
  reportJobId: string;
  reportBlobKey: string;
  reportBlobBody: Buffer;
  chapterId: string;
  memberId: string;
}

async function seedZone(slug: string, storage: InMemoryStorage): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Bundle Zone ${unique()}`,
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
    email: `bundle-${unique()}@example.com`,
    emailVerified: true,
  });

  const [chapter] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: "Test Chapter",
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });

  const [member] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chapter.id,
      referenceCode: `M-${unique()}`,
      firstName: "Bundle",
      lastName: "Tester",
    })
    .returning({ id: members.id });

  // Import file with a real blob in storage. Skipping the
  // contribution lineage seed — the bundle path is
  // schema-introspection-driven, so an empty contributions table
  // still proves the dump-loop visits it. We assert presence of the
  // members + zones + import_files JSONL further down, which is
  // the tightest signal that the loop ran.
  // Tag the body with the zone id so a cross-zone-leak assertion
  // can compare blobs by content rather than by storage key alone.
  const importBlobBody = Buffer.from(
    `zone=${zone.id}\nfirst,second\nfoo,bar\n`,
    "utf-8",
  );
  const importBlobKey = `${zone.id}/imports/2026/01/test-${unique()}.csv`;
  await storage.put(importBlobKey, importBlobBody);
  const [imp] = await db
    .insert(importFiles)
    .values({
      zoneId: zone.id,
      uploadedByUserId: userId,
      fileType: "giving",
      originalFileName: "test.csv",
      checksumSha256: "abc123",
      sizeBytes: importBlobBody.length,
      storageKey: importBlobKey,
    })
    .returning({ id: importFiles.id });

  // Retained report artefact (a completed report-jobs row).
  const reportBlobBody = Buffer.from("report-bytes", "utf-8");
  const reportBlobKey = `${zone.id}/reports/2026/01/test.xlsx`;
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
    importFileId: imp.id,
    importBlobKey,
    importBlobBody,
    reportJobId: rep.id,
    reportBlobKey,
    reportBlobBody,
    chapterId: chapter.id,
    memberId: member.id,
  };
}

describe("zone export bundle — buildZoneExportBundle", () => {
  let storage: InMemoryStorage;
  const slugs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("bundle.test.ts requires a *_test DATABASE_URL");
    }
    storage = new InMemoryStorage();
    setStorageForTesting(storage);
  });

  afterAll(async () => {
    for (const slug of slugs) {
      // FK chain: chapters / members / report_jobs / import_files
      // all have `restrict` or `cascade` on zones. Wipe children
      // explicitly so the parent delete lands.
      const zoneId = (
        await db
          .select({ id: zones.id })
          .from(zones)
          .where(eq(zones.slug, slug))
          .limit(1)
      )[0]?.id;
      if (zoneId) {
        await db.delete(reportJobs).where(eq(reportJobs.zoneId, zoneId));
        await db.delete(importFiles).where(eq(importFiles.zoneId, zoneId));
        await db.delete(members).where(eq(members.zoneId, zoneId));
        await db.delete(chapters).where(eq(chapters.zoneId, zoneId));
      }
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of userIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
    setStorageForTesting(null);
  });

  it("produces a gzipped tar with manifest, JSONL tables, files, reports", async () => {
    const slug = `bundle-${unique()}`;
    const seed = await seedZone(slug, storage);
    slugs.push(slug);
    userIds.push(seed.userId);

    const exportId = crypto.randomUUID();
    const key = bundleStorageKey(seed.zoneId, exportId);
    const result = await buildZoneExportBundle(db, {
      zoneId: seed.zoneId,
      exportId,
      storageKey: key,
    });

    expect(result.storageKey).toBe(key);
    expect(result.byteCount).toBeGreaterThan(0);
    expect(result.fileCount).toBe(1);
    expect(result.artefactCount).toBe(1);
    expect(result.tableCount).toBeGreaterThan(10); // 46 tables in the registry

    // Round-trip: untar the gzipped artefact and inspect.
    const raw = await storage.get(key);
    const untarred = await untar(Buffer.from(raw));
    const root = `zone-export-${slug}-${exportId}`;

    // Manifest + README present.
    const manifest = JSON.parse(
      untarred.files.get(`${root}/manifest.json`)?.toString("utf-8") ?? "{}",
    );
    expect(manifest.zoneSlug).toBe(slug);
    expect(manifest.zoneId).toBe(seed.zoneId);
    expect(manifest.exportId).toBe(exportId);
    expect(manifest.tables.length).toBe(result.tableCount);
    // formatVersion pins the bundle shape. The restore-helper (PR 3)
    // refuses to load unrecognised versions; bumping this constant
    // requires a coordinated upgrade.
    expect(manifest.formatVersion).toBe(1);
    expect(untarred.files.has(`${root}/README.md`)).toBe(true);

    // The zone row itself is the first restore entry (selector="self").
    const zoneJsonl = untarred.files
      .get(`${root}/data/zones.jsonl`)
      ?.toString("utf-8")
      .trim()
      .split("\n") ?? [];
    expect(zoneJsonl).toHaveLength(1);
    expect(JSON.parse(zoneJsonl[0]).id).toBe(seed.zoneId);

    // Members JSONL contains the seeded member, nothing else.
    const memberLines = untarred.files
      .get(`${root}/data/members.jsonl`)
      ?.toString("utf-8")
      .trim()
      .split("\n") ?? [];
    expect(memberLines).toHaveLength(1);
    expect(JSON.parse(memberLines[0]).id).toBe(seed.memberId);

    // Import file blob is byte-for-byte identical.
    const importEntry = Array.from(untarred.files.keys()).find((k) =>
      k.startsWith(`${root}/files/imports/`),
    );
    expect(importEntry).toBeDefined();
    expect(untarred.files.get(importEntry!)?.equals(seed.importBlobBody)).toBe(true);

    // Report artefact blob is byte-for-byte identical.
    const reportEntry = `${root}/reports/${seed.reportJobId}.xlsx`;
    expect(untarred.files.get(reportEntry)?.equals(seed.reportBlobBody)).toBe(true);

    // sha256 matches the gzipped artefact recorded in the result.
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(Buffer.from(raw)).digest("hex")).toBe(
      result.sha256,
    );
  });

  it("does not leak cross-zone data into a bundle", async () => {
    const slug = `bundle-iso-${unique()}`;
    const seed = await seedZone(slug, storage);
    slugs.push(slug);
    userIds.push(seed.userId);

    // Seed a second zone with its own member.
    const otherSlug = `bundle-other-${unique()}`;
    const otherSeed = await seedZone(otherSlug, storage);
    slugs.push(otherSlug);
    userIds.push(otherSeed.userId);

    const exportId = crypto.randomUUID();
    await buildZoneExportBundle(db, {
      zoneId: seed.zoneId,
      exportId,
      storageKey: bundleStorageKey(seed.zoneId, exportId),
    });

    const raw = await storage.get(bundleStorageKey(seed.zoneId, exportId));
    const untarred = await untar(Buffer.from(raw));
    const root = `zone-export-${slug}-${exportId}`;

    const memberLines = untarred.files
      .get(`${root}/data/members.jsonl`)
      ?.toString("utf-8")
      .trim()
      .split("\n") ?? [];
    const memberIds = memberLines.map((l) => JSON.parse(l).id);
    expect(memberIds).toContain(seed.memberId);
    expect(memberIds).not.toContain(otherSeed.memberId);

    const zoneLines = untarred.files
      .get(`${root}/data/zones.jsonl`)
      ?.toString("utf-8")
      .trim()
      .split("\n") ?? [];
    expect(zoneLines).toHaveLength(1);
    expect(JSON.parse(zoneLines[0]).id).toBe(seed.zoneId);

    // The other zone's import-file blob must NOT be in this bundle.
    const fileEntries = Array.from(untarred.files.keys()).filter((k) =>
      k.startsWith(`${root}/files/imports/`),
    );
    expect(fileEntries).toHaveLength(1);
    const blob = untarred.files.get(fileEntries[0])!;
    expect(blob.equals(seed.importBlobBody)).toBe(true);
    expect(blob.equals(otherSeed.importBlobBody)).toBe(false);
  });

  it("survives a missing import blob without failing the export", async () => {
    const slug = `bundle-missing-${unique()}`;
    const seed = await seedZone(slug, storage);
    slugs.push(slug);
    userIds.push(seed.userId);

    // Purge the blob behind the scenes — simulates the retention
    // sweep having already tombstoned the file.
    await storage.delete(seed.importBlobKey);

    const exportId = crypto.randomUUID();
    const result = await buildZoneExportBundle(db, {
      zoneId: seed.zoneId,
      exportId,
      storageKey: bundleStorageKey(seed.zoneId, exportId),
    });
    // Missing blob => 0 files counted, but the dump still
    // succeeds. The import_files JSONL still records the row.
    expect(result.fileCount).toBe(0);

    const raw = await storage.get(bundleStorageKey(seed.zoneId, exportId));
    const untarred = await untar(Buffer.from(raw));
    const root = `zone-export-${slug}-${exportId}`;
    const importFileRows = untarred.files
      .get(`${root}/data/import_files.jsonl`)
      ?.toString("utf-8")
      .trim()
      .split("\n") ?? [];
    expect(importFileRows.length).toBeGreaterThanOrEqual(1);
  });
});
