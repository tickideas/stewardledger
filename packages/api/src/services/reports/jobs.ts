// packages/api/src/services/reports/jobs.ts
// Phase 7 \u2014 async report generation: persistence + run logic.
//
// Service responsibilities:
//   1. queueJob(ctx, reportId, format, filters)
//        \u2014 persist a `report_jobs` row in `queued`, audited.
//   2. listJobs(ctx, opts)
//        \u2014 caller's most-recent jobs in this zone.
//   3. getJobForReader(ctx, jobId)
//        \u2014 single job; 404 unless owned by the caller.
//   4. claimNextJob(database)
//        \u2014 worker side: atomically flip the oldest queued row to
//          running and return it. SELECT FOR UPDATE SKIP LOCKED so
//          multiple processes can co-exist.
//   5. runJob(database, jobId)
//        \u2014 worker side: rebuild the user's AuthorizedContext from
//          the persisted user_id + zone_id, re-validate filters,
//          re-check spec.accessCheck, fetch + render, persist the
//          artefact to object storage, mark the row.
//
// RELEVANT FILES: packages/db/src/schema/report-jobs.ts, packages/api/src/services/reports/jobs-worker.ts, packages/api/src/services/storage.ts

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  chapters,
  reportJobs,
  roles,
  user as userTable,
  userRoleBindings,
  zones,
  type ReportJob,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import type { AuthorizedContext } from "@stewardledger/shared";
import { writeAudit } from "../audit";
import { storage } from "../storage";
import { canExportReports, canReadReports } from "./access";
import { loadReportBranding } from "./branding";
import { renderBrandedTablePdf } from "./pdf/branded-table";
import { getReport } from "./registry";
import {
  parseReportFilters,
  ReportError,
  type ReportColumn,
  type ReportFetchResult,
  type ReportSpec,
} from "./types";

export type ReportJobFormat = "xlsx" | "pdf";
export type ReportJobStatus = "queued" | "running" | "completed" | "failed";

/** Default expiry for a completed artefact. PR 2 cleanup will prune. */
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export class JobError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "invalid_filters" | "invalid_format",
    message: string,
  ) {
    super(message);
  }
}

interface QueueJobInput {
  reportId: string;
  format: ReportJobFormat;
  /** Raw filters from the request body. Re-validated against the spec. */
  filters: unknown;
}

export interface JobSummary {
  id: string;
  reportId: string;
  format: ReportJobFormat;
  status: ReportJobStatus;
  rowCount: number | null;
  byteCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function toSummary(r: ReportJob): JobSummary {
  return {
    id: r.id,
    reportId: r.reportId,
    format: r.format as ReportJobFormat,
    status: r.status as ReportJobStatus,
    rowCount: r.rowCount,
    byteCount: r.byteCount,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}

/**
 * Validate the incoming filter payload against the spec's Zod schema,
 * then enqueue. Audits `report.job.create`.
 *
 * Caller-side access checks (canReadReports, spec.accessCheck) run
 * at the **route** layer before this is reached \u2014 the route owns
 * the response envelope, this layer owns the persistence.
 */
export async function queueJob(
  database: Database,
  ctx: AuthorizedContext,
  input: QueueJobInput,
): Promise<JobSummary> {
  if (input.format !== "xlsx" && input.format !== "pdf") {
    throw new JobError("invalid_format", "format must be 'xlsx' or 'pdf'");
  }
  const spec = getReport(input.reportId);
  let parsedFilters: unknown;
  try {
    parsedFilters = parseReportFilters(spec, input.filters ?? {});
  } catch (err) {
    if (err instanceof ReportError) {
      throw new JobError("invalid_filters", err.message);
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_MS);
  const result = await database.transaction(async (tx) => {
    const [row] = await tx
      .insert(reportJobs)
      .values({
        zoneId: ctx.zoneId,
        userId: ctx.userId,
        reportId: input.reportId,
        format: input.format,
        filters: (parsedFilters ?? {}) as never,
        expiresAt,
      })
      .returning();
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "report.job.create",
      entityType: "report_job",
      entityId: row.id,
      after: {
        reportId: input.reportId,
        format: input.format,
        filters: parsedFilters,
      },
    });
    return row;
  });
  return toSummary(result);
}

/** Caller's recent jobs in this zone, newest first. */
export async function listJobs(
  database: Database,
  ctx: AuthorizedContext,
  opts: { reportId?: string; limit?: number } = {},
): Promise<JobSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conditions = [
    eq(reportJobs.zoneId, ctx.zoneId),
    eq(reportJobs.userId, ctx.userId),
  ];
  if (opts.reportId) conditions.push(eq(reportJobs.reportId, opts.reportId));
  const rows = await database
    .select()
    .from(reportJobs)
    .where(and(...conditions))
    .orderBy(desc(reportJobs.createdAt))
    .limit(limit);
  return rows.map(toSummary);
}

/**
 * Read a single job. Returns null when the job does not exist OR is
 * owned by another user, so cross-user / cross-tenant probes look
 * identical to "not found".
 */
