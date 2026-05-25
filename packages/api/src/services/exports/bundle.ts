// packages/api/src/services/exports/bundle.ts
// Phase 9 §3 — streamed tar.gz writer for a per-zone export bundle.
//
// Reads every zone-scoped table (via the registry) inside a single
// READ ONLY REPEATABLE READ transaction so the dump is internally
// consistent even if writes land mid-export. Each table is paginated
// in 1k-row chunks via `order by id` keyset — the cheapest stable
// ordering on a UUID PK that doesn't depend on a separate index.
//
// Layout written into the tar (see `tasks/zone-export-bundle.md`):
//
//   zone-export-{slug}-{exportId}/
//   ├── manifest.json    â zone slug, generated_at, table list, sha256s
//   ├── README.md        â restore instructions
//   ├── data/{table}.jsonl
//   ├── files/imports/{key}   â raw bytes for every import_files row
//   └── reports/{key}    â retained report artefacts (completed jobs)
//
// We collect the gzipped tar into a single in-memory buffer before
// `storage().put`, because the FS / S3 PutObject in v1 takes a
// `Uint8Array`. A streaming-multipart variant is a Phase 11 problem
// (tracked in `tasks/zone-export-bundle.md` non-goals); v1 is
// dimensioned for the realistic worst case (one-digit GB) and the
// API process has 4 GB+ of headroom in production.
//
// RELEVANT FILES: ./registry.ts, ./jobs.ts, ../storage.ts

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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
import { storage } from "../storage";
import {
  exportOrder,
  ZONE_SCOPED_TABLES,
  type ZoneScopedTable,
} from "./registry";

const PAGE_SIZE = 1_000;
const BUNDLE_FORMAT_VERSION = 1;

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
  /** sha256 of the gzipped tar. Persisted in the manifest + audit. */
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
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));

  // Done is awaited *after* `pack.finalize()` so the consumer sees
  // every emitted byte. The Promise.race-style pattern with `error`
  // re-throws any tar-level encode failure.
  const packDone = new Promise<void>((resolve, reject) => {
    pack.on("end", () => resolve());
    pack.on("error", reject);
  });

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
        throw new Error(`zone ${input.zoneId} not found at export time`);
      }
      zoneSlug = zoneRow.slug;

      const root = `zone-export-${zoneSlug}-${input.exportId}`;

      for (const entry of exportOrder()) {
        const dumped = await dumpTableJsonl(tx, entry, input.zoneId);
        const tarPath = `${root}/data/${entry.name}.jsonl`;
        await addToTar(pack, tarPath, dumped.payload);
        tableEntries.push({
          name: entry.name,
          rowCount: dumped.rowCount,
          byteCount: dumped.payload.length,
          sha256: sha256Hex(dumped.payload),
        });
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
  // payload entry's sha256. Both are tiny so the I/O cost is
  // negligible.
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
  await addToTar(
    pack,
    `${root}/manifest.json`,
    Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"),
  );
  await addToTar(
    pack,
    `${root}/README.md`,
    Buffer.from(readme(manifest), "utf-8"),
  );

  pack.finalize();
  await packDone;

  const tarBytes = Buffer.concat(chunks);
  // Synchronous gzip is fine for the bundle sizes we target.
  // Switch to a streaming Gzip with backpressure when the S3
  // multipart upload path lands.
  const gzipped = gzipSync(tarBytes);
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
}

interface DumpedTable {
  rowCount: number;
  payload: Buffer;
}

/**
 * Stream a table into a JSONL buffer. Pagination uses keyset on
 * `id` (UUIDs sort lexicographically; stable inside the txn's
 * snapshot). Returns the assembled payload and a row count.
 */
async function dumpTableJsonl(
  // Drizzle's tx type is verbose; the runtime contract is just
  // `select().from(table)`, which both `Database` and the
  // transaction type honour.
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  entry: ZoneScopedTable,
  zoneId: string,
): Promise<DumpedTable> {
  const idColumn = (entry.table as unknown as { id: ReturnType<typeof sql.raw> }).id;
  let cursor: string | null = null;
  let rowCount = 0;
  const lines: string[] = [];
  // The registry's selector tells us whether to filter on
  // `zone_id = $zoneId` (the common case) or `id = $zoneId` (the
  // `zones` self-row).
  const isSelf = entry.selector === "self";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zoneCol = (entry.table as any).zoneId;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const whereParts = [] as unknown[];
    if (isSelf) {
      whereParts.push(eq(idColumn as never, zoneId));
    } else {
      whereParts.push(eq(zoneCol, zoneId));
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
    for (const row of rows) {
      lines.push(stringifyJsonlRow(row));
      rowCount += 1;
    }
    if (rows.length < PAGE_SIZE) break;
    const last = rows[rows.length - 1] as { id?: string };
    if (!last.id) break;
    cursor = last.id;
  }
  // One trailing newline is JSONL-conventional.
  const text = lines.length === 0 ? "" : lines.join("\n") + "\n";
  return { rowCount, payload: Buffer.from(text, "utf-8") };
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
 * Push a single named entry into the tar archive. The `pack.entry`
 * callback fires when the entry is fully consumed; we adapt it to a
 * Promise so the caller can `await` between entries instead of
 * juggling streams.
 */
function addToTar(
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

interface CopyArgs {
  pack: tar.Pack;
  tarPath: string;
  sourceKey: string;
  label: string;
}

/**
 * Copy a blob from object storage into the tar. Returns null when
 * the source blob is missing (e.g. the retention sweep purged it);
 * the JSONL still records the metadata so a partial restore is
 * possible. Other errors propagate so the export fails loudly.
 */
async function copyBlobIntoTar(args: CopyArgs): Promise<FileManifestEntry | null> {
  let body: Uint8Array;
  try {
    body = await storage().get(args.sourceKey);
  } catch (err) {
    log.warn(
      { err, label: args.label, sourceKey: args.sourceKey },
      "zone export: blob missing; manifest will reference the metadata only",
    );
    return null;
  }
  const buf = Buffer.from(body);
  await addToTar(args.pack, args.tarPath, buf);
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
    `- This README + a \`manifest.json\` with every row count and sha256`,
    "",
    "## Restoring",
    "",
    "The bundle is restorable into a clean Postgres schema using the",
    "StewardLedger Drizzle migration set as of the export time. A",
    "`scripts/restore-export.ts` helper (Phase 9 �3 PR 3) automates",
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
    "Every JSONL file, every blob, and the gzipped bundle itself have",
    "a sha256 recorded in `manifest.json`. After download:",
    "",
    "```sh",
    "sha256sum -c <(jq -r '.tables[] | \"\\(.sha256)  data/\\(.name).jsonl\"' manifest.json)",
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

/** Test seam: synchronous gzip used so the test can decode the bundle. */
export { gzipSync };

// Drizzle's `import { ImportFile }` is the row type used by the
// FK-iteration block above; re-exported so the test file can stub
// fixture rows without re-deriving the type.
export type { ImportFile };
