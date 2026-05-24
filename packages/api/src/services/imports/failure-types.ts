// packages/api/src/services/imports/failure-types.ts
// Phase 6 — platform-default catalog of import row failure types.
// Per-zone overrides live in `import_failure_types` (zone_id not null);
// service code looks up by code and falls back to platform default.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { importFailureTypes } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

export const PLATFORM_FAILURE_TYPES = [
  {
    code: "MEMBER_NOT_FOUND",
    description: "No active member matches the row's member reference or name.",
  },
  {
    code: "MEMBER_AMBIGUOUS",
    description: "Multiple members share the row's name; manual selection required.",
  },
  {
    code: "CHAPTER_NOT_FOUND",
    description: "No active chapter matches the row's chapter reference.",
  },
  {
    code: "CHAPTER_REQUIRED",
    description:
      "Row did not specify a chapter and the import file is not scoped to a single chapter.",
  },
  {
    code: "GIVING_TYPE_NOT_FOUND",
    description: "No active giving type matches the row's giving type label.",
  },
  {
    code: "GIVING_TYPE_REQUIRED",
    description: "Row is missing a giving type and no default is configured.",
  },
  {
    code: "INVALID_AMOUNT",
    description: "Amount is missing or could not be parsed as a positive number.",
  },
  {
    code: "INVALID_DATE",
    description:
      "Contribution date is missing or could not be parsed. The parser" +
      " defaults to UK-style DD/MM/YYYY when the separator is `/`, `-`," +
      " or `.`; an ambiguous US-style MM/DD/YYYY value will silently flip" +
      " day/month. Use ISO YYYY-MM-DD to disambiguate, or set the per-zone" +
      " date locale (Phase 6 polish).",
  },
  {
    code: "CURRENCY_MISMATCH",
    description: "Row currency does not match the destination account currency.",
  },
  {
    code: "DUPLICATE",
    description:
      "An earlier import already recorded this external transaction id for this zone.",
  },
  {
    code: "PERIOD_NOT_FOUND",
    description: "No giving period covers the row's contribution date.",
  },
  {
    code: "SERVICE_EVENT_NOT_FOUND",
    description: "No service event matches the row's service event id or service type/date.",
  },
  {
    code: "SERVICE_EVENT_REQUIRED",
    description: "Row is missing a service event and the import was not scoped to one.",
  },
  {
    code: "SERVICE_EVENT_AMBIGUOUS",
    description: "Multiple service events match the row's chapter, service date, and service type.",
  },
  {
    code: "SERVICE_EVENT_CHAPTER_MISMATCH",
    description: "The resolved service event belongs to a different chapter than the row.",
  },
] as const;

export type FailureCode = (typeof PLATFORM_FAILURE_TYPES)[number]["code"];

/**
 * Insert the platform catalog rows (zone_id = null) if they aren't there
 * yet. Idempotent; safe to call from every bootstrap path. Returns a map
 * of code → id keyed for the resolve helper.
 *
 * Race safety: the `import_failure_types_platform_code_unique` partial
 * index (`unique(code) where zone_id is null`) is the canonical guard.
 * `onConflictDoNothing` keyed on `code` here would also collide with
 * per-zone overrides, so we target the partial index explicitly.
 */
export async function ensurePlatformFailureTypes(database: Db): Promise<Map<string, string>> {
  await database
    .insert(importFailureTypes)
    .values(
      PLATFORM_FAILURE_TYPES.map((t) => ({
        zoneId: null,
        code: t.code,
        description: t.description,
      })),
    )
    .onConflictDoNothing({
      target: importFailureTypes.code,
      where: sql`${importFailureTypes.zoneId} is null`,
    });
  const rows = await database
    .select({ id: importFailureTypes.id, code: importFailureTypes.code })
    .from(importFailureTypes)
    .where(isNull(importFailureTypes.zoneId));
  return new Map(rows.map((r) => [r.code, r.id]));
}

/**
 * Resolve a failure type id for a (zoneId, code) pair. Per-zone overrides
 * win; falls back to the platform-default catalog row. Throws if no row
 * exists at either level so a typo in `FailureCode` is caught immediately.
 */
export async function resolveFailureTypeId(
  database: Db,
  zoneId: string,
  code: FailureCode,
): Promise<string> {
  const rows = await database
    .select({ id: importFailureTypes.id, zoneId: importFailureTypes.zoneId })
    .from(importFailureTypes)
    .where(
      and(
        eq(importFailureTypes.code, code),
        or(eq(importFailureTypes.zoneId, zoneId), isNull(importFailureTypes.zoneId)),
      ),
    );
  if (rows.length === 0) {
    // Lazy-bootstrap platform defaults if a fresh DB never ran
    // `ensurePlatformFailureTypes`.
    await ensurePlatformFailureTypes(database);
    const refreshed = await database
      .select({ id: importFailureTypes.id, zoneId: importFailureTypes.zoneId })
      .from(importFailureTypes)
      .where(
        and(
          eq(importFailureTypes.code, code),
          or(eq(importFailureTypes.zoneId, zoneId), isNull(importFailureTypes.zoneId)),
        ),
      );
    if (refreshed.length === 0) {
      throw new Error(`No failure_type row for code ${code}`);
    }
    return pickFailureRow(refreshed).id;
  }
  return pickFailureRow(rows).id;
}

function pickFailureRow<T extends { zoneId: string | null }>(rows: readonly T[]): T {
  // Per-zone overrides win; copy before sorting so callers don't get a
  // surprise mutation of their array (and so accidentally passing in a
  // shared lookup buffer is safe).
  const sorted = [...rows].sort(
    (a, b) => (a.zoneId === null ? 1 : 0) - (b.zoneId === null ? 1 : 0),
  );
  return sorted[0];
}

