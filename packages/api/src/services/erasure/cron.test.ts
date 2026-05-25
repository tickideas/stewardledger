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
import { applyErasureRequest, createErasureRequest } from "./requests";
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

  it("isolates a failing row: continues the loop, counts the failure in the summary", async () => {
    // Two genuinely past-due pending rows. We inject a failure
    // by spying on `applyErasureRequest` so the second call
    // throws; the cron must catch, bump `summary.failed`, and
    // keep going through the rest of the batch.
    const okA = await seedMember();
    const failingB = await seedMember();
    cleanupZoneIds.push(okA.zoneId, failingB.zoneId);
    cleanupUserIds.push(okA.userId, failingB.userId);

    const reqA = await createErasureRequest(db, {
      zoneId: okA.zoneId,
      actorUserId: okA.userId,
      scope: "member",
      memberId: okA.memberId,
      windowDays: 1,
    });
    const reqB = await createErasureRequest(db, {
      zoneId: failingB.zoneId,
      actorUserId: failingB.userId,
      scope: "member",
      memberId: failingB.memberId,
      windowDays: 1,
    });
    for (const id of [reqA.id, reqB.id]) {
      await db
        .update(erasureRequests)
        .set({
          appliesAt: new Date(Date.now() - 1000),
          createdAt: new Date(Date.now() - 1_000_000),
        })
        .where(eq(erasureRequests.id, id));
    }

    // Inject a stub apply path: when the failing row's id
    // comes through, throw. The cron must catch + count +
    // continue with the next row.
    const summary = await runErasureSweep(
      db,
      undefined,
      async (database, input) => {
        if (input.requestId === reqB.id) {
          throw new Error("simulated apply failure");
        }
        return applyErasureRequest(database, input);
      },
    );

    expect(summary.considered).toBe(2);
    expect(summary.applied).toBe(1);
    expect(summary.failed).toBe(1);

    // The good row still applied + scrubbed cleanly.
    const [appliedRow] = await db
      .select({ status: erasureRequests.status })
      .from(erasureRequests)
      .where(eq(erasureRequests.id, reqA.id))
      .limit(1);
    expect(appliedRow.status).toBe("applied");

    // The failing row stays `pending` (the spy threw before the
    // apply path could mark it failed). The cron's catch only
    // counts the failure for telemetry; flipping the request
    // status is the apply path's job, and the apply path was
    // intercepted. This matches production: a thrown error
    // outside `applyErasureRequest`'s own catch (e.g. a process
    // crash mid-call) leaves the row in `pending` for the next
    // sweep to retry.
    const [failingRow] = await db
      .select({ status: erasureRequests.status })
      .from(erasureRequests)
      .where(eq(erasureRequests.id, reqB.id))
      .limit(1);
    expect(failingRow.status).toBe("pending");
  });
});
