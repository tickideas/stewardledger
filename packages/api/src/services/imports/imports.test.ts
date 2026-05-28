// packages/api/src/services/imports/imports.test.ts
// End-to-end Phase 6 import pipeline:
//   • Upload a canonical statement file → parse + match.
//   • Schedule + commit → contributions appear in `posted` status.
//   • Re-uploading the same bytes is a no-op (file-level idempotency).
//   • Re-uploading a freshly-renamed file with the same external_transaction_ids
//     produces zero new contributions (row-level idempotency via
//     processed_transactions).
//   • Rollback voids every contribution committed by the job and frees the
//     external_transaction_ids so a corrected re-upload can take over.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  applyContributionTriggers,
  chapters,
  contributionBatches,
  contributionLines,
  contributions,
  importRowFailures,
  importRows,
  givingTypes,
  importFiles,
  importJobs,
  members,
  processedTransactions,
  serviceEvents,
  serviceTypes,
  user as userTable,
  zones,
} from "@stewardledger/db";
import { db } from "../../db";
import { ensurePlatformFailureTypes } from "./failure-types";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { seedZoneGivingSetup } from "../giving-setup-seed";
import { seedZonePeriods } from "../period-seed";
import {
  commitImport,
  getImport,
  listImports,
  publicMessageForImportError,
  rollbackImport,
  scheduleImport,
  uploadImport,
} from ".";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SeededZone {
  id: string;
  chapterId: string;
  chapterReferenceCode: string;
  otherChapterId: string;
  otherChapterReferenceCode: string;
  serviceEventId: string;
  otherServiceEventId: string;
  memberRefs: string[];
  userId: string;
  givingTypeShortCode: string;
}

async function seedZone(): Promise<SeededZone> {
  const slug = `imp-${unique()}`;
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `Import Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });

  await seedZoneGivingSetup(db, zone.id, "GBP");
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });

  const [chapter, otherChapter] = await db
    .insert(chapters)
    .values([
      {
        zoneId: zone.id,
        referenceCode: `CH${unique()}`.slice(0, 12),
        name: `Chapter ${unique()}`,
        dateFrom: "2024-01-01",
      },
      {
        zoneId: zone.id,
        referenceCode: `CH${unique()}`.slice(0, 12),
        name: `Chapter ${unique()}`,
        dateFrom: "2024-01-01",
      },
    ])
    .returning({ id: chapters.id, referenceCode: chapters.referenceCode });

  // Three members with distinct reference codes.
  const memberRefs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ref = `MM${unique()}`.slice(0, 10).toUpperCase();
    memberRefs.push(ref);
    await db.insert(members).values({
      zoneId: zone.id,
      chapterId: chapter.id,
      referenceCode: ref,
      firstName: `First${i}`,
      lastName: `Last${i}`,
    });
  }

  // Reuse the seeded TITHE giving type.
  const [gt] = await db
    .select({ id: givingTypes.id, shortCode: givingTypes.shortCode })
    .from(givingTypes)
    .where(sql`${givingTypes.zoneId} = ${zone.id} and ${givingTypes.shortCode} = 'TITHE'`)
    .limit(1);
  const [serviceType] = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(sql`${serviceTypes.zoneId} = ${zone.id}`)
    .limit(1);
  const [event, otherEvent] = await db
    .insert(serviceEvents)
    .values([
      { zoneId: zone.id, chapterId: chapter.id, serviceTypeId: serviceType.id, serviceDate: TODAY },
      { zoneId: zone.id, chapterId: otherChapter.id, serviceTypeId: serviceType.id, serviceDate: TODAY },
    ])
    .returning({ id: serviceEvents.id });

  const userId = `u-${unique()}`;
  await db.insert(userTable).values({ id: userId, email: `${userId}@test.local`, emailVerified: true });

  return {
    id: zone.id,
    chapterId: chapter.id,
    chapterReferenceCode: chapter.referenceCode,
    otherChapterId: otherChapter.id,
    otherChapterReferenceCode: otherChapter.referenceCode,
    serviceEventId: event.id,
    otherServiceEventId: otherEvent.id,
    memberRefs,
    userId,
    givingTypeShortCode: gt.shortCode!,
  };
}

// Today's calendar date is what gets seeded as the current-year period
// range; we anchor every test contribution to a recent date so the
// matcher's PERIOD lookup hits.
const TODAY = new Date().toISOString().slice(0, 10);
function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildCsv(zone: SeededZone, dateBase = TODAY): string {
  return [
    "date,member reference,giving type code,amount,reference,currency,description",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,TX-A,GBP,Tithe`,
    `${dateBase},${zone.memberRefs[1]},${zone.givingTypeShortCode},50.00,TX-B,GBP,Tithe`,
    `${dateBase},${zone.memberRefs[2]},${zone.givingTypeShortCode},25.00,TX-C,GBP,Tithe`,
  ].join("\n");
}

