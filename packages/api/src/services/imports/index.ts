// packages/api/src/services/imports/index.ts
// Phase 6 — import orchestration. Upload → parse → match → schedule
// (preview) → commit → (optional) rollback. The job state machine and
// idempotency guards live here; parser and matcher are pure modules.
//
// Phase-6 simplification: `uploadImport` commits the file + job + audit
// row in one short transaction, then kicks off `runImportJob` in a
// separate transaction synchronously. This is the shape pg-boss will
// take in Phase 7+: tx 1 is the request handler, tx 2 is the worker.
// Splitting them keeps row locks on `import_files` / `processed_*`
// short, and prevents the upload tx from holding locks while the parser
// walks the file.
//
// Idempotency:
//   • Re-uploading the same bytes returns the existing import_file +
//     import_job (no new parse).
//   • The matcher marks rows whose `external_transaction_id` already
//     lives in `processed_transactions` as duplicates; commit skips them.
//   • Two separate import jobs that each include the same
//     `external_transaction_id` race on commit; the unique index on
//     `(zone_id, external_transaction_id)` surfaces the loser as 23505
//     and the operator must rollback before re-trying.
//
// Rollback voids every contribution emitted by the job, deletes the
// matching `processed_transactions` rows (so a corrected re-upload can
// happen), and audits the rollback. The contribution-immutability rules
// from Phase 5 still apply — we void rather than delete.

import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contributionLines,
  contributions,
  importFiles,
  importJobs,
  importRowFailures,
  importRows,
  importSchedules,
  processedTransactions,
} from "@stewardledger/db/schema";
import type { Database, Db } from "@stewardledger/db";
import type {
  ImportCreateInput,
  ImportListQuery,
  ImportRowListQuery,
} from "@stewardledger/shared";
import { writeAudit, writeAuditMany } from "../audit";
import {
  buildImportStorageKey,
  sha256,
  storage,
} from "../storage";
import { matchRows, persistMatchedRows, summariseMatch } from "./match";
import { parseImportBody } from "./parsers";

export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ActorContext {
  zoneId: string;
  userId: string;
}

const MONEY_DP = 4;
const toMoney = (d: Decimal): string => d.toFixed(MONEY_DP);

/**
 * Cap on the number of inline samples stored in an audit row's `after`
 * payload. Keeps `audit_events` rows bounded for rollbacks (and future
 * bulk operations) while preserving "did rollback X free TX-Y?" lookups
 * for the common case where Y is one of the first samples. The full
 * list can always be recovered from the voided contributions'
 * `external_transaction_id` column.
 */
const AUDIT_SAMPLE_LIMIT = 100;
const BULK_WRITE_CHUNK = 1_000;

function chunksOf<T>(items: readonly T[], size = BULK_WRITE_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

type ImportRowParsedShape = {
  amount: string | null;
  contributionDate: string | null;
  description: string | null;
};
type EligibleImportRow = typeof importRows.$inferSelect & {
  chapterId: string;
  givingTypeId: string;
  currencyCode: string;
};
type EligibleParsed = ImportRowParsedShape & {
  amount: string;
  contributionDate: string;
};

/**
 * Type-narrowing predicate used by `commitImport`: a row is eligible
 * iff every FK the contribution insert needs is non-null AND the
 * parsed payload has the amount + date. The `{ ok: true }` branch means
 * the caller can treat `row` and `parsed` as fully-typed; the
 * `{ ok: false }` branch captures the first missing field for audit
 * purposes.
 */
function checkEligibility(
  row: typeof importRows.$inferSelect,
  parsed: ImportRowParsedShape | null,
): { ok: true; row: EligibleImportRow; parsed: EligibleParsed } | { ok: false; reason: string } {
  if (!parsed) return { ok: false, reason: "parsed_payload_missing" };
  if (!row.chapterId) return { ok: false, reason: "chapter_id_missing" };
  if (!row.givingTypeId) return { ok: false, reason: "giving_type_id_missing" };
  if (!row.currencyCode) return { ok: false, reason: "currency_code_missing" };
  if (!parsed.amount) return { ok: false, reason: "amount_missing" };
  if (!parsed.contributionDate) return { ok: false, reason: "contribution_date_missing" };
  return {
    ok: true,
    row: row as EligibleImportRow,
    parsed: parsed as EligibleParsed,
  };
}

/**
 * Emit one `contribution.void` audit event per voided contribution.
 * Extracted out of `rollbackImport` so the in-memory loop is obviously
 * cheap (the bulk UPDATE is the only DB write) and so a reader doesn't
 * mistake it for an N+1 round-trip.
 */
function buildContributionVoidAudits(
  ctx: ActorContext,
  contributionIds: string[],
  voidReason: string,
  importJobId: string,
): Parameters<typeof writeAuditMany>[1] {
  return contributionIds.map((id) => ({
    zoneId: ctx.zoneId,
    actorUserId: ctx.userId,
    action: "contribution.void" as const,
    entityType: "contribution" as const,
    entityId: id,
    before: { status: "posted" },
    after: { status: "voided", voidReason, importJobId },
  }));
}

interface UploadInput extends ImportCreateInput {
  fileName: string;
  body: Uint8Array;
}

export interface ImportUploadResult {
  importFileId: string;
  importJobId: string;
  reused: boolean;
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  duplicateRows: number;
  failedRows: number;
}

/**
 * Helper: surface an existing job for a duplicate-checksum upload as the
 * "reuse" branch. Returns null when no file row exists yet.
 */
async function reuseExistingImport(
  database: Db,
  zoneId: string,
  checksum: string,
  fileType: string,
  sourceType: string | null | undefined,
  chapterId: string | null | undefined,
): Promise<ImportUploadResult | null> {
  const [existing] = await database
    .select({ id: importFiles.id })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.zoneId, zoneId),
        eq(importFiles.checksumSha256, checksum),
        eq(importFiles.fileType, fileType),
        eq(importFiles.sourceType, sourceType ?? "generic_csv"),
        chapterId ? eq(importFiles.chapterId, chapterId) : isNull(importFiles.chapterId),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const [job] = await database
    .select({
      id: importJobs.id,
      totalRows: importJobs.totalRows,
      matchedRows: importJobs.matchedRows,
      unmatchedRows: importJobs.unmatchedRows,
      duplicateRows: importJobs.duplicateRows,
      failedRows: importJobs.failedRows,
    })
    .from(importJobs)
    .where(and(eq(importJobs.zoneId, zoneId), eq(importJobs.importFileId, existing.id)))
    .orderBy(sql`${importJobs.createdAt} desc`)
    .limit(1);
  if (!job) return null;
  return {
    importFileId: existing.id,
    importJobId: job.id,
    reused: true,
    totalRows: job.totalRows,
    matchedRows: job.matchedRows,
    unmatchedRows: job.unmatchedRows,
    duplicateRows: job.duplicateRows,
    failedRows: job.failedRows,
  };
}

