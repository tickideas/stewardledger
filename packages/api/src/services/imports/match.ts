// packages/api/src/services/imports/match.ts
// Phase 6 — row matching. Turns parsed rows into resolved foreign keys
// (memberId, chapterId, givingTypeId, ...) and a `validation_status`.
//
// Strategy:
//   • One pass loads zone-wide lookup maps so the per-row work is hash
//     lookups, not SQL round trips (the canonical 5000-row import must
//     fit in <60s).
//   • Member resolution: prefer reference_code, fall back to a unique
//     full-name match within the row's chapter (or globally if the row
//     omits a chapter and the file is single-chapter).
//   • Currency: row.currencyCode if set; else the zone default.
//   • Period: derived from contributionDate via giving_periods.
//   • Duplicate detection: by (zone_id, external_transaction_id) against
//     `processed_transactions`. Matched rows that hit are marked
//     `is_duplicate=true` and excluded from commit.

import Decimal from "decimal.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  accounts,
  chapters,
  givingPeriods,
  givingTypes,
  importRowFailures,
  importRows,
  members,
  paymentMethods,
  processedTransactions,
  serviceEvents,
  serviceTypes,
  zones,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";
import { resolveFailureTypeId, type FailureCode } from "./failure-types";
import type { ParsedRow } from "./parsers";

