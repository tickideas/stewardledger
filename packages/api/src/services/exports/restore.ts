// packages/api/src/services/exports/restore.ts
// Phase 9 §3 — restore-helper library. Imported by both the test
// suite and the thin CLI wrapper at `packages/api/scripts/restore-export.ts`.
//
// The library walks the registry's restore order, rewrites zone /
// storage-key / user-id columns to match a fresh zone identity, and
// re-uploads the bundle's blobs at the new keys. The CLI takes care
// of argv parsing + opening a `postgres` connection.
//
// The bundle generator (`./bundle.ts`) writes:
//
//   zone-export-{slug}-{exportId}/
//   ├── manifest.json
//   ├── README.md
//   ├── data/{table}.jsonl
//   ├── files/imports/{importFileId}-{name}
//   └── reports/{reportJobId}.{ext}
//
// This restore-helper:
//
//   1. Reads the manifest.
//   2. Generates (or accepts) a fresh zone id so the restored data
//      lives at a brand-new identity.
//   3. Iterates `restoreOrder()` and INSERTs every JSONL row into
//      the corresponding Drizzle table, rewriting `zone_id` to the
//      target id and (by default) nulling every `*_by_user_id`
//      column so the bundle doesn't drag a foreign deployment's
//      Better Auth user ids along with it.
//   4. Looks up the just-restored `import_files.storage_key` and
//      `report_jobs.storage_key` for each blob in the bundle and
//      writes the body there.
//
// This module does NOT run Drizzle migrations. The caller must
// point their database at a schema that has already been migrated
// to the bundle's `manifest.formatVersion`.
//
// RELEVANT FILES: ./registry.ts, ./bundle.ts, ../../scripts/restore-export.ts

import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join as pathJoin } from "node:path";
import { createGunzip } from "node:zlib";
import { eq, getTableColumns } from "drizzle-orm";
import * as tar from "tar-stream";

import * as schema from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { restoreOrder, type ZoneScopedTable } from "./registry";

/**
 * Bundle format version supported by this restore-helper. Bumping
 * this constant requires a coordinated update to `bundle.ts` and
 * any new restore-time translation between formats.
 */
export const SUPPORTED_FORMAT_VERSION = 1;

export interface ManifestTableEntry {
  name: string;
  rowCount: number;
  byteCount: number;
  sha256: string;
}
export interface ManifestFileEntry {
  path: string;
  byteCount: number;
  sha256: string;
}
export interface BundleManifest {
  formatVersion: number;
  zoneId: string;
  zoneSlug: string;
  exportId: string;
  generatedAt: string;
  tables: ManifestTableEntry[];
  files: ManifestFileEntry[];
  reports: ManifestFileEntry[];
}

export interface ObjectStorageLike {
  put(key: string, body: Uint8Array, mime?: string): Promise<void>;
}

export interface RestoreOptions {
  bundlePath: string;
  /** Database client to write into. Caller owns its lifecycle. */
  database: Database;
  /** Storage backend for `files/` and `reports/` blobs. */
  storage: ObjectStorageLike;
  /** New zone id. Defaults to a fresh UUID. */
  targetZoneId?: string;
  /** New zone slug. Defaults to the source slug + "-restored". */
  targetSlug?: string;
  /**
   * Optional source-user-id → target-user-id remap. Any
   * `*_by_user_id` column whose source value is in the map is
   * rewritten; missing entries (and the default with no map) are
   * nulled out. Rows whose NOT NULL `_user_id` cannot be remapped
   * are SKIPPED — restoring them would violate the FK against the
   * target's `user` table.
   */
  userIdMap?: Map<string, string>;
  dryRun?: boolean;
  /**
   * Optional logger (defaults to `console.log`). Tests pass a
   * collector so they can assert on the row-count summary without
   * scraping stdout.
   */
  log?: (message: string) => void;
}

export interface RestoreResult {
  targetZoneId: string;
  targetSlug: string;
  /** Per-table rows inserted + skipped (after FK / user-id checks). */
  tablesRestored: Array<{ name: string; inserted: number; skipped: number }>;
  filesRestored: number;
  reportsRestored: number;
}