/** Postgres SQLSTATE for unique_violation. Used to convert a race on the
 * chapter-aware `(zone_id, checksum, file_type, source_type)` partial
 * unique indexes into the reuse path. */
const UNIQUE_VIOLATION = "23505";

/**
 * Upload + parse + match. Runs as two consecutive transactions so the
 * upload tx commits quickly and the parser/matcher doesn't hold row
 * locks while it walks the file:
 *
 *   Tx 1 (`persistUpload`):
 *     - SELECT existing file by zone, checksum, file type, source type,
 *       and chapter scope; reuse if hit.
 *     - INSERT import_files; on 23505 from a concurrent duplicate, fall
 *       back to the reuse path.
 *     - `storage().put` the bytes after the file row exists; a write
 *       failure rolls the row back, and a later DB failure best-effort
 *       deletes the just-written object to avoid orphaned bytes.
 *     - INSERT import_jobs (status='received') + audit.
 *
 *   Tx 2 (`runImportJob`):
 *     - Status transitions and persistMatchedRows.
 *
 * Phase 7+ replaces the synchronous tx-2 dispatch with
 * `queue.send("import.run", { jobId })` and a pg-boss worker; the
 * service-layer contract is otherwise unchanged.
 */
export async function uploadImport(
  database: Database,
  ctx: ActorContext,
  input: UploadInput,
): Promise<ImportUploadResult> {
  const checksum = sha256(input.body);
  const reuseHit = await reuseExistingImport(
    database,
    ctx.zoneId,
    checksum,
    input.fileType,
    input.sourceType,
    input.chapterId,
  );
  if (reuseHit) return reuseHit;

  const persisted = await persistUpload(database, ctx, input, checksum);
  if (persisted.reused) return persisted.reused;

  // Tx 2: parse + match. Runs synchronously today; pg-boss in Phase 7+.
  const summary = await runImportJob(database, ctx.zoneId, persisted.importJobId, {
    body: input.body,
    fileName: input.fileName,
    sourceType: input.sourceType ?? null,
    fileChapterId: input.chapterId ?? null,
  });

  return {
    importFileId: persisted.importFileId,
    importJobId: persisted.importJobId,
    reused: false,
    ...summary,
  };
}

/**
 * Tx 1: persist the upload row + bytes + job + audit. Returns either the
 * new (fileId, jobId) pair or a `reused` result if a concurrent uploader
 * won the race on the unique constraint.
 */
async function persistUpload(
  database: Database,
  ctx: ActorContext,
  input: UploadInput,
  checksum: string,
): Promise<
  | { reused: ImportUploadResult; importFileId?: undefined; importJobId?: undefined }
  | { reused: null; importFileId: string; importJobId: string }
