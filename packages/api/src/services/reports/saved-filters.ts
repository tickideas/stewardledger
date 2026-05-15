// packages/api/src/services/reports/saved-filters.ts
// Per-user saved-filter persistence for the report registry.
// Hides the Drizzle wire from the route layer; all calls land in a
// transaction with the audit row so a partial-write is impossible.
// RELEVANT FILES: packages/db/src/schema/saved-report-filters.ts, packages/api/src/routes/tenant-reports.ts

import { and, asc, eq, sql } from "drizzle-orm";
import {
  savedReportFilters,
  type SavedReportFilter,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { writeAudit } from "../audit";

interface BaseScope {
  zoneId: string;
  userId: string;
  reportId: string;
}

export interface SavedFilterRow {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toRow(r: SavedReportFilter): SavedFilterRow {
  return {
    id: r.id,
    name: r.name,
    filters: (r.filters as Record<string, unknown>) ?? {},
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export class SavedFilterError extends Error {
  constructor(
    readonly code: "duplicate_name" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

/** List the current user's saved filters for one report. */
export async function listSavedFilters(
  database: Database,
  scope: BaseScope,
): Promise<SavedFilterRow[]> {
  const rows = await database
    .select()
    .from(savedReportFilters)
    .where(
      and(
        eq(savedReportFilters.userId, scope.userId),
        eq(savedReportFilters.zoneId, scope.zoneId),
        eq(savedReportFilters.reportId, scope.reportId),
      ),
    )
    .orderBy(asc(sql`lower(${savedReportFilters.name})`));
  return rows.map(toRow);
}

/**
 * Create one row. Throws `SavedFilterError("duplicate_name")` on
 * the unique-(user,zone,report,lower(name)) collision so the route
 * can return 409 cleanly.
 */
export async function createSavedFilter(
  database: Database,
  scope: BaseScope,
  input: { name: string; filters: unknown },
): Promise<SavedFilterRow> {
  try {
    return await database.transaction(async (tx) => {
      const [row] = await tx
        .insert(savedReportFilters)
        .values({
          zoneId: scope.zoneId,
          userId: scope.userId,
          reportId: scope.reportId,
          name: input.name,
          filters: (input.filters ?? {}) as never,
        })
        .returning();
      await writeAudit(tx, {
        zoneId: scope.zoneId,
        actorUserId: scope.userId,
        action: "saved_report_filter.create",
        entityType: "saved_report_filter",
        entityId: row.id,
        after: {
          reportId: scope.reportId,
          name: row.name,
          filters: row.filters,
        },
      });
      return toRow(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new SavedFilterError(
        "duplicate_name",
        "A saved filter with that name already exists for this report.",
      );
    }
    throw err;
  }
}

/**
 * Patch one row. Either `name`, `filters`, or both may be supplied;
 * the route already enforces "at least one" via Zod. Rename collisions
 * map to `duplicate_name`. Missing rows map to `not_found`.
 */
export async function updateSavedFilter(
  database: Database,
  scope: BaseScope & { id: string },
  patch: { name?: string; filters?: unknown },
): Promise<SavedFilterRow> {
  try {
    return await database.transaction(async (tx) => {
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) update.name = patch.name;
      if (patch.filters !== undefined)
        update.filters = (patch.filters ?? {}) as never;
      const [row] = await tx
        .update(savedReportFilters)
        .set(update)
        .where(
          and(
            eq(savedReportFilters.id, scope.id),
            eq(savedReportFilters.userId, scope.userId),
            eq(savedReportFilters.zoneId, scope.zoneId),
            eq(savedReportFilters.reportId, scope.reportId),
          ),
        )
        .returning();
      if (!row) {
        throw new SavedFilterError("not_found", "Saved filter not found");
      }
      await writeAudit(tx, {
        zoneId: scope.zoneId,
        actorUserId: scope.userId,
        action: "saved_report_filter.update",
        entityType: "saved_report_filter",
        entityId: row.id,
        after: {
          reportId: scope.reportId,
          name: row.name,
          filters: row.filters,
        },
      });
      return toRow(row);
    });
  } catch (err) {
    if (err instanceof SavedFilterError) throw err;
    if (isUniqueViolation(err)) {
      throw new SavedFilterError(
        "duplicate_name",
        "A saved filter with that name already exists for this report.",
      );
    }
    throw err;
  }
}

export async function deleteSavedFilter(
  database: Database,
  scope: BaseScope & { id: string },
): Promise<void> {
  await database.transaction(async (tx) => {
    const [row] = await tx
      .delete(savedReportFilters)
      .where(
        and(
          eq(savedReportFilters.id, scope.id),
          eq(savedReportFilters.userId, scope.userId),
          eq(savedReportFilters.zoneId, scope.zoneId),
          eq(savedReportFilters.reportId, scope.reportId),
        ),
      )
      .returning();
    if (!row) {
      throw new SavedFilterError("not_found", "Saved filter not found");
    }
    await writeAudit(tx, {
      zoneId: scope.zoneId,
      actorUserId: scope.userId,
      action: "saved_report_filter.delete",
      entityType: "saved_report_filter",
      entityId: row.id,
      before: {
        reportId: scope.reportId,
        name: row.name,
        filters: row.filters,
      },
    });
  });
}

/** Postgres unique-violation SQLSTATE. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === "23505" || cause === "23505";
}
