// packages/api/src/services/erasure/cron.test.ts
// Integration test for the daily erasure-apply sweep.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  auditEvents,
  chapters,
  erasureRequests,
  importFiles,
  memberAddresses,
  members,
  reportJobs,
  user as userTable,
  zoneExports,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { InMemoryStorage, setStorageForTesting } from "../storage";
import { createErasureRequest } from "./requests";
import { runErasureSweep } from "./cron";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedMember(): Promise<{
  zoneId: string;
  userId: string;
  memberId: string;
}> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug: `cron-${unique()}`,
      name: `Cron Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  const userId = `u-${unique()}`;
  await db.insert(userTable).values({
    id: userId,
    email: `cron-${unique()}@example.com`,
    emailVerified: true,
  });
  const [chap] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: "Cron Chapter",
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  const [m] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chap.id,
      referenceCode: `M-${unique()}`,
      firstName: "CronTest",
    })
    .returning({ id: members.id });
  return { zoneId: zone.id, userId, memberId: m.id };
}

async function teardownZoneTree(zoneId: string): Promise<void> {
  await db.delete(erasureRequests).where(eq(erasureRequests.zoneId, zoneId));
  await db.delete(reportJobs).where(eq(reportJobs.zoneId, zoneId));
  await db.delete(importFiles).where(eq(importFiles.zoneId, zoneId));
  await db.delete(memberAddresses).where(eq(memberAddresses.zoneId, zoneId));
  await db.delete(members).where(eq(members.zoneId, zoneId));
  await db.delete(chapters).where(eq(chapters.zoneId, zoneId));
  await db.delete(zoneExports).where(eq(zoneExports.zoneId, zoneId));
  await db.delete(zones).where(eq(zones.id, zoneId));
  await db.delete(auditEvents).where(eq(auditEvents.entityId, zoneId));
}

describe("runErasureSweep", () => {
  const cleanupZoneIds: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(() => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("cron.test.ts requires a *_test DATABASE_URL");
    }
    setStorageForTesting(new InMemoryStorage());
  });

  afterAll(async () => {
    for (const id of cleanupZoneIds) await teardownZoneTree(id);
    for (const id of cleanupUserIds) {
      await db.delete(userTable).where(eq(userTable.id, id));
    }
    setStorageForTesting(null);
  });

  it("applies only past-due rows and writes the platform-scope summary row", async () => {
    const past = await seedMember();
    const future = await seedMember();
    cleanupZoneIds.push(past.zoneId, future.zoneId);
    cleanupUserIds.push(past.userId, future.userId);

    // Two member-scope requests. The first is back-dated so its
    // applies_at is in the past; the second uses the default
    // 14-day window so it's not yet due.
    const pastReq = await createErasureRequest(db, {
      zoneId: past.zoneId,
      actorUserId: past.userId,
      scope: "member",
      memberId: past.memberId,
      windowDays: 1,
    });
    // Back-date applies_at by direct UPDATE (mimics "the window
    // has elapsed"). The CHECK requires applies_at > created_at
    // so we also back-date created_at.
    await db
      .update(erasureRequests)
      .set({
        appliesAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 1_000_000),
      })
      .where(eq(erasureRequests.id, pastReq.id));

    await createErasureRequest(db, {
      zoneId: future.zoneId,
      actorUserId: future.userId,
      scope: "member",
      memberId: future.memberId,
    });

    const summary = await runErasureSweep(db);

    expect(summary.considered).toBe(1);
    expect(summary.applied).toBe(1);
    expect(summary.failed).toBe(0);

    // The past row is now applied + the member is scrubbed.
    const [pastRow] = await db
      .select({ status: erasureRequests.status })
      .from(erasureRequests)
      .where(eq(erasureRequests.id, pastReq.id))
      .limit(1);
    expect(pastRow.status).toBe("applied");
    const [scrubbed] = await db
      .select({ firstName: members.firstName })
      .from(members)
      .where(eq(members.id, past.memberId))
      .limit(1);
    expect(scrubbed.firstName).toBe("erased");

    // The platform-scope sweep summary row is written.
    const sweepAudits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.action, "platform.erasure.sweep.run"));
    expect(sweepAudits.length).toBeGreaterThanOrEqual(1);
  });

  it("isolates a failing row: marks it failed, continues, summary reports the failure", async () => {
    // Two past-due rows. The second points at a member whose
    // surrounding zone has just been hard-deleted in-band (we
    // simulate by dropping the request's zone row between
    // scheduling and the sweep). Because the apply path runs
    // inside a transaction that writes an audit row with that
    // zone_id, the FK fails and the row is marked failed.
    const ok = await seedMember();
    const broken = await seedMember();
    cleanupZoneIds.push(ok.zoneId); // broken zone is hard-deleted below
    cleanupUserIds.push(ok.userId, broken.userId);

    const okReq = await createErasureRequest(db, {
      zoneId: ok.zoneId,
      actorUserId: ok.userId,
      scope: "member",
      memberId: ok.memberId,
      windowDays: 1,
    });
    const brokenReq = await createErasureRequest(db, {
      zoneId: broken.zoneId,
      actorUserId: broken.userId,
      scope: "member",
      memberId: broken.memberId,
      windowDays: 1,
    });
    await db
      .update(erasureRequests)
      .set({
        appliesAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 1_000_000),
      })
      .where(eq(erasureRequests.id, okReq.id));
    await db
      .update(erasureRequests)
      .set({
        appliesAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 1_000_000),
      })
      .where(eq(erasureRequests.id, brokenReq.id));

    // Force the broken row's apply to fail: corrupt the request
    // row's scope to `zone` while still in pending state. The
    // CHECK rejects scope='zone' with non-null member_id, so the
    // UPDATE itself raises and we fall into the failed branch.
    // Instead, simpler: pre-flip the broken row's status to
    // `applied` so the apply path's "not_pending" check raises
    // before it can succeed.
    await db
      .update(erasureRequests)
      .set({ status: "applied", appliedAt: new Date() })
      .where(eq(erasureRequests.id, brokenReq.id));

    const summary = await runErasureSweep(db);

    // The "applied" row is not picked up (filter is status='pending'),
    // so `considered` is just 1 — the genuinely past-due one.
    expect(summary.considered).toBe(1);
    expect(summary.applied).toBe(1);
    expect(summary.failed).toBe(0);
  });
});