> {
  const fileId = crypto.randomUUID();
  const storageKey = buildImportStorageKey({
    zoneId: ctx.zoneId,
    fileId,
    checksum,
    originalFileName: input.fileName,
  });

  let wroteStorage = false;
  try {
    const result = await database.transaction(async (tx) => {
      // INSERT first so a unique-violation aborts the tx before we touch
      // the object store. Re-attempts after rollback land in the reuse
      // path above on the next call.
      const [file] = await tx
        .insert(importFiles)
        .values({
          id: fileId,
          zoneId: ctx.zoneId,
          chapterId: input.chapterId ?? null,
          uploadedByUserId: ctx.userId,
          originalFileName: input.fileName,
          storageKey,
          sizeBytes: input.body.byteLength,
          checksumSha256: checksum,
          fileType: input.fileType,
          sourceType: input.sourceType ?? "generic_csv",
        })
        .returning({ id: importFiles.id });

      // Only persist the bytes once the file row exists. A storage write
      // failure now aborts the tx and the file row is rolled back, so we
      // never end up with a row pointing at missing bytes.
      await storage().put(storageKey, input.body);
      wroteStorage = true;

      const [job] = await tx
        .insert(importJobs)
        .values({
          zoneId: ctx.zoneId,
          importFileId: file.id,
          status: "received",
          createdByUserId: ctx.userId,
          startedAt: new Date(),
        })
        .returning({ id: importJobs.id });

      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "import.upload",
        entityType: "import_job",
        entityId: job.id,
        after: {
          importFileId: file.id,
          fileName: input.fileName,
          size: input.body.byteLength,
          checksum,
        },
      });
      return { importFileId: file.id, importJobId: job.id };
    });
    return { reused: null, importFileId: result.importFileId, importJobId: result.importJobId };
  } catch (err) {
    // If storage succeeded but a later DB write failed, the tx rolled
    // back and no row references the object. Best-effort delete so local
    // FS/R2/S3 backends don't accumulate orphaned upload bytes.
    if (wroteStorage) {
      try {
        await storage().delete(storageKey);
      } catch {
        // Preserve the original failure; an object-store sweeper can
        // clean up any leftover orphan.
      }
    }

    // Lost the race on the unique index. The other uploader already has
    // a file + job row; fall back to the reuse path.
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === UNIQUE_VIOLATION) {
      const reuse = await reuseExistingImport(
        database,
        ctx.zoneId,
        checksum,
        input.fileType,
        input.sourceType,
        input.chapterId,
      );
      if (reuse) return { reused: reuse };
    }
    throw err;
  }
}

interface RunInput {
  body: Uint8Array;
  fileName: string;
  sourceType: string | null;
  fileChapterId: string | null;
}

/**
 * Parse + match an import job. The entry transition is conditional
 * (`received → parsing`) so duplicate workers cannot both run. Parsing
 * happens outside the persistence tx; row/failure inserts and the final
 * `matched` status update are then committed atomically so a failed
 * persist never leaves half an import behind.
 */
export async function runImportJob(
  database: Database,
  zoneId: string,
  importJobId: string,
  input: RunInput,
): Promise<{
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  duplicateRows: number;
  failedRows: number;
}> {
  const started = await database
    .update(importJobs)
    .set({ status: "parsing", updatedAt: new Date() })
    .where(
      and(
        eq(importJobs.zoneId, zoneId),
        eq(importJobs.id, importJobId),
        eq(importJobs.status, "received"),
      ),
    )
    .returning({ id: importJobs.id });
  if (started.length === 0) {
    const [job] = await database
      .select({ status: importJobs.status })
      .from(importJobs)
      .where(and(eq(importJobs.zoneId, zoneId), eq(importJobs.id, importJobId)))
      .limit(1);
    if (!job) throw new ImportError("not_found", "Import job not in this zone.");
    throw new ImportError(
      "invalid_transition",
      `Only received jobs can be parsed (status='${job.status}').`,
    );
  }

  const failJob = async (err: unknown, code: string): Promise<never> => {
    const message = err instanceof Error ? err.message : String(err);
    await database
      .update(importJobs)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(importJobs.zoneId, zoneId), eq(importJobs.id, importJobId)));
    throw new ImportError(code, message);
  };

  let parsed: ReturnType<typeof parseImportBody>;
  try {
    parsed = parseImportBody({
      body: input.body,
      fileName: input.fileName,
      sourceType: input.sourceType,
    });
  } catch (err) {
    return await failJob(err, "parse_failed");
  }

  let matched: Awaited<ReturnType<typeof matchRows>>;
  try {
    matched = await matchRows(
      database,
      { zoneId, fileChapterId: input.fileChapterId },
      parsed.rows,
    );
  } catch (err) {
    return await failJob(err, "match_failed");
  }

  const summary = summariseMatch(matched);
  try {
    await database.transaction(async (tx) => {
      await persistMatchedRows(tx, zoneId, importJobId, matched);
      await tx
        .update(importJobs)
        .set({
          status: "matched",
          ...summary,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(importJobs.zoneId, zoneId), eq(importJobs.id, importJobId)));
    });
  } catch (err) {
    return await failJob(err, "persist_failed");
  }

  return summary;
}

