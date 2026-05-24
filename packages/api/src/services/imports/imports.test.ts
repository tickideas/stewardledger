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
  contributions,
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
  otherChapterId: string;
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
    .returning({ id: chapters.id });

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
    otherChapterId: otherChapter.id,
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
