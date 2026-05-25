// packages/api/src/services/storage.ts
// Phase 6 — object storage adapter for import files (and, in later phases,
// generated reports and member-uploaded documents).
//
// v1 only ships a filesystem backend so a fresh install runs without S3
// credentials. The interface is deliberately the S3 minimum (`put`, `get`,
// `delete`) so swapping in R2 / B2 in production is a single class.
//
// Storage layout: `{zoneId}/imports/{yyyy}/{mm}/{importFileId}-{sha8}.{ext}`
// The path encodes tenant, kind, and a short content hash so a single
// directory listing never mixes zones or churns into a hot index.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "../env";

export interface ObjectStorage {
  put(key: string, body: Uint8Array, mime?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

/**
 * Thrown by `get(key)` when the requested object does not exist.
 * Distinct from transient I/O / permission failures so callers can
 * decide whether "missing" is a recoverable state (e.g. retention
 * already purged) or whether to fail loudly.
 */
export class StorageNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`storage object not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

class FsStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private resolveKey(key: string): string {
    // Defensive — normalise the path and confirm it lives inside the
    // configured root. The substring `..` check was both too restrictive
    // (rejected harmless keys like `foo..bar`) and too loose (didn't
    // protect against absolute keys or `\x00` injection on some FSs).
    // Mirrors the bootstrap.ts ENV_FILE guard.
    const dest = resolve(this.root, key);
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (dest !== this.root && !dest.startsWith(rootWithSep)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return dest;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const dest = this.resolveKey(key);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
  }

  async get(key: string): Promise<Uint8Array> {
    const src = this.resolveKey(key);
    try {
      return await readFile(src);
    } catch (err) {
      // ENOENT is the canonical "object missing" signal on the FS
      // backend. Everything else (EACCES, EIO, etc.) propagates so
      // the caller can distinguish a normal-purged object from a
      // storage outage.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
      ) {
        throw new StorageNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    await rm(target, { force: true });
  }
}

let singleton: ObjectStorage | null = null;

export function storage(): ObjectStorage {
  if (singleton) return singleton;
  // The fs backend is the default; replace this branch with an S3 client
  // when STORAGE_BACKEND=s3 lands in Phase 10/11.
  singleton = new FsStorage(env.STORAGE_ROOT);
  return singleton;
}

/** Set a custom adapter — only used by tests. */
export function setStorageForTesting(adapter: ObjectStorage | null): void {
  singleton = adapter;
}

/**
 * In-process storage adapter used by the test suites and the upcoming
 * Phase 7 report-generation tests. Lives next to the FS backend because
 * every consumer is also `setStorageForTesting`-adjacent and a separate
 * test-utils package isn't justified yet.
 */
export class InMemoryStorage implements ObjectStorage {
  private readonly store = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array): Promise<void> {
    this.store.set(key, body);
  }
  async get(key: string): Promise<Uint8Array> {
    const v = this.store.get(key);
    if (!v) throw new StorageNotFoundError(key);
    return v;
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  /** Test helper: peek at the number of entries (for leak assertions). */
  size(): number {
    return this.store.size;
  }
}

export function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function buildImportStorageKey(args: {
  zoneId: string;
  fileId: string;
  checksum: string;
  originalFileName: string;
}): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const ext = (args.originalFileName.split(".").pop() ?? "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "bin";
  const sha8 = args.checksum.slice(0, 8);
  return join(args.zoneId, "imports", yyyy, mm, `${args.fileId}-${sha8}.${ext}`);
}
