// packages/api/src/services/retention/sweep.test.ts
// Phase 9 — per-dimension sweep tests. Each suite seeds a small
// fixture, asserts the sweep deletes the expected rows, and confirms
// cross-zone isolation + the "retainDays === 0 → no-op" sentinel.
//
// RELEVANT FILES: ./sweep.ts, ./policy.ts

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  reportJobs,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";

import { db } from "../../db";
import { importFiles } from "@stewardledger/db/schema";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { sweepAuditEvents, sweepImportFiles, sweepReportJobs } from "./sweep";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedZone(slug: string): Promise<{ id: string; slug: string }> {
  const [row] = await db
    .insert(zones)
    .values({
      slug,
      name: `Retention Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug });
  return row;
}

async function seedUser(): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({
    id,
    email: `ret-${unique()}@example.com`,
    emailVerified: true,
  });
  return id;
}

const cleanupSlugs: string[] = [];
const cleanupUserIds: string[] = [];

beforeAll(() => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("sweep.test.ts requires a *_test DATABASE_URL");
  }
});

afterAll(async () => {
  for (const slug of cleanupSlugs) {
    const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
    await db.execute(sql`delete from audit_events where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from report_jobs where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from import_files where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from zones where slug = ${slug}`);
  }
  for (const id of cleanupUserIds) {
    await db.execute(sql`delete from "user" where id = ${id}`);
  }
  setStorageForTesting(null);
});

describe("sweepAuditEvents", () => {
  it("deletes tenant-scope rows older than the window, leaves platform rows alone", async () => {
    const zone = await seedZone(`ret-ae-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const old = new Date(Date.now() - 30 * 86_400_000); // 30 days ago
    const fresh = new Date(Date.now() - 1 * 86_400_000); // 1 day ago

    await db.insert(auditEvents).values([
      { zoneId: zone.id, action: "member.create", entityType: "member", occurredAt: old },
      { zoneId: zone.id, action: "member.update", entityType: "member", occurredAt: old },
      { zoneId: zone.id, action: "member.delete", entityType: "member", occurredAt: old },
      { zoneId: zone.id, action: "member.create", entityType: "member", occurredAt: fresh },
      { zoneId: zone.id, action: "member.create", entityType: "member", occurredAt: fresh },
    ]);
    await db.insert(auditEvents).values({
      zoneId: null,
      action: "platform.audit.test",
      entityType: "platform",
      occurredAt: old,
    });

    const result = await sweepAuditEvents(db, zone.id, 7); // keep last 7 days
    expect(result.deleted).toBe(3);

    const remaining = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.zoneId, zone.id));
    expect(remaining.length).toBe(2);

    // Platform row untouched (filter is `zone_id = $1`).
    const platform = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "platform.audit.test")));
    expect(platform.length).toBe(1);

    await db
      .delete(auditEvents)
      .where(eq(auditEvents.action, "platform.audit.test"));
  });

  it("is a no-op when retainDays is 0", async () => {
    const zone = await seedZone(`ret-ae0-${unique()}`);
    cleanupSlugs.push(zone.slug);
    await db.insert(auditEvents).values({
      zoneId: zone.id,
      action: "member.create",
      entityType: "member",
      occurredAt: new Date(Date.now() - 365 * 86_400_000),
    });
    const result = await sweepAuditEvents(db, zone.id, 0);
    expect(result.deleted).toBe(0);
    const remaining = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.zoneId, zone.id));
    expect(remaining.length).toBe(1);
  });

  it("does not touch rows in other zones", async () => {
    const zoneA = await seedZone(`ret-iso-a-${unique()}`);
    const zoneB = await seedZone(`ret-iso-b-${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);
    const old = new Date(Date.now() - 30 * 86_400_000);
    await db.insert(auditEvents).values([
      { zoneId: zoneA.id, action: "x.create", entityType: "x", occurredAt: old },
      { zoneId: zoneB.id, action: "x.create", entityType: "x", occurredAt: old },
    ]);
    const result = await sweepAuditEvents(db, zoneA.id, 7);
    expect(result.deleted).toBe(1);
    const bRows = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.zoneId, zoneB.id));
    expect(bRows.length).toBe(1);
  });
});

describe("sweepReportJobs", () => {
  it("deletes expired rows whose completed_at is past the window", async () => {
    const zone = await seedZone(`ret-rj-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const u = await seedUser();
    cleanupUserIds.push(u);
    const old = new Date(Date.now() - 30 * 86_400_000);
    const fresh = new Date(Date.now() - 1 * 86_400_000);
    const futureExpiry = new Date(Date.now() + 86_400_000);

    await db.insert(reportJobs).values([
      {
        zoneId: zone.id,
        userId: u,
        reportId: "member-list",
        format: "xlsx",
        status: "expired",
        completedAt: old,
        expiresAt: futureExpiry,
      },
      {
        zoneId: zone.id,
        userId: u,
        reportId: "member-list",
        format: "xlsx",
        status: "expired",
        completedAt: fresh,
        expiresAt: futureExpiry,
      },
      {
        // completed but not yet expired — retention sweep does not touch it.
        zoneId: zone.id,
        userId: u,
        reportId: "member-list",
        format: "xlsx",
        status: "completed",
        completedAt: old,
        expiresAt: futureExpiry,
      },
    ]);

    const result = await sweepReportJobs(db, zone.id, 7);
    expect(result.deleted).toBe(1);

    const remaining = await db
      .select({ status: reportJobs.status })
      .from(reportJobs)
      .where(eq(reportJobs.zoneId, zone.id));
    expect(remaining.length).toBe(2);
    expect(remaining.some((r) => r.status === "completed")).toBe(true);
  });

  it("is a no-op when retainDays is 0", async () => {
    const zone = await seedZone(`ret-rj0-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const u = await seedUser();
    cleanupUserIds.push(u);
    await db.insert(reportJobs).values({
      zoneId: zone.id,
      userId: u,
      reportId: "member-list",
      format: "xlsx",
      status: "expired",
      completedAt: new Date(Date.now() - 365 * 86_400_000),
      expiresAt: new Date(),
    });
    const result = await sweepReportJobs(db, zone.id, 0);
    expect(result.deleted).toBe(0);
  });
});

describe("sweepImportFiles", () => {
  it("deletes the blob and flips purged_at; never hard-deletes the row", async () => {
    const zone = await seedZone(`ret-if-${unique()}`);
    cleanupSlugs.push(zone.slug);
    const storageImpl = new InMemoryStorage();
    setStorageForTesting(storageImpl);
    const oldKey = `${zone.id}/imports/2020/01/old.csv`;
    const freshKey = `${zone.id}/imports/${new Date().getUTCFullYear()}/01/fresh.csv`;
    await storageImpl.put(oldKey, new Uint8Array([1, 2, 3]));
    await storageImpl.put(freshKey, new Uint8Array([4, 5, 6]));
    await db.insert(importFiles).values([
      {
        zoneId: zone.id,
        originalFileName: "old.csv",
        storageKey: oldKey,
        sizeBytes: 3,
        checksumSha256: "deadbeef",
        fileType: "statement",
        sourceType: "generic_csv",
        uploadedAt: new Date(Date.now() - 365 * 86_400_000),
      },
      {
        zoneId: zone.id,
        originalFileName: "fresh.csv",
        storageKey: freshKey,
        sizeBytes: 3,
        checksumSha256: "feedface",
        fileType: "statement",
        sourceType: "generic_csv",
        uploadedAt: new Date(Date.now() - 1 * 86_400_000),
      },
    ]);

    const result = await sweepImportFiles(db, zone.id, 30);
    expect(result.deleted).toBe(1);

    const rows = await db
      .select({
        originalFileName: importFiles.originalFileName,
        purgedAt: importFiles.purgedAt,
      })
      .from(importFiles)
      .where(eq(importFiles.zoneId, zone.id));
    // Both rows survive — we never hard-delete (FK from import_jobs
    // is restrict).
    expect(rows.length).toBe(2);
    const oldRow = rows.find((r) => r.originalFileName === "old.csv");
    const freshRow = rows.find((r) => r.originalFileName === "fresh.csv");
    expect(oldRow?.purgedAt).not.toBeNull();
    expect(freshRow?.purgedAt).toBeNull();

    // Old blob is gone, fresh blob is still there.
    expect(storageImpl.size()).toBe(1);
  });

  it("skips rows already purged on a prior pass", async () => {
    const zone = await seedZone(`ret-if2-${unique()}`);
    cleanupSlugs.push(zone.slug);
    setStorageForTesting(new InMemoryStorage());
    await db.insert(importFiles).values({
      zoneId: zone.id,
      originalFileName: "already.csv",
      storageKey: "x",
      sizeBytes: 1,
      checksumSha256: "cafebabe",
      fileType: "statement",
      sourceType: "generic_csv",
      uploadedAt: new Date(Date.now() - 365 * 86_400_000),
      purgedAt: new Date(Date.now() - 30 * 86_400_000),
    });
    const result = await sweepImportFiles(db, zone.id, 7);
    expect(result.deleted).toBe(0);
  });
});
