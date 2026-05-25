// packages/api/scripts/restore-export.ts
// Phase 9 §3 — thin CLI wrapper around the restore-helper library
// at `../src/services/exports/restore.ts`. Parses argv, opens a
// `postgres` connection, drives `restoreZoneExportBundle`, and
// prints a JSON summary.
//
// Usage:
//
//   pnpm --filter @stewardledger/api restore-export <bundle.tar.gz> \
//     [--target-zone-id <uuid>]     # default: a fresh UUID
//     [--target-slug <slug>]         # default: source slug + "-restored"
//     [--map-users <map.json>]       # {sourceUserId: targetUserId} map
//     [--storage-root <dir>]         # default: env STORAGE_ROOT
//     [--dry-run]                    # parse + validate, don't write
//
// The library does NOT run Drizzle migrations. Run
// `pnpm --filter @stewardledger/db db:migrate` against the target
// database first so the schema matches the bundle's manifest
// `formatVersion`.
//
// RELEVANT FILES: ../src/services/exports/restore.ts

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@stewardledger/db/schema";
import {
  restoreZoneExportBundle,
  type ObjectStorageLike,
} from "../src/services/exports/restore";

interface CliArgs {
  bundlePath: string;
  targetZoneId?: string;
  targetSlug?: string;
  userMapPath?: string;
  storageRoot?: string;
  dryRun: boolean;
}

/**
 * Pull a value flag off `argv[i+1]`. Fails with a usage error if
 * the flag is last or followed by another flag — catching the
 * mistake at parse time is cheaper than letting the script run
 * with an `undefined` argument that surfaces as a confusing
 * downstream error (e.g. "DATABASE_URL is required" when really
 * the operator forgot the value after `--target-zone-id`).
 */
function valueArg(
  argv: string[],
  i: number,
  flag: string,
): { value: string; next: number } {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(
      `missing value for ${flag} — usage: ${flag} <value>`,
    );
  }
  return { value, next: i + 1 };
}

function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { bundlePath: "", dryRun: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target-zone-id") {
      const v = valueArg(argv, i, a);
      out.targetZoneId = v.value;
      i = v.next;
    } else if (a === "--target-slug") {
      const v = valueArg(argv, i, a);
      out.targetSlug = v.value;
      i = v.next;
    } else if (a === "--map-users") {
      const v = valueArg(argv, i, a);
      out.userMapPath = v.value;
      i = v.next;
    } else if (a === "--storage-root") {
      const v = valueArg(argv, i, a);
      out.storageRoot = v.value;
      i = v.next;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    throw new Error(
      "usage: restore-export <bundle.tar.gz> [--target-zone-id <uuid>] [--target-slug <slug>] [--map-users <path>] [--storage-root <dir>] [--dry-run]",
    );
  }
  out.bundlePath = resolve(positional[0]);
  return out;
}

async function loadUserMap(path: string): Promise<Map<string, string>> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, string>;
  return new Map(Object.entries(parsed));
}

/**
 * Minimal FS-backed storage adapter. The restore-helper only needs
 * `put`; reads (and the `StorageNotFoundError` discrimination from
 * the API-side adapter) are not on the restore path.
 *
 * Mirrors the path-traversal guard in `services/storage.ts:FsStorage`
 * so a malformed key (e.g. one bundled with a hostile slug encoded
 * in the source `storage_key`) can't escape the configured root.
 * Keys at restore-time are derived from DB rows we just INSERTed,
 * so the immediate risk is low, but matching the production
 * adapter keeps the two paths from drifting.
 */
function makeFsStorage(rootArg: string): ObjectStorageLike {
  const root = resolve(rootArg);
  const rootBoundary = root.endsWith(sep) ? root : root + sep;
  return {
    async put(key: string, body: Uint8Array): Promise<void> {
      const dest = resolve(root, key);
      if (dest !== root && !dest.startsWith(rootBoundary)) {
        throw new Error(`invalid storage key: ${key}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, body);
    },
  };
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "../../..");
  config({ path: resolve(repoRoot, ".env") });

  const args = parseCliArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  const storageRoot =
    args.storageRoot ?? process.env.STORAGE_ROOT ?? "./var/storage";
  const fsStorage = makeFsStorage(storageRoot);

  const userIdMap = args.userMapPath
    ? await loadUserMap(args.userMapPath)
    : undefined;
  try {
    const result = await restoreZoneExportBundle({
      bundlePath: args.bundlePath,
      database: db,
      storage: fsStorage,
      targetZoneId: args.targetZoneId,
      targetSlug: args.targetSlug,
      userIdMap,
      dryRun: args.dryRun,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