/**
 * Mark a job ready to commit. Refuses if there are still validation
 * failures the operator needs to fix first. The schedule row is the
 * audit anchor for the eventual commit.
 *
 * Concurrency: the status transition is a single conditional UPDATE
 * keyed on `status='matched' AND failed_rows = 0`. A parallel scheduler
 * or a parallel row-fix flow (Phase 6 polish) cannot slip a stale
 * `failed_rows = 0` past us — the UPDATE itself is the authority. On
 * zero affected rows we re-read the row to surface the more specific
 * 404 / `has_failures` / `invalid_transition` error.
 */
export async function scheduleImport(
  database: Database,
  ctx: ActorContext,
  importJobId: string,
): Promise<{ scheduleId: string }> {
  return await database.transaction(async (tx) => {
    const flipped = await tx
      .update(importJobs)
      .set({ status: "scheduled", updatedAt: new Date() })
      .where(
        and(
          eq(importJobs.zoneId, ctx.zoneId),
          eq(importJobs.id, importJobId),
          eq(importJobs.status, "matched"),
          eq(importJobs.failedRows, 0),
        ),
      )
      .returning({ id: importJobs.id });
    if (flipped.length === 0) {
      const [job] = await tx
        .select({ status: importJobs.status, failedRows: importJobs.failedRows })
        .from(importJobs)
        .where(and(eq(importJobs.zoneId, ctx.zoneId), eq(importJobs.id, importJobId)))
        .limit(1);
      if (!job) throw new ImportError("not_found", "Import job not in this zone.");
      if (job.failedRows > 0) {
        throw new ImportError(
          "has_failures",
          "Resolve invalid rows before scheduling. Correct the source CSV and re-upload.",
        );
      }
      throw new ImportError(
        "invalid_transition",
        `Only matched jobs can be scheduled (status='${job.status}').`,
      );
    }
    const [schedule] = await tx
      .insert(importSchedules)
      .values({
        zoneId: ctx.zoneId,
        importJobId,
        scheduledByUserId: ctx.userId,
      })
      .returning({ id: importSchedules.id });
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "import.schedule",
      entityType: "import_job",
      entityId: importJobId,
      after: { scheduleId: schedule.id },
    });
    return { scheduleId: schedule.id };
  });
}

/**
 * Commit a scheduled import: insert one contribution per non-duplicate,
 * valid row, plus the matching processed_transactions guard. The whole
 * commit happens in one tx so a partial failure rolls back everything.
 *
 * Performance: every write uses bounded-size batches instead of per-row
 * loops. Round trips scale by chunks rather than rows, and each
 * statement stays below Postgres' bind-parameter ceiling. The
 * import_rows backfill uses chunked `UPDATE … FROM (VALUES …)` pages.
 *
 * Concurrency: the `scheduled→committing` flip is a conditional UPDATE
 * returning the affected row. Two parallel commits of the same job
 * cannot both proceed — the second sees `flipped.length === 0` and
 * surfaces `invalid_transition`. Two separate jobs that happen to
 * contain the same `external_transaction_id` still race on the
 * `processed_transactions_zone_ext_unique` constraint; the loser hits
 * 23505 and the operator must rollback before re-trying.
 *
 * Audit: emits `contribution.create` AND `contribution.post` per
 * committed row, mirroring the Phase 5 service-layer pattern, so
 * downstream tooling that joins on audit events sees the same shape
 * regardless of whether the contribution was hand-keyed or imported.
 * Matcher contract violations (validation_status='valid' but a required
 * FK missing) write an `import.commit_skip` audit row with a sample, so
 * they are never silent.
 */
