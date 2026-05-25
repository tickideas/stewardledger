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

import {
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join as pathJoin,
  resolve as pathResolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as tar from "tar-stream";

import * as schema from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { restoreOrder, type ZoneScopedTable } from "./registry";

/**
 * Restore rows in batches of this size. A drizzle multi-row insert
 * is dramatically cheaper than N single-row inserts (one round-trip
 * per batch vs. one per row) and keeps each table's restore as a
 * single transaction so a mid-table failure rolls back cleanly.
 * 500 keeps the parameter count comfortably under PG's 65k limit
 * even for the widest tables (`contributions` has ~30 columns).
 */
const BATCH_SIZE = 500;

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
      | "target_not_empty"
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

    // Empty-target precondition. `tasks/zone-export-bundle.md` is
    // explicit: the restore helper requires an empty target.
    // Detecting the collision up front gives the operator a clean
    // error instead of a partial restore + 23505 mid-table. The
    // check is skipped in dry-run because dry-run doesn't insert.
    if (!opts.dryRun) {
      const [existing] = await opts.database
        .select({ id: schema.zones.id })
        .from(schema.zones)
        .where(eq(schema.zones.id, targetZoneId))
        .limit(1);
      if (existing) {
        throw new RestoreError(
          "target_not_empty",
          `zone ${targetZoneId} already exists in the target database; restore requires an empty target (pass a fresh --target-zone-id or drop the existing zone first)`,
        );
      }
    }

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

    // FK-safe restore: parents first per the registry. Cross-check
    // every walked table against the manifest so a corrupted bundle
    // (manifest declares the table but the JSONL is missing) fails
    // loudly instead of silently restoring zero rows. The bundle
    // generator writes a JSONL entry for every registry table even
    // when empty, so a manifest table with `rowCount > 0` and no
    // file on disk is always a torn bundle.
    const entries = restoreOrder();
    const userIdMap = opts.userIdMap ?? new Map<string, string>();
    const manifestByName = new Map(
      manifest.tables.map((t) => [t.name, t]),
    );
    const tablesRestored: RestoreResult["tablesRestored"] = [];
    for (const entry of entries) {
      const dataPath = pathJoin(bundleRoot, "data", `${entry.name}.jsonl`);
      const manifestEntry = manifestByName.get(entry.name);
      if (!existsSync(dataPath)) {
        // A manifest entry that promises rows but has no file on
        // disk means the bundle was cut short or tampered with.
        if (manifestEntry && manifestEntry.rowCount > 0) {
          throw new RestoreError(
            "io_error",
            `bundle is missing data/${entry.name}.jsonl but the manifest declares ${manifestEntry.rowCount} row(s); refusing to restore an incomplete bundle`,
          );
        }
        // No manifest entry (table didn't exist when bundle was
        // built; older format) or zero declared rows — record the
        // empty restore and move on.
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
        log,
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
 *
 * Two security + memory invariants:
 *
 *   1. Every entry's destination is resolved against `workDir` and
 *      rejected if it escapes — a malicious bundle with
 *      `header.name = "../../etc/cron.d/payload"` or an absolute
 *      path cannot write outside the temp directory.
 *   2. Each entry is piped directly to disk via
 *      `pipeline(stream, createWriteStream(dest))` so the JS heap
 *      never holds more than one stream buffer. A bundle whose
 *      largest entry is multi-GB (audit_events.jsonl can approach
 *      the 5M-row per-table cap) restores without OOM.
 *
 * Errors on either the gunzip or the per-entry pipeline reject the
 * outer promise so callers see a single rejected await rather than
 * an `uncaughtException`.
 */
async function extractBundle(
  bundlePath: string,
  workDir: string,
): Promise<string> {
  // Pre-compute the canonical root + the `<root>/` boundary so
  // every entry can be checked with one cheap `startsWith` call.
  const safeRoot = pathResolve(workDir);
  const rootBoundary = safeRoot.endsWith(sep) ? safeRoot : safeRoot + sep;

  const extract = tar.extract();
  const roots = new Set<string>();

  return await new Promise<string>((resolve, reject) => {
    let pendingEntries = 0;
    let inputFinished = false;
    let settled = false;
    const settle = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value as string);
    };
    const finalize = () => {
      if (settled || !inputFinished || pendingEntries > 0) return;
      if (roots.size !== 1) {
        settle(
          new RestoreError(
            "io_error",
            `expected exactly one root directory in the bundle; found ${roots.size}: ${[...roots].join(", ")}`,
          ),
        );
        return;
      }
      settle(null, [...roots][0]);
    };

    extract.on("entry", (header, stream, next) => {
      // Path-traversal guard: resolve the requested destination,
      // reject anything that escapes the temp work directory or
      // uses absolute paths.
      const dest = pathResolve(workDir, header.name);
      if (dest !== safeRoot && !dest.startsWith(rootBoundary)) {
        stream.resume();
        next();
        settle(
          new RestoreError(
            "io_error",
            `bundle entry "${header.name}" resolves outside the extraction directory; refusing to write`,
          ),
        );
        return;
      }

      const firstSlash = header.name.indexOf("/");
      roots.add(
        firstSlash > 0 ? header.name.slice(0, firstSlash) : header.name,
      );

      // Directory entries carry no data; ensure the dir exists and
      // move on without a pipeline.
      if (header.type === "directory") {
        stream.resume();
        mkdir(dest, { recursive: true })
          .then(() => next())
          .catch((err: Error) => {
            next();
            settle(err);
          });
        return;
      }

      pendingEntries++;
      mkdir(dirname(dest), { recursive: true })
        .then(() => pipeline(stream, createWriteStream(dest)))
        .then(() => {
          pendingEntries--;
          next();
          finalize();
        })
        .catch((err: Error) => {
          pendingEntries--;
          stream.resume();
          next();
          settle(err);
        });
    });
    extract.on("finish", () => {
      inputFinished = true;
      finalize();
    });
    extract.on("error", (err) => settle(err));

    const src = createReadStream(bundlePath);
    src.on("error", (err) => settle(err));
    const gunzip = createGunzip();
    gunzip.on("error", (err) => settle(err));
    src.pipe(gunzip).pipe(extract);
  });
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
 * Stream a JSONL table into the database in `BATCH_SIZE`-row
 * batches inside a single transaction. A mid-table failure rolls
 * the whole table back rather than leaving a half-populated
 * target.
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
async function restoreTable(args: RestoreTableArgs & { log: (m: string) => void }): Promise<{
  inserted: number;
  skipped: number;
}> {
  const { entry, dataPath, database, log } = args;
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

  return await database.transaction(async (tx) => {
    let inserted = 0;
    let skipped = 0;
    let buffer = "";
    let batch: Array<Record<string, unknown>> = [];

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      await insertRows(tx, entry.table, batch);
      inserted += batch.length;
      batch = [];
    };

    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      const row = JSON.parse(line) as Record<string, unknown>;

      // User-id remap. Skip the row if a NOT NULL user FK has no
      // map entry — restoring it would violate the FK.
      for (const { prop, notNull } of userIdProps) {
        const original = row[prop] as string | null | undefined;
        if (original == null) continue;
        const mapped = args.userIdMap.get(original) ?? null;
        if (mapped === null && notNull) {
          skipped++;
          return;
        }
        row[prop] = mapped;
      }

      // Zone identity rewrite. `zones.name` carries a unique
      // `lower(name)` index — a same-DB restore of a previously-
      // exported zone would collide on the original name, so we
      // append a short suffix derived from the target zone id to
      // keep the row insertable. Restoring into a clean target
      // database (the production flow) wouldn't strictly need this,
      // but the suffix is a no-op there and helps human operators
      // eyeball which row came from the restore.
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
            (m) => log(`  ${entry.name}: ${m}`),
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

      batch.push(row);
    };

    const stream = createReadStream(dataPath, { encoding: "utf-8" });
    for await (const chunk of stream) {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        consumeLine(line);
        idx = buffer.indexOf("\n");
      }
      if (batch.length >= BATCH_SIZE) await flushBatch();
    }
    if (buffer.length > 0) consumeLine(buffer);
    await flushBatch();

    return { inserted, skipped };
  });
}