export class RestoreError extends Error {
  constructor(
    readonly code:
      | "missing_manifest"
      | "format_mismatch"
      | "unknown_table"
      | "io_error",
    message: string,
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

/**
 * Restore a bundle into a clean target database. Throws on format
 * mismatch, FK violation, or missing manifest.
 */
export async function restoreZoneExportBundle(
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const workDir = await mkdtemp(pathJoin(tmpdir(), "sl-restore-"));
  try {
    log(`reading bundle ${opts.bundlePath} → ${workDir}`);
    const root = await extractBundle(opts.bundlePath, workDir);
    const bundleRoot = pathJoin(workDir, root);
    const manifestPath = pathJoin(bundleRoot, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new RestoreError(
        "missing_manifest",
        `manifest.json not found inside the bundle root ${root}`,
      );
    }
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf-8"),
    ) as BundleManifest;
    if (manifest.formatVersion !== SUPPORTED_FORMAT_VERSION) {
      throw new RestoreError(
        "format_mismatch",
        `bundle format v${manifest.formatVersion} not supported (this restore-helper handles v${SUPPORTED_FORMAT_VERSION})`,
      );
    }
    const targetZoneId = opts.targetZoneId ?? globalThis.crypto.randomUUID();
    const targetSlug = opts.targetSlug ?? `${manifest.zoneSlug}-restored`;
    log(
      `manifest OK: source zone ${manifest.zoneSlug} (${manifest.zoneId}) → target ${targetSlug} (${targetZoneId})`,
    );

    if (opts.dryRun) {
      log("dry-run: skipping inserts");
      return {
        targetZoneId,
        targetSlug,
        tablesRestored: manifest.tables.map((t) => ({
          name: t.name,
          inserted: 0,
          skipped: t.rowCount,
        })),
        filesRestored: 0,
        reportsRestored: 0,
      };
    }

    // FK-safe restore: parents first per the registry.
    const entries = restoreOrder();
    const userIdMap = opts.userIdMap ?? new Map<string, string>();
    const tablesRestored: RestoreResult["tablesRestored"] = [];
    for (const entry of entries) {
      const dataPath = pathJoin(bundleRoot, "data", `${entry.name}.jsonl`);
      if (!existsSync(dataPath)) {
        tablesRestored.push({ name: entry.name, inserted: 0, skipped: 0 });
        continue;
      }
      const { inserted, skipped } = await restoreTable({
        entry,
        dataPath,
        database: opts.database,
        sourceZoneId: manifest.zoneId,
        targetZoneId,
        targetSlug,
        userIdMap,
      });
      tablesRestored.push({ name: entry.name, inserted, skipped });
      log(
        `  ${entry.name}: inserted ${inserted}${skipped ? `, skipped ${skipped}` : ""}`,
      );
    }

    // Blobs: look up each row's just-restored storage_key by id and
    // push the body there. We can't reconstruct the original key
    // shape from the bundle filename alone (the storage_key encodes
    // a yyyy/mm partition + sha that the bundle path doesn't carry),
    // so the post-pass over the DB is the simplest correct path.
    const filesRestored = await copyImportBlobs({
      bundleRoot,
      database: opts.database,
      storage: opts.storage,
      log: (m) => log(`  ${m}`),
    });
    const reportsRestored = await copyReportBlobs({
      bundleRoot,
      database: opts.database,
      storage: opts.storage,
      log: (m) => log(`  ${m}`),
    });

    log(
      `restore complete: ${tablesRestored.reduce((a, t) => a + t.inserted, 0)} rows, ${filesRestored} files, ${reportsRestored} reports`,
    );
    return {
      targetZoneId,
      targetSlug,
      tablesRestored,
      filesRestored,
      reportsRestored,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ─── tar handling ────────────────────────────────────────────────────

/**
 * Extract a gzipped tar bundle into `workDir`. Returns the root
 * directory name (`zone-export-{slug}-{exportId}`) so the caller
 * can build paths into it.
 */
async function extractBundle(
  bundlePath: string,
  workDir: string,
): Promise<string> {
  const extract = tar.extract();
  const roots = new Set<string>();
  const pendingWrites: Promise<void>[] = [];
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const buf = Buffer.concat(chunks);
      const dest = pathJoin(workDir, header.name);
      const firstSlash = header.name.indexOf("/");
      if (firstSlash > 0) roots.add(header.name.slice(0, firstSlash));
      else roots.add(header.name);
      pendingWrites.push(
        (async () => {
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, buf);
        })(),
      );
      next();
    });
    stream.on("error", (err) => {
      throw err;
    });
    stream.resume();
  });
  await new Promise<void>((res, rej) => {
    createReadStream(bundlePath)
      .on("error", rej)
      .pipe(createGunzip())
      .on("error", rej)
      .pipe(extract)
      .on("finish", () => res())
      .on("error", rej);
  });
  await Promise.all(pendingWrites);
  if (roots.size !== 1) {
    throw new RestoreError(
      "io_error",
      `expected exactly one root directory in the bundle; found ${roots.size}: ${[...roots].join(", ")}`,
    );
  }
  return [...roots][0];
}

