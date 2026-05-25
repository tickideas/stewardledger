// packages/api/src/services/exports/bundle.ts
// Phase 9 §3 — streamed tar.gz writer for a per-zone export bundle.
//
// Reads every zone-scoped table (via the registry) inside a single
// READ ONLY REPEATABLE READ transaction so the dump is internally
// consistent even if writes land mid-export. Each table is paginated
// in 1k-row chunks via `order by id` keyset — the cheapest stable
// ordering on a UUID PK that doesn't depend on a separate index.
//
// Memory bound:
//
//   - Each table's JSONL is written incrementally to a temp file
//     as it's paginated; only one 1k-row page is held in JS at a
//     time.
//   - The gzipped tar is also streamed to a temp file; the final
//     `storage().put` reads it back as one Buffer to satisfy the
//     v1 storage interface. That's the only memory ceiling that
//     scales with bundle size — bounded at one-digit GB per the
//     deployment doc; a true streaming multipart is a Phase 11
//     problem (`tasks/zone-export-bundle.md` non-goals).
//   - We also enforce a per-table hard ceiling of
//     {@link MAX_ROWS_PER_TABLE} so a runaway zone fails loudly
//     with a `failed` row instead of OOM-killing the worker.
//
// Layout written into the tar (see `tasks/zone-export-bundle.md`):
//
//   zone-export-{slug}-{exportId}/
//   ├── manifest.json    — zone slug, generated_at, table list, sha256s
//   ├── README.md        — restore instructions
//   ├── data/{table}.jsonl
//   ├── files/imports/{key}   — raw bytes for every import_files row
//   └── reports/{key}    — retained report artefacts (completed jobs)
//
// RELEVANT FILES: ./registry.ts, ./jobs.ts, ../storage.ts

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { asc, eq, gt, sql } from "drizzle-orm";
import {
  importFiles,
  reportJobs,
  zones,
  type ImportFile,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import * as tar from "tar-stream";
import { log } from "../../logger";
import { storage, StorageNotFoundError } from "../storage";
import {
  exportOrder,
  ZONE_SCOPED_TABLES,
  type ZoneScopedTable,
} from "./registry";

const PAGE_SIZE = 1_000;
const BUNDLE_FORMAT_VERSION = 1;
/**
 * Hard ceiling per table. 5M rows × ~500B JSONL ≈ 2.5 GB on disk,
 * which is roughly the boundary where the deployment doc tells
 * operators to expect issues. Hitting this almost certainly means
 * the zone has unfiltered audit_events or runaway imports; failing
 * the export points the operator at the retention policy instead
 * of OOM-killing the worker.
 */
const MAX_ROWS_PER_TABLE = 5_000_000;

export class ExportBundleError extends Error {
  constructor(
    readonly code: "table_too_large" | "zone_not_found",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Boot-time invariant: every registry entry the dump loop walks
 * must expose `id` for keyset pagination, and every non-self
 * entry must also expose `zoneId` for the WHERE clause. Without
 * this guard, a schema author who renames a PK to `eventId` would
 * slip past TypeScript and crash at runtime mid-export.
 *
 * Throws at module load so the error surfaces in tests + dev
 * startup, not during a production export.
 */
function assertRegistryColumnsAtBoot(): void {
  for (const entry of ZONE_SCOPED_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = entry.table as any;
    if (typeof table.id === "undefined") {
      throw new Error(
        `zone export registry: table "${entry.name}" has no \`id\` column; the dump loop's keyset pagination requires one`,
      );
    }
    if (entry.selector !== "self" && typeof table.zoneId === "undefined") {
      throw new Error(
        `zone export registry: table "${entry.name}" has selector!="self" but no \`zoneId\` column`,
      );
    }
  }
}
assertRegistryColumnsAtBoot();

export interface BundleResult {
  /** Object-storage key the bundle was written to. */
  storageKey: string;
  /** Total compressed bundle size in bytes. */
  byteCount: number;
  /** Count of JSONL tables included in the bundle. */
  tableCount: number;
  /** Count of uploaded import files copied into `files/`. */
  fileCount: number;
  /** Count of retained report artefacts copied into `reports/`. */
  artefactCount: number;
  /**
   * sha256 hex digest of the gzipped tar. Persisted on the
   * `zone_exports` row (`sha256` column) + the `zone.export.
   * completed` audit `after` payload. NOT in the manifest — the
   * bundle-level digest would be self-referential.
   */
  sha256: string;
}

export interface BundleInput {
  zoneId: string;
  exportId: string;
  storageKey: string;
}

interface TableManifestEntry {
  name: string;
  rowCount: number;
  byteCount: number;
  sha256: string;
}

interface FileManifestEntry {
  path: string;
  byteCount: number;
  sha256: string;
}

interface BundleManifest {
  formatVersion: number;
  zoneId: string;
  zoneSlug: string;
  exportId: string;
  generatedAt: string;
  tables: TableManifestEntry[];
  files: FileManifestEntry[];
  reports: FileManifestEntry[];
}

/**
 * Build a single zone export bundle: stream every registry table
 * as JSONL, copy every import file blob, copy every retained
 * report artefact, write a manifest, gzip, upload. Returns the
 * counts the caller persists onto `zone_exports`.
 *
 * The bundle does NOT contain the global `user` table or any
 * Better Auth row — see `registry.ts` header for the restore-
 * helper's strategy for `*_by_user_id` FKs.
 */
export async function buildZoneExportBundle(
  database: Database,
  input: BundleInput,
): Promise<BundleResult> {
  const workDir = await mkdtemp(pathJoin(tmpdir(), "sl-export-"));
  const gzippedPath = pathJoin(workDir, `${input.exportId}.tar.gz`);

  // Wire pack → gzip → temp file as a single pipeline. The gzip
  // stream gives us proper backpressure: if the disk lags, the
  // tar entry writers block instead of buffering in JS heap.
  const pack = tar.pack();
  const gzip = createGzip();
  const gzippedWrite = createWriteStream(gzippedPath);
  const pipelineDone = pipeline(pack, gzip, gzippedWrite);

  try {
    const generatedAt = new Date().toISOString();
    const tableEntries: TableManifestEntry[] = [];
    const fileEntries: FileManifestEntry[] = [];
    const reportEntries: FileManifestEntry[] = [];

    // The export reads every table in a single transaction with
    // REPEATABLE READ + READ ONLY + DEFERRABLE so concurrent writes
    // can't tear the dump. DEFERRABLE means Postgres waits for a
    // serialisable snapshot — zero risk of a serialisation
    // anomaly, slight startup delay under contention. Cheap insurance
    // for a once-a-day owner-triggered operation.
    let zoneSlug = input.zoneId;
    await database.transaction(
      async (tx) => {
        const [zoneRow] = await tx
          .select({ slug: zones.slug })
          .from(zones)
          .where(eq(zones.id, input.zoneId))
          .limit(1);
        if (!zoneRow) {
          throw new ExportBundleError(
            "zone_not_found",
            `zone ${input.zoneId} not found at export time`,
          );
        }
        zoneSlug = zoneRow.slug;

        const root = `zone-export-${zoneSlug}-${input.exportId}`;

        for (const entry of exportOrder()) {
          const dumped = await dumpTableToFile(
            tx,
            entry,
            input.zoneId,
            workDir,
          );
          try {
            await addFileToTar(
              pack,
              `${root}/data/${entry.name}.jsonl`,
              dumped.path,
              dumped.byteCount,
            );
            tableEntries.push({
              name: entry.name,
              rowCount: dumped.rowCount,
              byteCount: dumped.byteCount,
              sha256: dumped.sha256,
            });
          } finally {
            await rm(dumped.path, { force: true });
          }
        }

        // Import files: every row in `import_files` references a blob
        // in object storage. Copy each blob into `files/imports/` so a
        // restore can re-upload them. A missing blob (purged by the
        // retention sweep) is logged but doesn't fail the export —
        // the JSONL still records the metadata.
        const filesRows = await tx
          .select({
            id: importFiles.id,
            storageKey: importFiles.storageKey,
            originalFileName: importFiles.originalFileName,
          })
          .from(importFiles)
          .where(eq(importFiles.zoneId, input.zoneId));
        for (const row of filesRows) {
          const copied = await copyBlobIntoTar({
            pack,
            tarPath: `${root}/files/imports/${row.id}-${sanitiseName(row.originalFileName)}`,
            sourceKey: row.storageKey,
            label: `import_file ${row.id}`,
          });
          if (copied) fileEntries.push(copied);
        }

        // Report artefacts: every `report_jobs` row with a
        // non-null `storage_key` (i.e. completed + not yet expired)
        // has a blob to bundle.
        const reportRows = await tx
          .select({
            id: reportJobs.id,
            storageKey: reportJobs.storageKey,
            format: reportJobs.format,
          })
          .from(reportJobs)
          .where(
            sql`${reportJobs.zoneId} = ${input.zoneId} and ${reportJobs.storageKey} is not null`,
          );
        for (const row of reportRows) {
          if (!row.storageKey) continue;
          const ext = row.format.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
          const copied = await copyBlobIntoTar({
            pack,
            tarPath: `${root}/reports/${row.id}.${ext}`,
            sourceKey: row.storageKey,
            label: `report_job ${row.id}`,
          });
          if (copied) reportEntries.push(copied);
        }
      },
      {
        isolationLevel: "repeatable read",
        accessMode: "read only",
        deferrable: true,
      },
    );

    const root = `zone-export-${zoneSlug}-${input.exportId}`;

    // Manifest and README are written last so they can list every
    // payload entry's sha256. Both are tiny so they stay in-memory.
    const manifest: BundleManifest = {
      formatVersion: BUNDLE_FORMAT_VERSION,
      zoneId: input.zoneId,
      zoneSlug,
      exportId: input.exportId,
      generatedAt,
      tables: tableEntries,
      files: fileEntries,
      reports: reportEntries,
    };
    await addBufferToTar(
      pack,
      `${root}/manifest.json`,
      Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"),
    );
    await addBufferToTar(
      pack,
      `${root}/README.md`,
      Buffer.from(readme(manifest), "utf-8"),
    );

    pack.finalize();
    await pipelineDone;

    // Read the temp file back as one Buffer for `storage().put`. The
    // v1 storage interface takes `Uint8Array`; a streaming
    // multipart-upload variant lands with the S3 backend in Phase
    // 11. Until then this is the memory ceiling of the bundle
    // operation.
    const gzipped = await readFile(gzippedPath);
    await storage().put(input.storageKey, gzipped, "application/gzip");

    const sha = sha256Hex(gzipped);
    log.info(
      {
        exportId: input.exportId,
        zoneId: input.zoneId,
        tableCount: tableEntries.length,
        fileCount: fileEntries.length,
        artefactCount: reportEntries.length,
        byteCount: gzipped.length,
      },
      "zone export: bundle built",
    );
    return {
      storageKey: input.storageKey,
      byteCount: gzipped.length,
      tableCount: tableEntries.length,
      fileCount: fileEntries.length,
      artefactCount: reportEntries.length,
      sha256: sha,
    };
  } catch (err) {
    // Tear down the in-flight pipeline so the temp-write stream
    // releases the FD. `pack.destroy()` propagates an error through
    // the gzip + write stages; we ignore the rejected pipeline
    // promise because the original `err` is what the caller needs.
    pack.destroy();
    await pipelineDone.catch(() => undefined);
    throw err;
  } finally {
    // Always remove the work directory — the gzipped artefact lives
    // in object storage now (or never made it past the catch).
    await rm(workDir, { recursive: true, force: true });
  }
}

interface DumpedTable {
  path: string;
  rowCount: number;
  byteCount: number;
  sha256: string;
}

/**
 * Stream a table to a temp file as JSONL. Pagination uses keyset
 * on `id` (UUIDs sort lexicographically; stable inside the txn's
 * snapshot). Computes sha256 incrementally so the manifest can
 * record it without re-reading the file. Aborts with
 * `table_too_large` if the table exceeds {@link MAX_ROWS_PER_TABLE}.
 */
async function dumpTableToFile(
  // Drizzle's tx type is verbose; the runtime contract is just
  // `select().from(table)`, which both `Database` and the
  // transaction type honour.
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  entry: ZoneScopedTable,
  zoneId: string,
  workDir: string,
): Promise<DumpedTable> {
  const idColumn = readIdColumn(entry);
  // The registry's selector tells us whether to filter on
  // `zone_id = $zoneId` (the common case) or `id = $zoneId` (the
  // `zones` self-row). The boot-time registry assertion guarantees
  // these column accesses are safe at runtime.
  const isSelf = entry.selector === "self";
  const zoneCol = isSelf ? null : readZoneColumn(entry);

  const filePath = pathJoin(workDir, `${entry.name}.jsonl`);
  const writer = createWriteStream(filePath);
  const hash = createHash("sha256");
  let byteCount = 0;
  let rowCount = 0;
  let cursor: string | null = null;

  const writeChunk = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      hash.update(chunk);
      byteCount += chunk.length;
      if (writer.write(chunk)) resolve();
      else writer.once("drain", resolve);
      writer.once("error", reject);
    });

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const whereParts = [] as unknown[];
      if (isSelf) {
        whereParts.push(eq(idColumn as never, zoneId));
      } else {
        whereParts.push(eq(zoneCol as never, zoneId));
      }
      if (cursor !== null) {
        whereParts.push(gt(idColumn as never, cursor));
      }
      const pageBuilder = tx
        .select()
        .from(entry.table)
        .orderBy(asc(idColumn as never))
        .limit(PAGE_SIZE);
      const where = whereParts.reduce<unknown>(
        (acc, cond) =>
          acc === undefined ? cond : sql`${acc as never} and ${cond as never}`,
        undefined,
      );
      const rows = await (pageBuilder as unknown as {
        where(c: unknown): Promise<Array<Record<string, unknown>>>;
      }).where(where);
      if (rows.length === 0) break;

      // Build one page-sized buffer, write to disk, free the JS
      // strings. JS heap holds at most one page at a time.
      const lines: string[] = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        lines[i] = stringifyJsonlRow(rows[i] as Record<string, unknown>);
      }
      await writeChunk(Buffer.from(lines.join("\n") + "\n", "utf-8"));
      rowCount += rows.length;
      if (rowCount > MAX_ROWS_PER_TABLE) {
        throw new ExportBundleError(
          "table_too_large",
          `table ${entry.name} exceeds ${MAX_ROWS_PER_TABLE} rows; tighten the retention policy or contact support`,
          { table: entry.name, rowCountSeen: rowCount },
        );
      }
      if (rows.length < PAGE_SIZE) break;
      const last = rows[rows.length - 1] as { id?: string };
      if (!last.id) break;
      cursor = last.id;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  return {
    path: filePath,
    rowCount,
    byteCount,
    sha256: hash.digest("hex"),
  };
}