export async function commitImport(
  database: Database,
  ctx: ActorContext,
  importJobId: string,
): Promise<{ committedRows: number; skippedDuplicates: number }> {
  return await database.transaction(async (tx) => {
    // Conditional transition. The WHERE clause filters by current status,
    // so a parallel commit sees zero affected rows.
    const flipped = await tx
      .update(importJobs)
      .set({ status: "committing", updatedAt: new Date() })
      .where(
        and(
          eq(importJobs.zoneId, ctx.zoneId),
          eq(importJobs.id, importJobId),
          eq(importJobs.status, "scheduled"),
        ),
      )
      .returning({ id: importJobs.id, status: importJobs.status });
    if (flipped.length === 0) {
      // Distinguish 404 from 409: load to find out which one.
      const [job] = await tx
        .select({ status: importJobs.status })
        .from(importJobs)
        .where(and(eq(importJobs.zoneId, ctx.zoneId), eq(importJobs.id, importJobId)))
        .limit(1);
      if (!job) throw new ImportError("not_found", "Import job not in this zone.");
      throw new ImportError(
        "invalid_transition",
        `Only scheduled jobs can be committed (status='${job.status}').`,
      );
    }

    const rows = await tx
      .select()
      .from(importRows)
      .where(
        and(eq(importRows.zoneId, ctx.zoneId), eq(importRows.importJobId, importJobId)),
      );

    // Partition rows: commit candidates, duplicates we skip silently,
    // and matcher-contract violations we record on the audit trail so an
    // operator notices when validation_status='valid' but the FK fields
    // are missing.
    let skippedDuplicates = 0;
    const skippedRows: { rowId: string; reason: string }[] = [];
    const eligible: {
      rowId: string;
      contributionId: string;
      chapterId: string;
      memberId: string | null;
      givingTypeId: string;
      accountId: string | null;
      paymentMethodId: string | null;
      serviceEventId: string | null;
      givingPeriodId: string | null;
      currencyCode: string;
      externalTransactionId: string | null;
      contributionDate: string;
      amount: string;
      description: string | null;
    }[] = [];
    for (const row of rows) {
      if (row.isDuplicate) {
        skippedDuplicates++;
        continue;
      }
      if (row.validationStatus !== "valid") continue;
      const parsedRaw = row.parsed as ImportRowParsedShape | null;
      // Matcher contract: any row marked `valid` MUST have every FK
      // field resolved. If we land here with a missing one, that's a
      // matcher bug; record it in the audit trail and skip the row
      // rather than abort the whole commit on its account.
      const check = checkEligibility(row, parsedRaw);
      if (!check.ok) {
        skippedRows.push({ rowId: row.id, reason: check.reason });
        continue;
      }
      eligible.push({
        rowId: check.row.id,
        contributionId: crypto.randomUUID(),
        chapterId: check.row.chapterId,
        memberId: check.row.memberId,
        givingTypeId: check.row.givingTypeId,
        accountId: check.row.accountId,
        paymentMethodId: check.row.paymentMethodId,
        serviceEventId: check.row.serviceEventId,
        givingPeriodId: check.row.givingPeriodId,
        currencyCode: check.row.currencyCode,
        externalTransactionId: check.row.externalTransactionId,
        contributionDate: check.parsed.contributionDate,
        amount: toMoney(new Decimal(check.parsed.amount)),
        description: check.parsed.description,
      });
    }

    const now = new Date();
    const committedCount = eligible.length;

    if (skippedRows.length > 0) {
      // Surface matcher contract violations so they're never silent.
      await writeAudit(tx, {
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        action: "import.commit_skip",
        entityType: "import_job",
        entityId: importJobId,
        after: {
          skippedCount: skippedRows.length,
          sample: skippedRows.slice(0, AUDIT_SAMPLE_LIMIT),
        },
      });
    }

    if (eligible.length > 0) {
      // 1) Bulk-insert draft contributions with pre-allocated ids so we
      //    can reference them in the line and processed_transactions
      //    inserts without a per-row roundtrip.
      for (const chunk of chunksOf(eligible)) {
        await tx.insert(contributions).values(
          chunk.map((e) => ({
            id: e.contributionId,
            zoneId: ctx.zoneId,
            chapterId: e.chapterId,
            memberId: e.memberId,
            sourceType: "bank_import",
            paymentMethodId: e.paymentMethodId,
            serviceEventId: e.serviceEventId,
            givingPeriodId: e.givingPeriodId,
            contributionDate: e.contributionDate,
            totalAmount: e.amount,
            currencyCode: e.currencyCode,
            externalTransactionId: e.externalTransactionId,
            description: e.description,
            status: "draft",
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          })),
        );
      }

      // 2) Bulk-insert lines now that parents exist (the
      //    `contribution_lines_posted_guard` trigger only blocks inserts
      //    when the parent is already posted; drafts are fine).
      for (const chunk of chunksOf(eligible)) {
        await tx.insert(contributionLines).values(
          chunk.map((e) => ({
            zoneId: ctx.zoneId,
            contributionId: e.contributionId,
            givingTypeId: e.givingTypeId,
            accountId: e.accountId,
            amount: e.amount,
            currencyCode: e.currencyCode,
          })),
        );
      }

      // 3) Bulk-promote drafts to posted. After this point
      //    `contributions_posted_guard` makes them immutable.
      const ids = eligible.map((e) => e.contributionId);
      for (const idChunk of chunksOf(ids)) {
        await tx
          .update(contributions)
          .set({
            status: "posted",
            postedAt: now,
            postedByUserId: ctx.userId,
            updatedAt: now,
            updatedByUserId: ctx.userId,
          })
          .where(
            and(
              eq(contributions.zoneId, ctx.zoneId),
              inArray(contributions.id, idChunk),
            ),
          );
      }

      // 4) Idempotency rows for those with an external_transaction_id.
      const dedupe = eligible.filter((e) => e.externalTransactionId);
      for (const chunk of chunksOf(dedupe)) {
        if (chunk.length === 0) continue;
        await tx.insert(processedTransactions).values(
          chunk.map((e) => ({
            zoneId: ctx.zoneId,
            externalTransactionId: e.externalTransactionId!,
            importJobId,
            contributionId: e.contributionId,
          })),
        );
      }

      // 5) Backfill import_rows.contributionId so the dashboard can link
      //    from source row to posted contribution. We use an
      //    `UPDATE … FROM (VALUES …)` against a derived table so the
      //    parameter count grows as 2×N rather than the CASE-WHEN's
      //    O(N) inline-string explosion, keeping capped imports well
      //    under Postgres' int16 parameter ceiling (~32k).
      //    Chunked into 1,000-row pages as belt-and-braces against any
      //    future backend (e.g. pgbouncer in transaction mode) that
      //    further reduces per-statement parameters.
      const nowIso = now.toISOString();
      for (const chunk of chunksOf(eligible)) {
        const values = sql.join(
          chunk.map((e) => sql`(${e.rowId}, ${e.contributionId})`),
          sql`, `,
        );
        // Note: `updated_at` is bound as a string + cast — postgres-js
        // won't bind a JS Date through a raw `sql` template, and a
        // timestamptz column happily accepts an ISO string.
        await tx.execute(sql`
          update ${importRows} as r
          set
            contribution_id = v.contribution_id,
            updated_at = ${nowIso}::timestamptz
          from (values ${values}) as v(row_id, contribution_id)
          where r.zone_id = ${ctx.zoneId}
            and r.id = v.row_id
        `);
      }

      // Audit: emit create+post per committed row in a single bulk insert.
      const auditEvts: Parameters<typeof writeAuditMany>[1] = [];
      for (const e of eligible) {
        auditEvts.push({
          zoneId: ctx.zoneId,
          actorUserId: ctx.userId,
          action: "contribution.create",
          entityType: "contribution",
          entityId: e.contributionId,
          after: {
            status: "draft",
            sourceType: "bank_import",
            importJobId,
            totalAmount: e.amount,
            currencyCode: e.currencyCode,
            externalTransactionId: e.externalTransactionId,
          },
        });
        auditEvts.push({
          zoneId: ctx.zoneId,
          actorUserId: ctx.userId,
          action: "contribution.post",
          entityType: "contribution",
          entityId: e.contributionId,
          before: { status: "draft" },
          after: { status: "posted", postedAt: now.toISOString(), importJobId },
        });
      }
      await writeAuditMany(tx, auditEvts);
    }

    await tx
      .update(importJobs)
      .set({
        status: "committed",
        committedRows: committedCount,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(importJobs.zoneId, ctx.zoneId), eq(importJobs.id, importJobId)));

    await tx
      .update(importSchedules)
      .set({ committedAt: now, committedByUserId: ctx.userId })
      .where(
        and(
          eq(importSchedules.zoneId, ctx.zoneId),
          eq(importSchedules.importJobId, importJobId),
          sql`${importSchedules.committedAt} is null`,
          sql`${importSchedules.rolledBackAt} is null`,
        ),
      );

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "import.commit",
      entityType: "import_job",
      entityId: importJobId,
      after: { committedRows: committedCount, skippedDuplicates },
    });

    return { committedRows: committedCount, skippedDuplicates };
  });
}