export async function getJobForReader(
  database: Database,
  ctx: AuthorizedContext,
  jobId: string,
): Promise<ReportJob | null> {
  const [row] = await database
    .select()
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.id, jobId),
        eq(reportJobs.zoneId, ctx.zoneId),
        eq(reportJobs.userId, ctx.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Worker-side: atomically claim the oldest queued row. Returns the
 * claimed job or `null` when the queue is empty. The CTE pattern
 * (FOR UPDATE SKIP LOCKED inside a sub-select used by the UPDATE)
 * is the canonical multi-process-safe shape \u2014 if N workers race,
 * each gets a different row.
 */
export async function claimNextJob(database: Database): Promise<ReportJob | null> {
  const claimed = await database.execute(sql`
    update report_jobs
       set status = 'running',
           started_at = now(),
           updated_at = now()
     where id = (
       select id from report_jobs
        where status = 'queued'
        order by created_at asc
        limit 1
        for update skip locked
     )
    returning *
  `);
  // postgres-js returns rows on `.execute(sql...)` already.
  const rows = (claimed as unknown as { rows?: unknown[] }).rows ?? (claimed as unknown as unknown[]);
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length === 0) return null;
  const r = arr[0] as Record<string, unknown>;
  return hydrate(r);
}

/**
 * Map the postgres-js raw row (snake-case columns) into the camel-case
 * shape Drizzle produces. The `claimNextJob` path uses raw SQL because
 * Drizzle doesn't fluently express FOR UPDATE SKIP LOCKED inside an
 * UPDATE \u2026 RETURNING; this helper keeps the rest of the worker on
 * the same row type.
 */
function hydrate(r: Record<string, unknown>): ReportJob {
  return {
    id: r.id as string,
    zoneId: r.zone_id as string,
    userId: r.user_id as string,
    reportId: r.report_id as string,
    filters: r.filters as never,
    format: r.format as string,
    status: r.status as string,
    storageKey: (r.storage_key as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    rowCount: (r.row_count as number | null) ?? null,
    byteCount: (r.byte_count as number | null) ?? null,
    expiresAt: r.expires_at as Date,
    createdAt: r.created_at as Date,
    startedAt: (r.started_at as Date | null) ?? null,
    completedAt: (r.completed_at as Date | null) ?? null,
    updatedAt: r.updated_at as Date,
  };
}

/**
 * Re-resolve the user's AuthorizedContext as it stands *now* (not
 * as it stood when the job was queued). A role revocation between
 * queue + run must not be honoured \u2014 the worker re-checks the
 * spec's accessCheck against the live bindings.
 *
 * Returns `null` when the user has no bindings + isn't a platform
 * admin; that maps to a 403-style failure in `runJob`.
 */
async function resolveAuthAtRunTime(
  database: Database,
  zoneId: string,
  userId: string,
): Promise<AuthorizedContext | null> {
  const [userRow] = await database
    .select({ isSuperAdmin: userTable.isSuperAdmin })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!userRow) return null;
  const bindings = await database
    .select({
      chapterId: userRoleBindings.chapterId,
      roleCode: roles.code,
    })
    .from(userRoleBindings)
    .innerJoin(roles, eq(userRoleBindings.roleId, roles.id))
    .where(
      and(
        eq(userRoleBindings.userId, userId),
        eq(userRoleBindings.zoneId, zoneId),
        isNull(userRoleBindings.revokedAt),
      ),
    );
  if (bindings.length === 0 && !userRow.isSuperAdmin) return null;
  const [zoneRow] = await database
    .select({ regionId: zones.regionId })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  return {
    userId,
    zoneId,
    regionId: zoneRow?.regionId ?? null,
    roleCodes: Array.from(new Set(bindings.map((b) => b.roleCode))),
    chapterIds: Array.from(
      new Set(bindings.map((b) => b.chapterId).filter((c): c is string => c !== null)),
    ),
    // TODO(groups-hierarchy Task 9): query user_role_bindings.group_id and populate.
    groupIds: [],
    isPlatformAdmin: userRow.isSuperAdmin,
  };
}