const BULK_WRITE_CHUNK = 1_000;
function chunksOf<T>(items: readonly T[], size = BULK_WRITE_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export interface MatchContext {
  zoneId: string;
  fileChapterId: string | null;
  fileServiceEventId: string | null;
}

export interface MatchedRow {
  rowNumber: number;
  raw: Record<string, string>;
  parsed: ParsedRow["parsed"];
  // Resolved FK columns (null when the matcher couldn't fix one).
  memberId: string | null;
  chapterId: string | null;
  givingTypeId: string | null;
  givingPeriodId: string | null;
  accountId: string | null;
  paymentMethodId: string | null;
  serviceEventId: string | null;
  currencyCode: string | null;
  externalTransactionId: string | null;
  // Outcome.
  matchStatus: "matched" | "partial" | "unmatched";
  validationStatus: "valid" | "invalid";
  isDuplicate: boolean;
  duplicateOfContributionId: string | null;
  failures: { code: FailureCode; details?: unknown }[];
}

interface ZoneLookups {
  defaultCurrencyCode: string;
  chapterByRef: Map<string, string>;
  membersByRef: Map<string, { id: string; chapterId: string | null }>;
  /** Map<lower(fullName), Array<{id, chapterId}>>. Multiple → ambiguous. */
  membersByName: Map<string, { id: string; chapterId: string | null }[]>;
  givingTypeByName: Map<string, { id: string; accountId: string | null }>;
  givingTypeByShortCode: Map<string, { id: string; accountId: string | null }>;
  paymentMethodByCode: Map<string, string>;
  serviceEventById: Map<string, { id: string; chapterId: string | null }>;
  serviceEventByKey: Map<string, { id: string; chapterId: string | null }[]>;
  /** Map<accountId, currencyCode>. The id is the key; storing it again in
   * the value was redundant. */
  accountById: Map<string, string>;
}

async function loadZoneLookups(database: Db, zoneId: string): Promise<ZoneLookups> {
  const [
    [zone],
    chapterRows,
    memberRows,
    givingTypeRows,
    paymentMethodRows,
    accountRows,
    serviceEventRows,
  ] = await Promise.all([
    database
      .select({ defaultCurrencyCode: zones.defaultCurrencyCode })
      .from(zones)
      .where(eq(zones.id, zoneId))
      .limit(1),
    database
      .select({
        id: chapters.id,
        referenceCode: chapters.referenceCode,
      })
      .from(chapters)
      .where(and(eq(chapters.zoneId, zoneId), isNull(chapters.deletedAt))),
    database
      .select({
        id: members.id,
        referenceCode: members.referenceCode,
        chapterId: members.chapterId,
        fullName: members.fullName,
      })
      .from(members)
      .where(and(eq(members.zoneId, zoneId), isNull(members.deletedAt))),
    database
      .select({
        id: givingTypes.id,
        name: givingTypes.name,
        shortCode: givingTypes.shortCode,
        accountId: givingTypes.accountId,
      })
      .from(givingTypes)
      .where(eq(givingTypes.zoneId, zoneId)),
    database
      .select({
        id: paymentMethods.id,
        code: paymentMethods.code,
      })
      .from(paymentMethods)
      .where(eq(paymentMethods.zoneId, zoneId)),
    database
      .select({
        id: accounts.id,
        currencyCode: accounts.currencyCode,
      })
      .from(accounts)
      .where(eq(accounts.zoneId, zoneId)),
    database
      .select({
        id: serviceEvents.id,
        chapterId: serviceEvents.chapterId,
        serviceDate: serviceEvents.serviceDate,
        serviceTypeName: serviceTypes.name,
        serviceTypeShortCode: serviceTypes.shortCode,
      })
      .from(serviceEvents)
      .innerJoin(
        serviceTypes,
        and(
          eq(serviceTypes.zoneId, serviceEvents.zoneId),
          eq(serviceTypes.id, serviceEvents.serviceTypeId),
        ),
      )
      .where(eq(serviceEvents.zoneId, zoneId)),
  ]);

  if (!zone) {
    throw new Error(`Zone ${zoneId} missing during match`);
  }
  const chapterByRef = new Map(chapterRows.map((r) => [r.referenceCode.toLowerCase(), r.id]));
  const membersByRef = new Map(
    memberRows.map((r) => [r.referenceCode.toLowerCase(), { id: r.id, chapterId: r.chapterId }]),
  );
  const membersByName = new Map<string, { id: string; chapterId: string | null }[]>();
  for (const m of memberRows) {
    const key = (m.fullName ?? "").trim().toLowerCase();
    if (!key) continue;
    const list = membersByName.get(key) ?? [];
    list.push({ id: m.id, chapterId: m.chapterId });
    membersByName.set(key, list);
  }
  const givingTypeByName = new Map(
    givingTypeRows.map((r) => [r.name.toLowerCase(), { id: r.id, accountId: r.accountId }]),
  );
  const givingTypeByShortCode = new Map(
    givingTypeRows
      .filter((r) => r.shortCode != null)
      .map((r) => [String(r.shortCode).toLowerCase(), { id: r.id, accountId: r.accountId }]),
  );
  const paymentMethodByCode = new Map(
    paymentMethodRows.map((r) => [r.code.toLowerCase(), r.id]),
  );
  const accountById = new Map(accountRows.map((r) => [r.id, r.currencyCode]));
  const serviceEventById = new Map(
    serviceEventRows.map((r) => [r.id.toLowerCase(), { id: r.id, chapterId: r.chapterId }]),
  );
  const serviceEventByKey = new Map<string, { id: string; chapterId: string | null }[]>();
  for (const event of serviceEventRows) {
    const date = String(event.serviceDate);
    const typeKeys = [event.serviceTypeName, event.serviceTypeShortCode]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase());
    for (const typeKey of typeKeys) {
      for (const chapterKey of [event.chapterId ?? "", "*"]) {
        const key = `${chapterKey}|${date}|${typeKey}`;
        const list = serviceEventByKey.get(key) ?? [];
        list.push({ id: event.id, chapterId: event.chapterId });
        serviceEventByKey.set(key, list);
      }
    }
  }
  return {
    defaultCurrencyCode: zone.defaultCurrencyCode,
    chapterByRef,
    membersByRef,
    membersByName,
    givingTypeByName,
    givingTypeByShortCode,
    paymentMethodByCode,
    accountById,
    serviceEventById,
    serviceEventByKey,
  };
}

async function loadDuplicateMap(
  database: Db,
  zoneId: string,
  externalIds: string[],
): Promise<Map<string, string | null>> {
  if (externalIds.length === 0) return new Map();
  const distinct = Array.from(new Set(externalIds));
  const rows = await database
    .select({
      externalTransactionId: processedTransactions.externalTransactionId,
      contributionId: processedTransactions.contributionId,
    })
    .from(processedTransactions)
    .where(
      and(
        eq(processedTransactions.zoneId, zoneId),
        inArray(processedTransactions.externalTransactionId, distinct),
      ),
    );
  return new Map(rows.map((r) => [r.externalTransactionId, r.contributionId]));
}