/**
 * Pull the `id` column off a registry entry. Centralised so the
 * `as never` cast lives in one place — the boot-time registry
 * assertion guarantees every table actually has an `id` column.
 */
function readIdColumn(entry: ZoneScopedTable): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (entry.table as any).id;
}

/**
 * Pull the `zoneId` column off a registry entry. Only called when
 * `entry.selector !== "self"`; the registry assertion guarantees
 * the column exists in that branch.
 */
function readZoneColumn(entry: ZoneScopedTable): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (entry.table as any).zoneId;
}

/**
 * Convert a Drizzle row into a single JSONL line.
 *
 * - `Date` → ISO 8601 string (matches the API serialisation).
 * - `Buffer` / `Uint8Array` shouldn't appear in zone-scoped rows
 *   (blobs are out-of-band via `storage_key`), but if one slips
 *   through we base64 it so the bundle remains valid JSON.
 */
function stringifyJsonlRow(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) => {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) {
      return { __binary_base64__: Buffer.from(value).toString("base64") };
    }
    return value;
  });
}

/**
 * Push a small in-memory entry into the tar archive (manifest,
 * README). The `pack.entry` callback fires when the entry is fully
 * consumed; we adapt it to a Promise so the caller can `await`
 * between entries instead of juggling streams.
 */