function storageKeyFor(zoneId: string, jobId: string, format: ReportJobFormat): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${zoneId}/reports/${yyyy}/${mm}/${jobId}.${format}`;
}

interface RunOutcome {
  status: "completed" | "failed";
  storageKey?: string;
  rowCount?: number;
  byteCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Run one claimed job to completion. Catches every error so the
 * worker loop never crashes; failures land on the row as
 * `errorCode` + `errorMessage`. The chapters import is unused but
 * kept so the unused-import lint stays quiet when the function
 * grows.
 */
export async function runClaimedJob(
  database: Database,
  job: ReportJob,
): Promise<RunOutcome> {
  void chapters;
  try {
    const ctx = await resolveAuthAtRunTime(database, job.zoneId, job.userId);
    if (!ctx) {
      return {
        status: "failed",
        errorCode: "forbidden",
        errorMessage: "User no longer has access to this zone",
      };
    }
    if (!canReadReports(ctx)) {
      return {
        status: "failed",
        errorCode: "forbidden",
        errorMessage: "Caller cannot read reports",
      };
    }
    if (!canExportReports(ctx)) {
      return {
        status: "failed",
        errorCode: "forbidden_export",
        errorMessage: "Export requires a finance role",
      };
    }

    let spec: ReportSpec<unknown, unknown>;
    try {
      spec = getReport(job.reportId);
    } catch (err) {
      const code =
        err instanceof ReportError ? err.code : "spec_resolution_failed";
      const message = err instanceof Error ? err.message : "Spec lookup failed";
      return { status: "failed", errorCode: code, errorMessage: message };
    }

    let filters: unknown;
    try {
      filters = parseReportFilters(spec, job.filters);
    } catch (err) {
      const code =
        err instanceof ReportError ? err.code : "invalid_filters";
      const message =
        err instanceof Error ? err.message : "Filter re-validation failed";
      return { status: "failed", errorCode: code, errorMessage: message };
    }

    if (spec.accessCheck) {
      const denial = spec.accessCheck(ctx, filters);
      if (denial) {
        return {
          status: "failed",
          errorCode: denial,
          errorMessage: "Spec-level access check denied",
        };
      }
    }

    const branding = await loadReportBranding(database, ctx.zoneId);
    const result: ReportFetchResult<unknown> = await spec.fetch(database, ctx, filters);
    const columns: ReportColumn[] = result.columns ?? spec.columns(filters);
    let bytes: Uint8Array;
    if (job.format === "xlsx") {
      bytes = await spec.excel(
        result.rows,
        result.subtotals,
        filters,
        branding,
        result.meta,
      );
    } else {
      bytes = spec.pdf
        ? await spec.pdf(
            result.rows,
            result.subtotals,
            filters,
            branding,
            columns,
            result.meta,
          )
        : await renderBrandedTablePdf({
            reportTitle: spec.title,
            filterSummary: spec.filterSummary
              ? spec.filterSummary(filters)
              : "",
            columns,
            rows: assertObjectRows(result.rows),
            subtotals: result.subtotals,
            branding,
          });
    }

    const key = storageKeyFor(job.zoneId, job.id, job.format as ReportJobFormat);
    await storage().put(key, bytes);
    return {
      status: "completed",
      storageKey: key,
      rowCount: result.rows.length,
      byteCount: bytes.length,
    };
  } catch (err) {
    return {
      status: "failed",
      errorCode: "crash",
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Persist the outcome of a run on the row + write the audit event.
 * Split from `runClaimedJob` so the test layer can call it in
 * isolation and assert state transitions without an inline DB
 * timer.
 */
export async function finalizeJob(
  database: Database,
  job: ReportJob,
  outcome: RunOutcome,
): Promise<JobSummary> {
  // Anchor the retention window to *completion* time, not queue
  // time. Jobs that sit in the queue for hours would otherwise burn
  // through most of their 7-day window before the artefact even
  // exists. Failed rows keep their original expiresAt — there is no
  // artefact to retain, and the row itself stays for audit.
  const completedAt = new Date();
  const expiresAt =
    outcome.status === "completed"
      ? new Date(completedAt.getTime() + DEFAULT_EXPIRY_MS)
      : job.expiresAt;
  const result = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(reportJobs)
      .set({
        status: outcome.status,
        storageKey: outcome.storageKey ?? null,
        rowCount: outcome.rowCount ?? null,
        byteCount: outcome.byteCount ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        completedAt,
        expiresAt,
        updatedAt: completedAt,
      })
      .where(eq(reportJobs.id, job.id))
      .returning();
    await writeAudit(tx, {
      zoneId: job.zoneId,
      actorUserId: job.userId,
      action:
        outcome.status === "completed"
          ? "report.job.complete"
          : "report.job.fail",
      entityType: "report_job",
      entityId: job.id,
      after: {
        reportId: job.reportId,
        format: job.format,
        status: outcome.status,
        rowCount: outcome.rowCount ?? null,
        byteCount: outcome.byteCount ?? null,
        errorCode: outcome.errorCode ?? null,
      },
    });
    return row;
  });
  return toSummary(result);
}

/**
 * End-to-end: claim, run, finalize. Returns `null` when there's
 * nothing in the queue (worker loop sleeps).
 */
export async function runOnce(database: Database): Promise<JobSummary | null> {
  const job = await claimNextJob(database);
  if (!job) return null;
  const outcome = await runClaimedJob(database, job);
  return finalizeJob(database, job, outcome);
}

/**
 * Same shape as `tenant-reports.ts`' helper: a defensive guard for
 * the generic PDF renderer's contract.
 */
function assertObjectRows(rows: unknown[]): Array<Record<string, unknown>> {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    throw new Error(
      "Generic PDF renderer requires plain object rows; spec returned non-object rows.",
    );
  }
  return rows as Array<Record<string, unknown>>;
}

/**
 * Re-export drizzle helpers for the worker's `or` query \u2014 there's
 * only one such case and inlining it here keeps the worker module
 * tiny. Used by the test harness too.
 */
export { asc, desc };