async function loadPeriodMap(
  database: Db,
  zoneId: string,
  dates: string[],
): Promise<Map<string, string>> {
  if (dates.length === 0) return new Map();
  const distinct = Array.from(new Set(dates));
  const rows = await database
    .select({ id: givingPeriods.id, date: givingPeriods.date })
    .from(givingPeriods)
    .where(and(eq(givingPeriods.zoneId, zoneId), inArray(givingPeriods.date, distinct)));
  return new Map(rows.map((r) => [r.date as unknown as string, r.id]));
}

function resolveMember(
  lookups: ZoneLookups,
  parsed: ParsedRow["parsed"],
  chapterId: string | null,
): { memberId: string | null; failure?: FailureCode } {
  if (parsed.memberReferenceCode) {
    const hit = lookups.membersByRef.get(parsed.memberReferenceCode.toLowerCase());
    if (hit) return { memberId: hit.id };
    return { memberId: null, failure: "MEMBER_NOT_FOUND" };
  }
  if (parsed.memberName) {
    const list = lookups.membersByName.get(parsed.memberName.toLowerCase()) ?? [];
    const scoped = chapterId ? list.filter((m) => m.chapterId === chapterId) : list;
    if (scoped.length === 1) return { memberId: scoped[0].id };
    if (scoped.length === 0) return { memberId: null, failure: "MEMBER_NOT_FOUND" };
    return { memberId: null, failure: "MEMBER_AMBIGUOUS" };
  }
  return { memberId: null }; // member optional; downstream may require it
}

function resolveGivingType(
  lookups: ZoneLookups,
  parsed: ParsedRow["parsed"],
): { id: string | null; accountId: string | null; failure?: FailureCode } {
  if (parsed.givingTypeShortCode) {
    const hit = lookups.givingTypeByShortCode.get(parsed.givingTypeShortCode.toLowerCase());
    if (hit) return { id: hit.id, accountId: hit.accountId };
  }
  if (parsed.givingTypeName) {
    const hit = lookups.givingTypeByName.get(parsed.givingTypeName.toLowerCase());
    if (hit) return { id: hit.id, accountId: hit.accountId };
    return { id: null, accountId: null, failure: "GIVING_TYPE_NOT_FOUND" };
  }
  return { id: null, accountId: null, failure: "GIVING_TYPE_REQUIRED" };
}

function resolveChapter(
  lookups: ZoneLookups,
  parsed: ParsedRow["parsed"],
  ctx: MatchContext,
): { id: string | null; failure?: FailureCode } {
  if (parsed.chapterReferenceCode) {
    const hit = lookups.chapterByRef.get(parsed.chapterReferenceCode.toLowerCase());
    if (!hit) return { id: null, failure: "CHAPTER_NOT_FOUND" };
    return { id: hit };
  }
  if (ctx.fileChapterId) return { id: ctx.fileChapterId };
  return { id: null, failure: "CHAPTER_REQUIRED" };
}

function resolveServiceEvent(
  lookups: ZoneLookups,
  parsed: ParsedRow["parsed"],
  chapterId: string | null,
  ctx: MatchContext,
): { id: string | null; failure?: FailureCode; details?: unknown } {
  const eventId = parsed.serviceEventId ?? ctx.fileServiceEventId;
  if (eventId) {
    const hit = lookups.serviceEventById.get(eventId.toLowerCase());
    if (!hit) return { id: null, failure: "SERVICE_EVENT_NOT_FOUND", details: { serviceEventId: eventId } };
    if (hit.chapterId !== null && hit.chapterId !== chapterId) {
      return {
        id: null,
        failure: "SERVICE_EVENT_CHAPTER_MISMATCH",
        details: { serviceEventId: hit.id, chapterId },
      };
    }
    return { id: hit.id };
  }

  const serviceDate = parsed.serviceDate ?? parsed.contributionDate;
  const typeKey = parsed.serviceTypeShortCode ?? parsed.serviceTypeName;
  if (!serviceDate || !typeKey) {
    return { id: null, failure: "SERVICE_EVENT_REQUIRED" };
  }
  const scopedKey = `${chapterId ?? ""}|${serviceDate}|${typeKey.toLowerCase()}`;
  const zoneWideKey = `*|${serviceDate}|${typeKey.toLowerCase()}`;
  const matches = lookups.serviceEventByKey.get(scopedKey) ?? lookups.serviceEventByKey.get(zoneWideKey) ?? [];
  if (matches.length === 0) {
    return { id: null, failure: "SERVICE_EVENT_NOT_FOUND", details: { serviceDate, type: typeKey } };
  }
  if (matches.length > 1) {
    return { id: null, failure: "SERVICE_EVENT_AMBIGUOUS", details: { serviceDate, type: typeKey } };
  }
  return { id: matches[0].id };
}