/**
 * Single point of contact between the restore loop and Drizzle's
 * generic insert. Centralises the `as any` cast (the table
 * reference is dynamic) so the rest of the file stays type-safe.
 */
async function insertRows(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  table: PgTable,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tx as any).insert(table).values(rows);
}

/**
 * Rewrite an object-storage key from the source zone's prefix to
 * the target's. Both backends shape keys as `{zoneId}/...`. A key
 * that doesn't start with the source prefix is logged + returned
 * unchanged — better to round-trip an unrecognised key (the row
 * is still useful for audit) than silently corrupt it, but the
 * warning surfaces any future drift in the storage-key contract.
 */
function rewriteStorageKey(
  original: string,
  sourceZoneId: string,
  targetZoneId: string,
  warn?: (m: string) => void,
): string {
  const prefix = `${sourceZoneId}/`;
  if (original.startsWith(prefix)) {
    return `${targetZoneId}/${original.slice(prefix.length)}`;
  }
  warn?.(
    `storage_key "${original}" does not start with the source zone prefix; leaving unchanged (blob may not resolve in the target deployment)`,
  );
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
 * storage at the just-restored `import_files.storage_key`. Looks
 * up every storage_key in a single `IN (...)` query so a zone
 * with thousands of import files doesn't pay N DB round-trips.
 */
async function copyImportBlobs(args: CopyArgs): Promise<number> {
  return await copyBlobsByPkLookup({
    dir: pathJoin(args.bundleRoot, "files", "imports"),
    filenamePattern: /^([0-9a-f-]{36})/i,
    fetchKeys: async (ids) =>
      await args.database
        .select({
          id: schema.importFiles.id,
          storageKey: schema.importFiles.storageKey,
        })
        .from(schema.importFiles)
        .where(inArray(schema.importFiles.id, ids)),
    storage: args.storage,
    log: args.log,
    kind: "blob",
  });
}

/**
 * Copy `reports/{reportJobId}.{ext}` from the bundle into storage
 * at the just-restored `report_jobs.storage_key`. Batched lookup
 * as above.
 */
async function copyReportBlobs(args: CopyArgs): Promise<number> {
  return await copyBlobsByPkLookup({
    dir: pathJoin(args.bundleRoot, "reports"),
    filenamePattern: /^([0-9a-f-]{36})\./i,
    fetchKeys: async (ids) =>
      await args.database
        .select({
          id: schema.reportJobs.id,
          storageKey: schema.reportJobs.storageKey,
        })
        .from(schema.reportJobs)
        .where(inArray(schema.reportJobs.id, ids)),
    storage: args.storage,
    log: args.log,
    kind: "report",
  });
}

/**
 * Shared body for the two blob copy passes. Reads the bundle
 * directory, pulls every PK from the filenames, fetches their
 * storage_keys in a single batched query, and copies each blob
 * to the storage backend at the new key.
 */
async function copyBlobsByPkLookup(args: {
  dir: string;
  filenamePattern: RegExp;
  fetchKeys: (
    ids: string[],
  ) => Promise<Array<{ id: string; storageKey: string | null }>>;
  storage: ObjectStorageLike;
  log: (m: string) => void;
  kind: "blob" | "report";
}): Promise<number> {
  if (!existsSync(args.dir)) return 0;
  const entries = await readdir(args.dir, { withFileTypes: true });
  const files: Array<{ name: string; id: string }> = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const match = args.filenamePattern.exec(ent.name);
    if (!match) {
      args.log(`skip ${args.kind} (no id in filename): ${ent.name}`);
      continue;
    }
    files.push({ name: ent.name, id: match[1] });
  }
  if (files.length === 0) return 0;

  const ids = files.map((f) => f.id);
  const rows = await args.fetchKeys(ids);
  const keyById = new Map(rows.map((r) => [r.id, r.storageKey]));

  let copied = 0;
  for (const file of files) {
    const storageKey = keyById.get(file.id);
    if (!storageKey) {
      args.log(`skip ${args.kind} (no row): ${file.name}`);
      continue;
    }
    const body = await readFile(pathJoin(args.dir, file.name));
    await args.storage.put(storageKey, body);
    copied++;
  }
  return copied;
}