// ─── per-table restore ───────────────────────────────────────────────

interface RestoreTableArgs {
  entry: ZoneScopedTable;
  dataPath: string;
  database: Database;
  sourceZoneId: string;
  targetZoneId: string;
  targetSlug: string;
  userIdMap: Map<string, string>;
}

/**
 * Stream a JSONL table into the database, one row at a time.
 *
 * Per-row translation:
 *   - `zoneId`         → `targetZoneId`
 *   - `zones.id`       → `targetZoneId` (the self-row)
 *   - `zones.slug`     → `targetSlug`
 *   - `storage_key`    → rewritten to new zone prefix
 *   - `*_by_user_id`   → mapped via `userIdMap` or nulled
 *   - ISO date strings → `Date` objects (for timestamp columns)
 *   - Rows whose NOT NULL `_user_id` cannot be remapped: SKIPPED.
 *
 * JSONL keys are PROPERTY names (camelCase) because the bundle
 * generator wrote `stringifyJsonlRow(row)` directly on the Drizzle
 * row object.
 */
async function restoreTable(args: RestoreTableArgs): Promise<{
  inserted: number;
  skipped: number;
}> {
  const { entry, dataPath, database } = args;
  const cols = getTableColumns(entry.table);

  // Pre-walk the column metadata so each row pays the cheapest
  // possible translation cost. The bundle generator can dump
  // millions of rows; per-row reflection would dominate runtime.
  const userIdProps: Array<{ prop: string; notNull: boolean }> = [];
  const storageKeyProps: string[] = [];
  const dateProps: string[] = [];
  let zoneIdProp: string | null = null;
  let zoneSelfPkProp: string | null = null;
  let slugProp: string | null = null;
  let nameProp: string | null = null;
  for (const [prop, col] of Object.entries(cols)) {
    const c = col as {
      name: string;
      notNull: boolean;
      columnType?: string;
      dataType?: string;
    };
    if (c.name === "zone_id") zoneIdProp = prop;
    if (entry.selector === "self" && c.name === "id") zoneSelfPkProp = prop;
    if (entry.selector === "self" && c.name === "slug") slugProp = prop;
    if (entry.selector === "self" && c.name === "name") nameProp = prop;
    if (c.name === "storage_key") storageKeyProps.push(prop);
    if (/_user_id$/.test(c.name) || c.name === "user_id") {
      userIdProps.push({ prop, notNull: c.notNull });
    }
    if (
      c.columnType === "PgTimestamp" ||
      c.columnType === "PgTimestampString"
    ) {
      dateProps.push(prop);
    }
  }

  let inserted = 0;
  let skipped = 0;
  let buffer = "";

  const flushLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    const row = JSON.parse(line) as Record<string, unknown>;

    // User-id remap. Skip the row if a NOT NULL user FK has no
    // map entry — restoring it would violate the FK.
    let skip = false;
    for (const { prop, notNull } of userIdProps) {
      const original = row[prop] as string | null | undefined;
      if (original == null) continue;
      const mapped = args.userIdMap.get(original) ?? null;
      if (mapped === null && notNull) {
        skip = true;
        break;
      }
      row[prop] = mapped;
    }
    if (skip) {
      skipped++;
      return;
    }

    // Zone identity rewrite. `zones.name` carries a unique
    // `lower(name)` index — a same-DB restore of a previously-
    // exported zone would collide on the original name, so we
    // append a short suffix derived from the target slug to keep
    // the row insertable. Restoring into a clean target database
    // (the production flow) wouldn't strictly need this, but the
    // suffix is a no-op there and helps human operators eyeball
    // which row came from the restore.
    if (entry.selector === "self") {
      if (zoneSelfPkProp) row[zoneSelfPkProp] = args.targetZoneId;
      if (slugProp) row[slugProp] = args.targetSlug;
      if (nameProp && typeof row[nameProp] === "string") {
        row[nameProp] = `${row[nameProp]} (restored ${args.targetZoneId.slice(0, 8)})`;
      }
    } else if (zoneIdProp) {
      row[zoneIdProp] = args.targetZoneId;
    }

    // Storage-key prefix rewrite (import_files + report_jobs).
    for (const prop of storageKeyProps) {
      const original = row[prop] as string | null | undefined;
      if (typeof original === "string" && original.length > 0) {
        row[prop] = rewriteStorageKey(
          original,
          args.sourceZoneId,
          args.targetZoneId,
        );
      }
    }

    // ISO string → Date for PgTimestamp columns.
    for (const prop of dateProps) {
      const v = row[prop];
      if (typeof v !== "string") continue;
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) row[prop] = d;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (database as any).insert(entry.table).values(row);
    inserted++;
  };

  const stream = createReadStream(dataPath, { encoding: "utf-8" });
  for await (const chunk of stream) {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      await flushLine(line);
      idx = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) await flushLine(buffer);

  return { inserted, skipped };
}