export async function matchRows(
  database: Db,
  ctx: MatchContext,
  rows: ParsedRow[],
): Promise<MatchedRow[]> {
  const lookups = await loadZoneLookups(database, ctx.zoneId);
  const externalIds = rows
    .map((r) => r.parsed.externalTransactionId)
    .filter((v): v is string => Boolean(v));
  const dupMap = await loadDuplicateMap(database, ctx.zoneId, externalIds);
  const dates = rows.map((r) => r.parsed.contributionDate).filter((d): d is string => Boolean(d));
  const periodMap = await loadPeriodMap(database, ctx.zoneId, dates);

  const out: MatchedRow[] = [];
  for (const row of rows) {
    const failures: { code: FailureCode; details?: unknown }[] = [];

    const chapter = resolveChapter(lookups, row.parsed, ctx);
    if (chapter.failure) failures.push({ code: chapter.failure });

    const serviceEvent = resolveServiceEvent(lookups, row.parsed, chapter.id, ctx);
    if (serviceEvent.failure) {
      failures.push({ code: serviceEvent.failure, details: serviceEvent.details });
    }

    const member = resolveMember(lookups, row.parsed, chapter.id);
    if (member.failure) failures.push({ code: member.failure });

    const givingType = resolveGivingType(lookups, row.parsed);
    if (givingType.failure) failures.push({ code: givingType.failure });

    if (!row.parsed.amount) {
      failures.push({ code: "INVALID_AMOUNT" });
    } else {
      // Reject zero / negative amounts; the import pipeline only emits
      // inflows. Reversals are an explicit treasurer action via the
      // contribution-level reverse endpoint. Use Decimal not Number() so
      // amounts > 2^53 don't silently lose precision (AGENTS rule #1).
      try {
        const d = new Decimal(row.parsed.amount);
        if (!d.isFinite() || d.lte(0)) failures.push({ code: "INVALID_AMOUNT" });
      } catch {
        failures.push({ code: "INVALID_AMOUNT" });
      }
    }

    let givingPeriodId: string | null = null;
    if (!row.parsed.contributionDate) {
      failures.push({ code: "INVALID_DATE" });
    } else {
      givingPeriodId = periodMap.get(row.parsed.contributionDate) ?? null;
      if (!givingPeriodId) failures.push({ code: "PERIOD_NOT_FOUND" });
    }

    const accountId: string | null = givingType.accountId;
    const currencyCode = row.parsed.currencyCode ?? lookups.defaultCurrencyCode;
    if (accountId) {
      const accountCurrency = lookups.accountById.get(accountId);
      if (accountCurrency && accountCurrency !== currencyCode) {
        failures.push({
          code: "CURRENCY_MISMATCH",
          details: { rowCurrency: currencyCode, accountCurrency },
        });
      }
    }

    const paymentMethodId = row.parsed.paymentMethodCode
      ? lookups.paymentMethodByCode.get(row.parsed.paymentMethodCode.toLowerCase()) ?? null
      : null;

    // Duplicate check is independent of validation: a duplicate is still
    // "valid" data, just one we won't re-post.
    let isDuplicate = false;
    let duplicateOfContributionId: string | null = null;
    if (row.parsed.externalTransactionId && dupMap.has(row.parsed.externalTransactionId)) {
      isDuplicate = true;
      duplicateOfContributionId = dupMap.get(row.parsed.externalTransactionId) ?? null;
      failures.push({
        code: "DUPLICATE",
        details: { externalTransactionId: row.parsed.externalTransactionId },
      });
    }

    const validationStatus: MatchedRow["validationStatus"] =
      failures.filter((f) => f.code !== "DUPLICATE").length > 0 ? "invalid" : "valid";
    const blockingFailures = failures.filter((f) => f.code !== "DUPLICATE");
    let matchStatus: MatchedRow["matchStatus"];
    if (blockingFailures.length === 0) matchStatus = "matched";
    else if (member.memberId || givingType.id) matchStatus = "partial";
    else matchStatus = "unmatched";

    out.push({
      rowNumber: row.rowNumber,
      raw: row.raw,
      parsed: row.parsed,
      memberId: member.memberId,
      chapterId: chapter.id,
      givingTypeId: givingType.id,
      givingPeriodId,
      accountId,
      paymentMethodId,
      serviceEventId: serviceEvent.id,
      currencyCode,
      externalTransactionId: row.parsed.externalTransactionId,
      matchStatus,
      validationStatus,
      isDuplicate,
      duplicateOfContributionId,
      failures,
    });
  }
  return out;
}