function addBufferToTar(
  pack: tar.Pack,
  name: string,
  body: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    pack.entry({ name, size: body.length }, body, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/**
 * Push a temp-file entry into the tar archive. Pipes the file
 * stream into the writable returned by `pack.entry({size})`; the
 * tar-stream end-of-entry callback is wired so backpressure
 * propagates back to the file read.
 */
async function addFileToTar(
  pack: tar.Pack,
  name: string,
  filePath: string,
  size: number,
): Promise<void> {
  await pipeline(createReadStream(filePath), pack.entry({ name, size }));
}

interface CopyArgs {
  pack: tar.Pack;
  tarPath: string;
  sourceKey: string;
  label: string;
}

/**
 * Copy a blob from object storage into the tar. Returns null when
 * the source blob is genuinely missing (e.g. the retention sweep
 * already tombstoned it) so the JSONL still records the metadata
 * for a partial restore.
 *
 * Transient failures (I/O, permission, network) propagate so the
 * export fails loudly with `build_failed` rather than silently
 * producing an incomplete bundle. The distinction lives in
 * `StorageNotFoundError`, which both backends raise only for
 * "object does not exist".
 */
async function copyBlobIntoTar(args: CopyArgs): Promise<FileManifestEntry | null> {
  let body: Uint8Array;
  try {
    body = await storage().get(args.sourceKey);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      log.warn(
        { label: args.label, sourceKey: args.sourceKey },
        "zone export: blob missing; manifest will reference the metadata only",
      );
      return null;
    }
    // Anything else (EACCES, EIO, S3 5xx) is a real outage — the
    // bundle would silently lose data if we swallowed it.
    throw err;
  }
  const buf = Buffer.from(body);
  await addBufferToTar(args.pack, args.tarPath, buf);
  return {
    path: args.tarPath.slice(args.tarPath.indexOf("/") + 1),
    byteCount: buf.length,
    sha256: sha256Hex(buf),
  };
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Restrict an arbitrary filename to a tar-safe subset. Source
 * filenames are user-uploaded and may contain slashes, control
 * chars, etc.; the registry already prefixes with the immutable
 * `{importFileId}` so a clobber is impossible — this is purely
 * defensive against UNIX tooling that misbehaves on weird names.
 */
function sanitiseName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function readme(manifest: BundleManifest): string {
  const tableLines = manifest.tables
    .map((t) => `- \`data/${t.name}.jsonl\` — ${t.rowCount} rows, ${t.byteCount} B`)
    .join("\n");
  return [
    `# StewardLedger zone export — ${manifest.zoneSlug}`,
    "",
    `Generated **${manifest.generatedAt}** for zone \`${manifest.zoneId}\`.`,
    `Bundle format version: ${manifest.formatVersion}.`,
    "",
    "## Contents",
    "",
    `- ${manifest.tables.length} JSONL tables under \`data/\``,
    `- ${manifest.files.length} uploaded import files under \`files/imports/\``,
    `- ${manifest.reports.length} retained report artefacts under \`reports/\``,
    `- This README + a \`manifest.json\` with the per-table + per-blob sha256 digests`,
    "",
    "## Restoring",
    "",
    "The bundle is restorable into a clean Postgres schema using the",
    "StewardLedger Drizzle migration set as of the export time. A",
    "`scripts/restore-export.ts` helper (Phase 9 §3 PR 3) automates",
    "the loop:",
    "",
    "1. Run the migrations against a fresh target database.",
    "2. Load each `data/*.jsonl` in the order recorded in",
    "   `manifest.json` (the registry's `restoreOrder`). Skip rows",
    "   that fail uniqueness; the registry guarantees FK ordering.",
    "3. Copy `files/imports/*` into the target object-storage backend",
    "   under the new zone id.",
    "4. Copy `reports/*` into the target backend, preserving the",
    "   `{jobId}.{ext}` filenames.",
    "",
    "`*_by_user_id` columns reference the global Better Auth `user`",
    "table, which is intentionally NOT in the bundle. The restore",
    "helper nulls them out by default; pass `--map-users` with a",
    "user-id map if you've pre-seeded the referenced accounts.",
    "",
    "## Tables",
    "",
    tableLines,
    "",
    "## Verifying integrity",
    "",
    "`manifest.json` records a sha256 for every JSONL file under",
    "`data/`, every blob under `files/`, and every report artefact",
    "under `reports/`. The **bundle-level** sha256 is NOT in the",
    "manifest (it would be self-referential); look it up on the",
    "`zone_exports` row your export request created (the",
    "`/zone/settings` panel shows it next to the completed bundle).",
    "",
    "Verify per-entry integrity after download:",
    "",
    "```sh",
    "sha256sum -c <(jq -r '.tables[] | \"\\(.sha256)  data/\\(.name).jsonl\"' manifest.json)",
    "```",
    "",
    "Verify the bundle digest matches the row:",
    "",
    "```sh",
    "sha256sum zone-export-*.tar.gz   # compare to zone_exports.sha256",
    "```",
    "",
  ].join("\n");
}

/**
 * Re-export the registry's compile-time list so test suites can
 * assert on it without importing the registry directly. Keeps the
 * test-side import surface small.
 */
export const REGISTRY_TABLES = ZONE_SCOPED_TABLES;

// Drizzle's `import { ImportFile }` is the row type used by the
// FK-iteration block above; re-exported so the test file can stub
// fixture rows without re-deriving the type.
export type { ImportFile };