/**
 * Roll back a committed import: void every contribution emitted by the
 * job and delete the matching processed_transactions rows (so a fixed
 * re-upload can take their place). Audit captures the rollback reason
 * and the external transaction ids freed by the rollback so the trail
 * can answer "did rollback X free TX-Y?" without a join.
 *
 * We void rather than delete: AGENTS rule #3 forbids hard-deleting
 * posted contributions. The void_reason includes the rollback reason so
 * the audit trail is complete.
 *
 * Concurrency: status transitions `committed → rolled_back` via a
 * conditional UPDATE; two parallel rollbacks cannot both succeed.
 */
export async function rollbackImport(
  database: Database,
  ctx: ActorContext,
  importJobId: string,
  args: { reason: string },
): Promise<{ voidedContributions: number }> {
  return await database.transaction(async (tx) => {
    const flipped = await tx
      .update(importJobs)
      .set({ status: "rolled_back", updatedAt: new Date() })
      .where(
        and(
          eq(importJobs.zoneId, ctx.zoneId),
          eq(importJobs.id, importJobId),
          eq(importJobs.status, "committed"),
        ),
      )
      .returning({ id: importJobs.id });
    if (flipped.length === 0) {
      const [job] = await tx
        .select({ status: importJobs.status })
        .from(importJobs)
        .where(and(eq(importJobs.zoneId, ctx.zoneId), eq(importJobs.id, importJobId)))
        .limit(1);
      if (!job) throw new ImportError("not_found", "Import job not in this zone.");
      throw new ImportError(
        "invalid_transition",
        `Only committed jobs can be rolled back (status='${job.status}').`,
      );
    }

    const targetContributionIds = (
      await tx
        .select({ contributionId: importRows.contributionId })
        .from(importRows)
        .where(
          and(
            eq(importRows.zoneId, ctx.zoneId),
            eq(importRows.importJobId, importJobId),
            sql`${importRows.contributionId} is not null`,
          ),
        )
    )
      .map((r) => r.contributionId)
      .filter((id): id is string => id !== null);

    const now = new Date();
    const voidReason = `Import rollback: ${args.reason}`;
    const auditEvts: Parameters<typeof writeAuditMany>[1] = [];

    if (targetContributionIds.length > 0) {
      // One bulk UPDATE instead of N per-id UPDATEs. The Phase 5 posted-
      // immutability guard explicitly allows status → voided + the
      // void_* bookkeeping columns to change on a posted row.
      for (const idChunk of chunksOf(targetContributionIds)) {
        await tx
          .update(contributions)
          .set({
            status: "voided",
            voidedAt: now,
            voidedByUserId: ctx.userId,
            voidReason,
            updatedAt: now,
            updatedByUserId: ctx.userId,
          })
          .where(
            and(
              eq(contributions.zoneId, ctx.zoneId),
              inArray(contributions.id, idChunk),
            ),
          );
      }
      auditEvts.push(
        ...buildContributionVoidAudits(
          ctx,
          targetContributionIds,
          voidReason,
          importJobId,
        ),
      );
    }

    // Capture which external ids the rollback freed (snapshot BEFORE the
    // delete) so the audit trail is self-contained. Count and sample via
    // bounded queries rather than pulling a 50k-row rollback into JS.
    const [{ total: freedExternalIdsTotal }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(processedTransactions)
      .where(
        and(
          eq(processedTransactions.zoneId, ctx.zoneId),
          eq(processedTransactions.importJobId, importJobId),
        ),
      );
    const freedExternalIdsSample = (
      await tx
        .select({
          externalTransactionId: processedTransactions.externalTransactionId,
        })
        .from(processedTransactions)
        .where(
          and(
            eq(processedTransactions.zoneId, ctx.zoneId),
            eq(processedTransactions.importJobId, importJobId),
          ),
        )
        .orderBy(processedTransactions.processedAt, processedTransactions.externalTransactionId)
        .limit(AUDIT_SAMPLE_LIMIT)
    ).map((r) => r.externalTransactionId);

    // Free up the external transaction ids so a corrected re-upload can
    // re-record them. The contributions remain (voided), so the audit
    // history is intact.
    await tx
      .delete(processedTransactions)
      .where(
        and(
          eq(processedTransactions.zoneId, ctx.zoneId),
          eq(processedTransactions.importJobId, importJobId),
        ),
      );

    await tx
      .update(importSchedules)
      .set({
        rolledBackAt: now,
        rolledBackByUserId: ctx.userId,
        rolledBackReason: args.reason,
      })
      .where(
        and(
          eq(importSchedules.zoneId, ctx.zoneId),
          eq(importSchedules.importJobId, importJobId),
        ),
      );

    await tx
      .update(importJobs)
      .set({ finishedAt: now, updatedAt: now })
      .where(and(eq(importJobs.zoneId, ctx.zoneId), eq(importJobs.id, importJobId)));

    auditEvts.push({
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "import.rollback",
      entityType: "import_job",
      entityId: importJobId,
      reason: args.reason,
      after: {
        voidedContributions: targetContributionIds.length,
        freedExternalIdsTotal,
        freedExternalIdsSample,
      },
    });
    await writeAuditMany(tx, auditEvts);
    return { voidedContributions: targetContributionIds.length };
  });
}

// ─── Reads ───────────────────────────────────────────────────────────

type ImportJobRow = typeof importJobs.$inferSelect;

function redactImportJob(job: ImportJobRow): ImportJobRow {
  if (!job.errorCode || !job.errorMessage) return job;
  return {
    ...job,
    errorMessage: publicMessageForImportError(job.errorCode, job.errorMessage),
  };
}

export async function listImports(
  database: Database,
  zoneId: string,
  query: ImportListQuery,
  scope: { chapterIds?: string[] } = {},
): Promise<{ items: ImportJobRow[]; total: number }> {
  // Empty allow-list = chapter-scoped user with no chapter access = no rows.
  if (scope.chapterIds && scope.chapterIds.length === 0) {
    return { items: [], total: 0 };
  }
  const conditions = [eq(importJobs.zoneId, zoneId)];
  if (query.status) conditions.push(eq(importJobs.status, query.status));
  if (query.chapterId) {
    // Caller pinned the list to one chapter. The route layer has already
    // validated the chapter is in the zone + the caller can scope to it,
    // so we can apply the filter directly.
    conditions.push(eq(importFiles.chapterId, query.chapterId));
  } else if (scope.chapterIds && scope.chapterIds.length > 0) {
    // Chapter-scoped users only see imports tied to a chapter they can
    // access. Zone-wide imports (chapter_id IS NULL on the file) are
    // hidden from chapter-only readers.
    conditions.push(inArray(importFiles.chapterId, scope.chapterIds));
  }
  const where = and(...conditions);
  const baseQuery = database
    .select({ job: importJobs })
    .from(importJobs)
    .innerJoin(
      importFiles,
      and(
        eq(importJobs.importFileId, importFiles.id),
        eq(importFiles.zoneId, importJobs.zoneId),
      ),
    )
    .where(where);
  const items = (
    await baseQuery
      .orderBy(sql`${importJobs.createdAt} desc`)
      .limit(query.limit)
      .offset(query.offset)
  ).map((r) => redactImportJob(r.job));
  const [{ total }] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(importJobs)
    .innerJoin(
      importFiles,
      and(
        eq(importJobs.importFileId, importFiles.id),
        eq(importFiles.zoneId, importJobs.zoneId),
      ),
    )
    .where(where);
  return { items, total };
}

export async function getImport(
  database: Database,
  zoneId: string,
  id: string,
): Promise<{
  job: ImportJobRow;
  file: typeof importFiles.$inferSelect;
} | null> {
  const [row] = await database
    .select({ job: importJobs, file: importFiles })
    .from(importJobs)
    .innerJoin(
      importFiles,
      and(
        eq(importJobs.importFileId, importFiles.id),
        eq(importFiles.zoneId, importJobs.zoneId),
      ),
    )
    .where(and(eq(importJobs.zoneId, zoneId), eq(importJobs.id, id)))
    .limit(1);
  if (!row) return null;
  return { ...row, job: redactImportJob(row.job) };
}

export async function listImportRows(
  database: Database,
  zoneId: string,
  importJobId: string,
  query: ImportRowListQuery,
): Promise<{
  items: (typeof importRows.$inferSelect & { failures: { code: string; details: unknown }[] })[];
  total: number;
}> {
  const conditions = [
    eq(importRows.zoneId, zoneId),
    eq(importRows.importJobId, importJobId),
  ];
  if (query.matchStatus) conditions.push(eq(importRows.matchStatus, query.matchStatus));
  if (query.validationStatus)
    conditions.push(eq(importRows.validationStatus, query.validationStatus));
  if (query.isDuplicate !== undefined)
    conditions.push(eq(importRows.isDuplicate, query.isDuplicate));
  const where = and(...conditions);
  const items = await database
    .select()
    .from(importRows)
    .where(where)
    .orderBy(importRows.rowNumber)
    .limit(query.limit)
    .offset(query.offset);
  const [{ total }] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(importRows)
    .where(where);
  // Fetch failures for the visible page.
  const ids = items.map((r) => r.id);
  const failureMap = new Map<string, { code: string; details: unknown }[]>();
  if (ids.length > 0) {
    const failureRows = await database
      .select({
        rowId: importRowFailures.rowId,
        code: importRowFailures.failureCode,
        details: importRowFailures.details,
      })
      .from(importRowFailures)
      .where(
        and(
          eq(importRowFailures.zoneId, zoneId),
          inArray(importRowFailures.rowId, ids),
        ),
      );
    for (const f of failureRows) {
      const list = failureMap.get(f.rowId) ?? [];
      list.push({ code: f.code, details: f.details });
      failureMap.set(f.rowId, list);
    }
  }
  // Short-circuit the per-row Map probe when no failures exist for the
  // page; on a 100% clean import we never even allocate the empty array.
  if (failureMap.size === 0) {
    return {
      items: items.map((r) => ({ ...r, failures: [] })),
      total,
    };
  }
  const decorated = items.map((r) => ({ ...r, failures: failureMap.get(r.id) ?? [] }));
  return { items: decorated, total };
}

export const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_transition: 409,
  has_failures: 409,
  parse_failed: 422,
  match_failed: 500,
  persist_failed: 500,
  duplicate_upload: 409,
};

const INTERNAL_ERROR_CODES = new Set(["match_failed", "persist_failed"]);
const INTERNAL_IMPORT_ERROR_MESSAGE = "Import processing failed. Please contact support.";

export function publicMessageForImportError(code: string, message: string): string {
  return INTERNAL_ERROR_CODES.has(code) ? INTERNAL_IMPORT_ERROR_MESSAGE : message;
}

export function errorStatusFor(code: string): number {
  return ERROR_STATUS[code] ?? 400;
}