/**
 * Persist the matcher output. Caller is responsible for transaction; we
 * accept any `Db` so it composes with `commitJob`.
 */
export async function persistMatchedRows(
  database: Db,
  zoneId: string,
  importJobId: string,
  rows: MatchedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  // Insert rows in bounded chunks so canonical 5k+ imports stay below
  // Postgres' bind-parameter ceiling.
  const rowIds: { id: string; rowNumber: number }[] = [];
  for (const chunk of chunksOf(rows)) {
    const inserted = await database
      .insert(importRows)
      .values(
        chunk.map((r) => ({
          zoneId,
          importJobId,
          rowNumber: r.rowNumber,
          raw: r.raw,
          parsed: r.parsed,
          matchStatus: r.matchStatus,
          validationStatus: r.validationStatus,
          memberId: r.memberId,
          chapterId: r.chapterId,
          givingTypeId: r.givingTypeId,
          givingPeriodId: r.givingPeriodId,
          accountId: r.accountId,
          paymentMethodId: r.paymentMethodId,
          serviceEventId: r.serviceEventId,
          currencyCode: r.currencyCode,
          externalTransactionId: r.externalTransactionId,
          isDuplicate: r.isDuplicate,
          duplicateOfContributionId: r.duplicateOfContributionId,
        })),
      )
      .returning({ id: importRows.id, rowNumber: importRows.rowNumber });
    rowIds.push(...inserted);
  }
  const idByRowNumber = new Map(rowIds.map((r) => [r.rowNumber, r.id]));

  // Persist failures.
  const failureRows: {
    zoneId: string;
    rowId: string;
    failureTypeId: string;
    failureCode: string;
    details: unknown;
  }[] = [];
  // Lookup failure type ids once per code.
  const seenCodes = new Set<FailureCode>();
  for (const r of rows) for (const f of r.failures) seenCodes.add(f.code);
  const codeToId = new Map<FailureCode, string>();
  await Promise.all(
    Array.from(seenCodes).map(async (code) => {
      codeToId.set(code, await resolveFailureTypeId(database, zoneId, code));
    }),
  );
  for (const r of rows) {
    const rowId = idByRowNumber.get(r.rowNumber);
    if (!rowId) continue;
    for (const f of r.failures) {
      failureRows.push({
        zoneId,
        rowId,
        failureTypeId: codeToId.get(f.code)!,
        failureCode: f.code,
        details: f.details ?? null,
      });
    }
  }
  for (const chunk of chunksOf(failureRows)) {
    if (chunk.length > 0) await database.insert(importRowFailures).values(chunk);
  }
}

export function summariseMatch(rows: MatchedRow[]): {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  duplicateRows: number;
  failedRows: number;
} {
  let matched = 0,
    unmatched = 0,
    duplicate = 0,
    failed = 0;
  for (const r of rows) {
    if (r.isDuplicate) duplicate++;
    if (r.matchStatus === "matched") matched++;
    else if (r.matchStatus === "unmatched") unmatched++;
    if (r.validationStatus === "invalid") failed++;
  }
  return {
    totalRows: rows.length,
    matchedRows: matched,
    unmatchedRows: unmatched,
    duplicateRows: duplicate,
    failedRows: failed,
  };
}