/**
 * Rewrite an object-storage key from the source zone's prefix to
 * the target's. Both backends shape keys as `{zoneId}/...`. A key
 * that doesn't start with the source prefix is left untouched —
 * better to round-trip an unrecognised key than silently corrupt
 * it.
 */
function rewriteStorageKey(
  original: string,
  sourceZoneId: string,
  targetZoneId: string,
): string {
  const prefix = `${sourceZoneId}/`;
  if (original.startsWith(prefix)) {
    return `${targetZoneId}/${original.slice(prefix.length)}`;
  }
  return original;
}

// ─── blob copy ───────────────────────────────────────────────────────

interface CopyArgs {
  bundleRoot: string;
  database: Database;
  storage: ObjectStorageLike;
  log: (m: string) => void;
}

/**
 * Copy `files/imports/{importFileId}-*` from the bundle into
 * storage at the just-restored `import_files.storage_key`.
 */
async function copyImportBlobs(args: CopyArgs): Promise<number> {
  const filesDir = pathJoin(args.bundleRoot, "files", "imports");
  if (!existsSync(filesDir)) return 0;
  let copied = 0;
  const entries = await readdir(filesDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const idMatch = /^([0-9a-f-]{36})/i.exec(ent.name);
    if (!idMatch) {
      args.log(`skip blob (no id in filename): ${ent.name}`);
      continue;
    }
    const importFileId = idMatch[1];
    const [row] = await args.database
      .select({ storageKey: schema.importFiles.storageKey })
      .from(schema.importFiles)
      .where(eq(schema.importFiles.id, importFileId))
      .limit(1);
    if (!row?.storageKey) {
      args.log(`skip blob (no row): ${ent.name}`);
      continue;
    }
    const body = await readFile(pathJoin(filesDir, ent.name));
    await args.storage.put(row.storageKey, body);
    copied++;
  }
  return copied;
}

/**
 * Copy `reports/{reportJobId}.{ext}` from the bundle into storage
 * at the just-restored `report_jobs.storage_key`.
 */
async function copyReportBlobs(args: CopyArgs): Promise<number> {
  const reportsDir = pathJoin(args.bundleRoot, "reports");
  if (!existsSync(reportsDir)) return 0;
  let copied = 0;
  const entries = await readdir(reportsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const idMatch = /^([0-9a-f-]{36})\./i.exec(ent.name);
    if (!idMatch) {
      args.log(`skip report (no id): ${ent.name}`);
      continue;
    }
    const reportJobId = idMatch[1];
    const [row] = await args.database
      .select({ storageKey: schema.reportJobs.storageKey })
      .from(schema.reportJobs)
      .where(eq(schema.reportJobs.id, reportJobId))
      .limit(1);
    if (!row?.storageKey) {
      args.log(`skip report (no row): ${ent.name}`);
      continue;
    }
    const body = await readFile(pathJoin(reportsDir, ent.name));
    await args.storage.put(row.storageKey, body);
    copied++;
  }
  return copied;
}