function buildEnvelopeCsv(zone: SeededZone, dateBase = TODAY): string {
  return [
    "service date,member reference,giving type code,amount,currency,payment method,envelope number,external reference,description",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,GBP,cash,ENV-A,ENV-TX-A,Tithe`,
    `${dateBase},${zone.memberRefs[1]},${zone.givingTypeShortCode},50.00,GBP,cash,ENV-B,ENV-TX-B,Tithe`,
  ].join("\n");
}

function buildEnvelopeCsvWithoutExternalRef(zone: SeededZone, dateBase = TODAY, description = "Tithe"): string {
  return [
    "service date,member reference,giving type code,amount,currency,payment method,envelope number,description",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,GBP,cash,ENV-A,${description}`,
    `${dateBase},${zone.memberRefs[1]},${zone.givingTypeShortCode},50.00,GBP,cash,ENV-B,${description}`,
  ].join("\n");
}

function buildEnvelopeChequeCsv(zone: SeededZone, dateBase = TODAY): string {
  return [
    "service date,member reference,giving type code,amount,currency,payment method,envelope number,external reference",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},50.00,GBP,cheque,ENV-CHEQUE,ENV-CHEQUE-TX`,
  ].join("\n");
}

function buildEnvelopeMixedPaymentCsv(zone: SeededZone, dateBase = TODAY): string {
  return [
    "service date,member reference,giving type code,amount,currency,payment method,envelope number,external reference",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,GBP,cash,ENV-CASH,ENV-CASH-TX`,
    `${dateBase},${zone.memberRefs[1]},${zone.givingTypeShortCode},50.00,GBP,cheque,ENV-CHEQUE,ENV-CHEQUE-TX`,
  ].join("\n");
}

function buildEnvelopeDuplicateDerivedKeyCsv(zone: SeededZone, dateBase = TODAY): string {
  return [
    "service date,member reference,giving type code,amount,currency,payment method,envelope number,description",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,GBP,cash,ENV-DUP,First row`,
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,GBP,cash,ENV-DUP,Duplicate row`,
  ].join("\n");
}

