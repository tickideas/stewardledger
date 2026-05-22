// packages/api/src/services/dashboards/queries.ts
// Phase 7 — shared aggregation primitives for dashboard services.
// The zone and chapter dashboards both need: load the zone's
// timezone, count members in scope, sum posted+reversed contribution
// lines per currency over a date window. Same SQL, same money math,
// same sign-convention invariants — keep one canonical implementation
// here so the dashboards can't drift.
// RELEVANT FILES: packages/api/src/services/dashboards/zone-dashboard.ts, packages/api/src/services/dashboards/chapter-dashboard.ts, packages/api/src/services/dashboards/calendar.ts

import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { contributionLines, contributions, members, zones } from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import type { CurrencyTotal } from "./zone-dashboard";
import type { DateBounds } from "./calendar";

/**
 * Load the zone's IANA default timezone. Dashboard services use this
 * before computing the calendar window so a tenant 12h off UTC sees
 * their own civil month. Tenant middleware would have rejected the
 * request before we get here; a missing row is therefore a developer
 * error worth surfacing loudly.
 */
export async function loadZoneTimeZone(
  database: Database,
  zoneId: string,
): Promise<string> {
  const [row] = await database
    .select({ defaultTimeZone: zones.defaultTimeZone })
    .from(zones)
    .where(eq(zones.id, zoneId))
    .limit(1);
  if (!row) {
    throw new Error(`zone ${zoneId} not found while loading dashboard`);
  }
  return row.defaultTimeZone;
}

/**
 * Count members in scope. Zone-wide by default; pass `chapterId` to
 * scope to one chapter. Excludes soft-deleted members
 * (`deleted_at IS NOT NULL`). Returns total + active + inactive in a
 * single round trip via a `FILTER (WHERE ...)` aggregate.
 */
export async function countMembers(
  database: Database,
  zoneId: string,
  options: { chapterId?: string; chapterIds?: string[] } = {},
): Promise<{ total: number; active: number; inactive: number }> {
  const conditions: SQL[] = [eq(members.zoneId, zoneId), isNull(members.deletedAt)];
  if (options.chapterId) conditions.push(eq(members.chapterId, options.chapterId));
  if (options.chapterIds) conditions.push(inArray(members.chapterId, options.chapterIds));
  const [row] = await database
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${members.isActive} = true)::int`,
    })
    .from(members)
    .where(and(...conditions));
  const total = row?.total ?? 0;
  const active = row?.active ?? 0;
  return { total, active, inactive: total - active };
}

/**
 * Sum posted + reversed contribution-line amounts per currency over
 * `bounds`. Reversal lines carry negative amounts (DOMAIN-MODEL §6),
 * so a `posted + reversed` SUM nets to zero for a fully-reversed pair
 * without any client-side bookkeeping. Pass `chapterId` to scope to
 * one chapter; otherwise the sum spans the entire zone.
 *
 * Zero-total currency buckets are dropped (a reversal that exactly
 * cancels its original shouldn't appear in the per-currency list).
 */
export async function sumPostedByCurrency(
  database: Database,
  zoneId: string,
  bounds: DateBounds,
  options: { chapterId?: string; chapterIds?: string[] } = {},
): Promise<CurrencyTotal[]> {
  const conditions: SQL[] = [
    eq(contributions.zoneId, zoneId),
    sql`${contributions.contributionDate} >= ${bounds.start}::date`,
    sql`${contributions.contributionDate} < ${bounds.endExclusive}::date`,
    sql`${contributions.status} in ('posted', 'reversed')`,
  ];
  if (options.chapterId) conditions.push(eq(contributions.chapterId, options.chapterId));
  if (options.chapterIds) conditions.push(inArray(contributions.chapterId, options.chapterIds));
  const rows = await database
    .select({
      currencyCode: contributionLines.currencyCode,
      total: sql<string>`sum(${contributionLines.amount})::text`,
    })
    .from(contributionLines)
    .innerJoin(
      contributions,
      and(
        eq(contributionLines.zoneId, contributions.zoneId),
        eq(contributionLines.contributionId, contributions.id),
      ),
    )
    .where(and(...conditions))
    .groupBy(contributionLines.currencyCode);
  return rows
    .map((r) => ({ currencyCode: r.currencyCode, total: new Decimal(r.total).toFixed(4) }))
    .filter((r) => !new Decimal(r.total).isZero())
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}
