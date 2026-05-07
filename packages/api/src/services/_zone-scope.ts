// packages/api/src/services/_zone-scope.ts
// Shared helpers for asserting that a referenced row exists inside a zone.
// Used by every write-path service that touches zone-scoped FKs to keep
// AGENTS hard rule #5 (no cross-tenant queries from tenant code) honest.

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@stewardledger/db";

// Drizzle table types are awkward to express precisely without leaking
// schema internals into every caller, so we use a structural minimum that
// drizzle's `select`, `from`, `where` accept.
type ZoneScopedTable = {
  id: unknown;
  zoneId: unknown;
};

/**
 * Returns `true` iff a row with the given `id` exists in `table` and is
 * scoped to `zoneId`. Single-id helper kept for legacy call-sites; prefer
 * `findInZone` / `assertAllExistInZone` for batch checks.
 */
export async function existsInZone<T extends ZoneScopedTable>(
  database: Db,
  table: T,
  zoneId: string,
  id: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: table.id as never })
    .from(table as never)
    .where(and(eq(table.zoneId as never, zoneId), eq(table.id as never, id)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Bulk variant: returns the set of ids that exist in the zone. Caller
 * diffs against the requested set. One round-trip per table regardless of
 * how many ids are passed.
 */
export async function findInZone<T extends ZoneScopedTable>(
  database: Db,
  table: T,
  zoneId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const distinct = Array.from(new Set(ids));
  const rows = (await database
    .select({ id: table.id as never })
    .from(table as never)
    .where(
      and(eq(table.zoneId as never, zoneId), inArray(table.id as never, distinct)),
    )) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Throws `errorFactory(missingId)` for the first id that isn't in the
 * zone. Returns silently when every id is present (or when `ids` is
 * empty). One round-trip.
 */
export async function assertAllExistInZone<T extends ZoneScopedTable>(
  database: Db,
  table: T,
  zoneId: string,
  ids: string[],
  errorFactory: (missingId: string) => Error,
): Promise<void> {
  if (ids.length === 0) return;
  const found = await findInZone(database, table, zoneId, ids);
  for (const id of ids) {
    if (!found.has(id)) throw errorFactory(id);
  }
}