function buildEnvelopeCsvWithoutStableReference(zone: SeededZone, dateBase = TODAY): string {
  return [
    "service date,member reference,giving type code,amount,currency,payment method,description",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,GBP,cash,Tithe`,
  ].join("\n");
}

function buildEnvelopeSplitCsv(zone: SeededZone, dateBase = TODAY): string {
  return [
    "service date,member reference,giving type code,cash amount,cheque amount,currency,envelope number,external reference",
    `${dateBase},${zone.memberRefs[0]},${zone.givingTypeShortCode},10.00,5.00,GBP,ENV-SPLIT,ENV-SPLIT-TX`,
  ].join("\n");
}

const seededZones: string[] = [];

describe("publicMessageForImportError", () => {
  it("does not expose internal processing exception messages", () => {
    expect(publicMessageForImportError("persist_failed", "duplicate key value violates constraint import_rows_job_row_unique")).toBe(
      "Import processing failed. Please contact support.",
    );
  });

  it("preserves user-actionable import messages", () => {
    expect(publicMessageForImportError("parse_failed", "CSV parse error on row 2")).toBe(
      "CSV parse error on row 2",
    );
  });
});

beforeAll(async () => {
  await applyContributionTriggers(db);
  await ensurePlatformFailureTypes(db);
  setStorageForTesting(new InMemoryStorage());
});

// Same advisory-lock tag that `applyContributionTriggers` uses. The
// drizzle `db` is a connection pool, so plain `pg_advisory_lock` /
// `pg_advisory_unlock` would run on different pooled connections and
// the lock would leak. We instead wrap the whole disable / delete /
// re-enable sequence in one transaction and use `pg_advisory_xact_lock`
// (tx-scoped, auto-released on commit) to serialise against any
// parallel suite calling `applyContributionTriggers` in its bootstrap.
const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";

afterAll(async () => {
  const guards = [
    ["contributions", "contributions_posted_guard"],
    ["contributions", "contributions_no_delete_when_posted"],
    ["contribution_lines", "contribution_lines_posted_guard"],
  ] as const;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
      );
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
      }
      for (const id of seededZones) {
        await tx.execute(sql`delete from contribution_lines where zone_id = ${id}`);
        await tx.execute(sql`delete from contribution_members where zone_id = ${id}`);
        await tx.execute(sql`delete from processed_transactions where zone_id = ${id}`);
        await tx.execute(sql`delete from import_row_failures where zone_id = ${id}`);
        await tx.execute(sql`delete from import_rows where zone_id = ${id}`);
        await tx.execute(sql`delete from import_schedules where zone_id = ${id}`);
        await tx.execute(sql`delete from import_jobs where zone_id = ${id}`);
        await tx.execute(sql`delete from import_files where zone_id = ${id}`);
        await tx.execute(sql`delete from contributions where zone_id = ${id}`);
        await tx.execute(sql`delete from contribution_batches where zone_id = ${id}`);
        await tx.execute(sql`delete from service_events where zone_id = ${id}`);
        await tx.execute(sql`delete from members where zone_id = ${id}`);
        await tx.execute(sql`delete from chapters where zone_id = ${id}`);
        await tx.execute(sql`delete from zones where id = ${id}`);
      }
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
      }
    });
  } finally {
    setStorageForTesting(null);
  }
});


describe("import pipeline (end-to-end)", () => {
  it("redacts persisted internal error messages returned by import detail", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const [file] = await db
      .insert(importFiles)
      .values({
        zoneId: zone.id,
        chapterId: zone.chapterId,
        serviceEventId: zone.serviceEventId,
        uploadedByUserId: zone.userId,
        originalFileName: "bad.csv",
        storageKey: "test/bad.csv",
        sizeBytes: 10,
        checksumSha256: "abc123",
        fileType: "statement",
        sourceType: "generic_csv",
      })
      .returning({ id: importFiles.id });
    const [job] = await db
      .insert(importJobs)
      .values({
        zoneId: zone.id,
        importFileId: file.id,
        status: "failed",
        errorCode: "persist_failed",
        errorMessage: "duplicate key value violates constraint import_rows_job_row_unique",
        createdByUserId: zone.userId,
      })
      .returning({ id: importJobs.id });

    const detail = await getImport(db, zone.id, job.id);

    expect(detail?.job.errorMessage).toBe("Import processing failed. Please contact support.");
  });

  it("redacts persisted internal error messages returned by import list", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const [file] = await db
      .insert(importFiles)
      .values({
        zoneId: zone.id,
        chapterId: zone.chapterId,
        serviceEventId: zone.serviceEventId,
        uploadedByUserId: zone.userId,
        originalFileName: "bad-list.csv",
        storageKey: "test/bad-list.csv",
        sizeBytes: 10,
        checksumSha256: "def456",
        fileType: "statement",
        sourceType: "generic_csv",
      })
      .returning({ id: importFiles.id });
    await db.insert(importJobs).values({
      zoneId: zone.id,
      importFileId: file.id,
      status: "failed",
      errorCode: "match_failed",
      errorMessage: "relation secret_internal_table does not exist",
      createdByUserId: zone.userId,
    });

    const listed = await listImports(db, zone.id, { limit: 50, offset: 0 }, { chapterIds: [zone.chapterId] });

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].errorMessage).toBe("Import processing failed. Please contact support.");
  });

  it("uploads, matches, schedules, commits, and posts contributions", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const csv = buildCsv(zone);
    const body = new TextEncoder().encode(csv);

    const uploaded = await uploadImport(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        fileName: "feb-2024.csv",
        body,
        fileType: "statement",
        sourceType: "generic_csv",
        chapterId: zone.chapterId,
        serviceEventId: zone.serviceEventId,
      },
    );
    expect(uploaded.reused).toBe(false);
    expect(uploaded.totalRows).toBe(3);
    expect(uploaded.matchedRows).toBe(3);
    expect(uploaded.failedRows).toBe(0);
    expect(uploaded.duplicateRows).toBe(0);

    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    const committed = await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    expect(committed.committedRows).toBe(3);
    expect(committed.skippedDuplicates).toBe(0);

    const rows = await db
      .select({
        id: contributions.id,
        status: contributions.status,
        sourceType: contributions.sourceType,
        externalTransactionId: contributions.externalTransactionId,
        totalAmount: contributions.totalAmount,
      })
      .from(contributions)
      .where(eq(contributions.zoneId, zone.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "posted")).toBe(true);
    expect(rows.every((r) => r.sourceType === "bank_import")).toBe(true);
    expect(new Set(rows.map((r) => r.externalTransactionId))).toEqual(
      new Set(["TX-A", "TX-B", "TX-C"]),
    );

    const procRows = await db
      .select({ id: processedTransactions.id })
      .from(processedTransactions)
      .where(eq(processedTransactions.zoneId, zone.id));
    expect(procRows).toHaveLength(3);
  });

  it("commits envelope batch imports into posted envelope batches and contributions", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const body = new TextEncoder().encode(buildEnvelopeCsv(zone));

    const uploaded = await uploadImport(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        fileName: "sunday-envelopes.csv",
        body,
        fileType: "envelope_batch",
        sourceType: "envelope_batch",
        chapterId: zone.chapterId,
        serviceEventId: zone.serviceEventId,
      },
    );
    expect(uploaded).toMatchObject({
      reused: false,
      totalRows: 2,
      matchedRows: 2,
      failedRows: 0,
      duplicateRows: 0,
    });

    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    const committed = await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    expect(committed).toMatchObject({ committedRows: 2, skippedDuplicates: 0 });

    const batches = await db
      .select({
        id: contributionBatches.id,
        status: contributionBatches.status,
        sourceType: contributionBatches.sourceType,
        cashTotal: contributionBatches.cashTotal,
        currencyCode: contributionBatches.currencyCode,
      })
      .from(contributionBatches)
      .where(eq(contributionBatches.zoneId, zone.id));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      status: "posted",
      sourceType: "envelope",
      cashTotal: "150.0000",
      currencyCode: "GBP",
    });

    const rows = await db
      .select({
        id: contributions.id,
        status: contributions.status,
        sourceType: contributions.sourceType,
        batchId: contributions.batchId,
        externalTransactionId: contributions.externalTransactionId,
        totalAmount: contributions.totalAmount,
      })
      .from(contributions)
      .where(eq(contributions.zoneId, zone.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "posted")).toBe(true);
    expect(rows.every((r) => r.sourceType === "envelope")).toBe(true);
    expect(rows.every((r) => r.batchId === batches[0].id)).toBe(true);
    expect(new Set(rows.map((r) => r.externalTransactionId))).toEqual(
      new Set(["ENV-TX-A", "ENV-TX-B"]),
    );

    const lines = await db
      .select({ id: contributionLines.id })
      .from(contributionLines)
      .where(eq(contributionLines.zoneId, zone.id));
    expect(lines).toHaveLength(2);

    const procRows = await db
      .select({ id: processedTransactions.id })
      .from(processedTransactions)
      .where(eq(processedTransactions.zoneId, zone.id));
    expect(procRows).toHaveLength(2);
  });

  it("rejects envelope rows whose service date does not match the selected service event", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const wrongDate = shiftDays(TODAY, -7);
    const body = new TextEncoder().encode(buildEnvelopeCsv(zone, wrongDate));

    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "wrong-service-date.csv",
      body,
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });

    expect(uploaded.failedRows).toBe(2);
    expect(uploaded.matchedRows).toBe(0);

    const failures = await db
      .select({ code: importRowFailures.failureCode })
      .from(importRowFailures)
      .innerJoin(importRows, eq(importRows.id, importRowFailures.rowId))
      .where(eq(importRows.importJobId, uploaded.importJobId));
    expect(failures.map((failure) => failure.code)).toContain("SERVICE_EVENT_MISMATCH");
  });

  it("derives envelope idempotency keys when external references are omitted", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);

    const first = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "no-ref-envelopes.csv",
      body: new TextEncoder().encode(buildEnvelopeCsvWithoutExternalRef(zone, TODAY, "First upload")),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, first.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, first.importJobId);

    const second = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "no-ref-envelopes-edited.csv",
      body: new TextEncoder().encode(buildEnvelopeCsvWithoutExternalRef(zone, TODAY, "Edited note")),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });

    expect(second.reused).toBe(false);
    expect(second.duplicateRows).toBe(2);
    expect(second.matchedRows).toBe(2);
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, second.importJobId);
    const committed = await commitImport(db, { zoneId: zone.id, userId: zone.userId }, second.importJobId);
    expect(committed.committedRows).toBe(0);

    const rows = await db
      .select({ id: contributions.id })
      .from(contributions)
      .where(eq(contributions.zoneId, zone.id));
    expect(rows).toHaveLength(2);
  });

  it("uses payment method when calculating envelope batch cash and cheque totals", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "cheque-envelopes.csv",
      body: new TextEncoder().encode(buildEnvelopeChequeCsv(zone)),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);

    const [batch] = await db
      .select({
        cashTotal: contributionBatches.cashTotal,
        chequeTotal: contributionBatches.chequeTotal,
      })
      .from(contributionBatches)
      .where(eq(contributionBatches.zoneId, zone.id));
    expect(batch).toMatchObject({
      cashTotal: "0.0000",
      chequeTotal: "50.0000",
    });
  });

  it("keeps mixed cash and cheque envelope rows in one generated batch", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "mixed-payment-envelopes.csv",
      body: new TextEncoder().encode(buildEnvelopeMixedPaymentCsv(zone)),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);

    const batches = await db
      .select({
        paymentMethodId: contributionBatches.paymentMethodId,
        cashTotal: contributionBatches.cashTotal,
        chequeTotal: contributionBatches.chequeTotal,
      })
      .from(contributionBatches)
      .where(eq(contributionBatches.zoneId, zone.id));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      paymentMethodId: null,
      cashTotal: "100.0000",
      chequeTotal: "50.0000",
    });
  });

  it("marks repeated derived envelope keys inside one upload as duplicates before commit", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "duplicate-derived-envelopes.csv",
      body: new TextEncoder().encode(buildEnvelopeDuplicateDerivedKeyCsv(zone)),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });

    expect(uploaded).toMatchObject({
      totalRows: 2,
      matchedRows: 2,
      duplicateRows: 1,
      failedRows: 0,
    });

    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    const committed = await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    expect(committed).toMatchObject({ committedRows: 1, skippedDuplicates: 1 });

    const rows = await db
      .select({ id: contributions.id })
      .from(contributions)
      .where(eq(contributions.zoneId, zone.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects envelope rows without an external reference or envelope number", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "unstable-reference-envelopes.csv",
      body: new TextEncoder().encode(buildEnvelopeCsvWithoutStableReference(zone)),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });

    expect(uploaded).toMatchObject({
      totalRows: 1,
      matchedRows: 0,
      failedRows: 1,
      duplicateRows: 0,
    });

    const failures = await db
      .select({ code: importRowFailures.failureCode })
      .from(importRowFailures)
      .innerJoin(importRows, eq(importRows.id, importRowFailures.rowId))
      .where(eq(importRows.importJobId, uploaded.importJobId));
    expect(failures.map((failure) => failure.code)).toContain("ENVELOPE_REFERENCE_REQUIRED");
  });

  it("rejects envelope row chapter columns that conflict with a chapter-scoped upload", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const [serviceType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zone.id}`)
      .limit(1);
    const [zoneWideEvent] = await db
      .insert(serviceEvents)
      .values({
        zoneId: zone.id,
        chapterId: null,
        serviceTypeId: serviceType.id,
        serviceDate: TODAY,
      })
      .returning({ id: serviceEvents.id });
    const csv = [
      "service date,chapter,member reference,giving type code,amount,currency,payment method,envelope number",
      `${TODAY},${zone.otherChapterReferenceCode},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,GBP,cash,ENV-SCOPE`,
    ].join("\n");

    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "chapter-conflict-envelopes.csv",
      body: new TextEncoder().encode(csv),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zoneWideEvent.id,
    });

    expect(uploaded).toMatchObject({
      totalRows: 1,
      matchedRows: 0,
      failedRows: 1,
      duplicateRows: 0,
    });

    const failures = await db
      .select({ code: importRowFailures.failureCode })
      .from(importRowFailures)
      .innerJoin(importRows, eq(importRows.id, importRowFailures.rowId))
      .where(eq(importRows.importJobId, uploaded.importJobId));
    expect(failures.map((failure) => failure.code)).toContain("CHAPTER_SCOPE_MISMATCH");
  });

  it("keeps cash-and-cheque split envelope rows in preview as invalid rows", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "split-envelopes.csv",
      body: new TextEncoder().encode(buildEnvelopeSplitCsv(zone)),
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });

    expect(uploaded.totalRows).toBe(1);
    expect(uploaded.failedRows).toBe(1);
    const failures = await db
      .select({ code: importRowFailures.failureCode })
      .from(importRowFailures)
      .innerJoin(importRows, eq(importRows.id, importRowFailures.rowId))
      .where(eq(importRows.importJobId, uploaded.importJobId));
    expect(failures.map((failure) => failure.code)).toContain("INVALID_AMOUNT_SPLIT");
  });

  it("rolls back envelope batch imports by voiding generated batches", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const body = new TextEncoder().encode(buildEnvelopeCsv(zone));

    const uploaded = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "rollback-envelopes.csv",
      body,
      fileType: "envelope_batch",
      sourceType: "envelope_batch",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId);

    const rolledBack = await rollbackImport(db, { zoneId: zone.id, userId: zone.userId }, uploaded.importJobId, {
      reason: "wrong envelope file",
    });
    expect(rolledBack.voidedContributions).toBe(2);

    const batches = await db
      .select({ status: contributionBatches.status, voidReason: contributionBatches.voidReason })
      .from(contributionBatches)
      .where(eq(contributionBatches.zoneId, zone.id));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      status: "voided",
      voidReason: "Import rollback: wrong envelope file",
    });

    const procRows = await db
      .select({ id: processedTransactions.id })
      .from(processedTransactions)
      .where(eq(processedTransactions.zoneId, zone.id));
    expect(procRows).toHaveLength(0);
  });

  it("re-uploading the same bytes returns the existing job (file-level idempotency)", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const body = new TextEncoder().encode(buildCsv(zone));

    const first = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "x.csv",
      body,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    const second = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "x.csv",
      body,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    expect(second.reused).toBe(true);
    expect(second.importJobId).toBe(first.importJobId);
  });

  it("same bytes in a different chapter create a distinct job", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const body = new TextEncoder().encode(buildCsv(zone));

    const first = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "same.csv",
      body,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    const second = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "same.csv",
      body,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.otherChapterId,
      serviceEventId: zone.otherServiceEventId,
    });

    expect(second.reused).toBe(false);
    expect(second.importJobId).not.toBe(first.importJobId);
  });

  it("zone-wide row resolving by date+type does not borrow another chapter's event", async () => {
    // Regression: serviceEventByKey used to index every event under the
    // zone-wide "*|date|type" key, so a chapter-scoped row whose own
    // chapter had no matching event would silently match a different
    // chapter's event without raising SERVICE_EVENT_CHAPTER_MISMATCH.
    const zone = await seedZone();
    seededZones.push(zone.id);

    // Pick a date where only chapter A has an event. Seed an extra event
    // for chapter A on that date; chapter B has no event on this date.
    // The CSV row targets chapter B on this date → chapter A's event must
    // NOT be selected via the zone-wide fallback.
    const isolatedDate = shiftDays(TODAY, -3);
    const [serviceType] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(sql`${serviceTypes.zoneId} = ${zone.id}`)
      .limit(1);
    await db.insert(serviceEvents).values({
      zoneId: zone.id,
      chapterId: zone.chapterId,
      serviceTypeId: serviceType.id,
      serviceDate: isolatedDate,
    });

    const csv = [
      "date,member reference,giving type code,amount,reference,currency,description,chapter,service type code,service date",
      `${isolatedDate},${zone.memberRefs[0]},${zone.givingTypeShortCode},100.00,TX-CROSS,GBP,Tithe,${zone.otherChapterReferenceCode},SUN,${isolatedDate}`,
    ].join("\n");
    const body = new TextEncoder().encode(csv);

    const uploaded = await uploadImport(
      db,
      { zoneId: zone.id, userId: zone.userId },
      {
        fileName: "cross.csv",
        body,
        fileType: "statement",
        sourceType: "generic_csv",
      },
    );
    // The row must not match: chapter B has no event on isolatedDate, and
    // chapter A's event must not be borrowed via the zone-wide fallback.
    expect(uploaded.matchedRows).toBe(0);
    expect(uploaded.failedRows).toBe(1);
  });

  it("re-uploading new bytes with already-seen external ids produces zero new contributions", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const body1 = new TextEncoder().encode(buildCsv(zone, shiftDays(TODAY, -7)));
    const j1 = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "wk1.csv",
      body: body1,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, j1.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, j1.importJobId);

    const before = await db
      .select({ id: contributions.id })
      .from(contributions)
      .where(eq(contributions.zoneId, zone.id));
    expect(before).toHaveLength(3);

    // Different bytes (new date), same external_transaction_ids.
    const body2 = new TextEncoder().encode(buildCsv(zone, TODAY));
    const j2 = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "wk2.csv",
      body: body2,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    expect(j2.reused).toBe(false);
    // Every row should have been flagged as a duplicate by the matcher.
    expect(j2.duplicateRows).toBe(3);
    // Validation status excludes duplicates from "failed", so failedRows=0
    // and the job is schedulable.
    expect(j2.failedRows).toBe(0);
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, j2.importJobId);
    const c2 = await commitImport(db, { zoneId: zone.id, userId: zone.userId }, j2.importJobId);
    expect(c2.committedRows).toBe(0);
    expect(c2.skippedDuplicates).toBe(3);

    const after = await db
      .select({ id: contributions.id })
      .from(contributions)
      .where(eq(contributions.zoneId, zone.id));
    expect(after).toHaveLength(3);
  });

  it("rolls back a committed job by voiding contributions and freeing external ids", async () => {
    const zone = await seedZone();
    seededZones.push(zone.id);
    const body = new TextEncoder().encode(buildCsv(zone, shiftDays(TODAY, -1)));
    const j = await uploadImport(db, { zoneId: zone.id, userId: zone.userId }, {
      fileName: "march.csv",
      body,
      fileType: "statement",
      sourceType: "generic_csv",
      chapterId: zone.chapterId,
      serviceEventId: zone.serviceEventId,
    });
    await scheduleImport(db, { zoneId: zone.id, userId: zone.userId }, j.importJobId);
    await commitImport(db, { zoneId: zone.id, userId: zone.userId }, j.importJobId);

    const result = await rollbackImport(
      db,
      { zoneId: zone.id, userId: zone.userId },
      j.importJobId,
      { reason: "Posted to wrong chapter" },
    );
    expect(result.voidedContributions).toBe(3);

    const rows = await db
      .select({ status: contributions.status, voidReason: contributions.voidReason })
      .from(contributions)
      .where(eq(contributions.zoneId, zone.id));
    expect(rows.every((r) => r.status === "voided")).toBe(true);
    expect(rows.every((r) => (r.voidReason ?? "").includes("Posted to wrong chapter"))).toBe(true);

    const procRows = await db
      .select({ id: processedTransactions.id })
      .from(processedTransactions)
      .where(eq(processedTransactions.zoneId, zone.id));
    expect(procRows).toHaveLength(0); // freed for re-upload
  });
});
