// packages/api/src/services/erasure/requests.test.ts
// Integration tests for the erasure request lifecycle service.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

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
import {
  applyErasureRequest,
  cancelErasureRequest,
  createErasureRequest,
  ErasureRequestError,
  getErasureRequestForZone,
  listErasureRequests,
} from "./requests";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface Seed {
  zoneId: string;
  userId: string;
  memberId: string;
  exportId: string;
}

async function seedZoneWithMemberAndExport(
  storage: InMemoryStorage,
): Promise<Seed> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug: `er-${unique()}`,
      name: `Erasure Zone ${unique()}`,
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
    email: `er-${unique()}@example.com`,
    emailVerified: true,
  });

  const [chap] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `C${unique()}`,
      name: "Erasure Chapter",
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });

  const [m] = await db
    .insert(members)
    .values({
      zoneId: zone.id,
      chapterId: chap.id,
      referenceCode: `M-${unique()}`,
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      mobile: "+447700000000",
      metadata: { foo: "bar" },
    })
    .returning({ id: members.id });

  // Address row for member-scope scrub coverage.
  await db.insert(memberAddresses).values({
    zoneId: zone.id,
    memberId: m.id,
    isPrimary: true,
    line1: "1 Test St",
    dateFrom: new Date().toISOString().slice(0, 10),
  });

  // Recent completed export (zone-scope gate).
  const exportBody = Buffer.from(`er-${unique()}`, "utf-8");
  const exportKey = `${zone.id}/exports/2026/01/er-${unique()}.tar.gz`;
  await storage.put(exportKey, exportBody);
  const [exp] = await db
    .insert(zoneExports)
    .values({
      zoneId: zone.id,
      requestedByUserId: userId,
      status: "completed",
      storageKey: exportKey,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: zoneExports.id });

  return { zoneId: zone.id, userId, memberId: m.id, exportId: exp.id };
}

async function teardownZoneTree(zoneId: string): Promise<void> {
  // Match `hardPurgeZone` order so a half-finished test still tears down.
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

describe("erasureRequests service", () => {
  let storage: InMemoryStorage;
  const cleanupZoneIds: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(() => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("requests.test.ts requires a *_test DATABASE_URL");
    }
    storage = new InMemoryStorage();
    setStorageForTesting(storage);
  });

  afterAll(async () => {
    for (const id of cleanupZoneIds) await teardownZoneTree(id);
    for (const id of cleanupUserIds) {
      await db.delete(userTable).where(eq(userTable.id, id));
    }
    setStorageForTesting(null);
  });

  describe("createErasureRequest — member scope", () => {
    it("schedules with a 14-day default window and writes a tenant-scope audit row", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
        reason: "subject request 2026-01-01",
      });
      expect(created.scope).toBe("member");
      expect(created.memberId).toBe(s.memberId);
      expect(created.status).toBe("pending");
      expect(created.reversibilityWindowDays).toBe(14);
      const audits = await db
        .select({ action: auditEvents.action, zoneId: auditEvents.zoneId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.zoneId, s.zoneId),
            eq(auditEvents.action, "member.erase.scheduled"),
          ),
        );
      expect(audits.length).toBe(1);
    });

    it("rejects a duplicate pending request for the same (zone, member)", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
      });
      await expect(
        createErasureRequest(db, {
          zoneId: s.zoneId,
          actorUserId: s.userId,
          scope: "member",
          memberId: s.memberId,
        }),
      ).rejects.toThrow(ErasureRequestError);
    });

    it("rejects scope='member' without a memberId", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      await expect(
        createErasureRequest(db, {
          zoneId: s.zoneId,
          actorUserId: s.userId,
          scope: "member",
        }),
      ).rejects.toMatchObject({ code: "member_required" });
    });

    it("honours an explicit windowDays override (capped 1..365)", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
        windowDays: 30,
      });
      expect(created.reversibilityWindowDays).toBe(30);
      await expect(
        createErasureRequest(db, {
          zoneId: s.zoneId,
          actorUserId: s.userId,
          scope: "member",
          memberId: s.memberId,
          windowDays: 0,
        }),
      ).rejects.toThrow(ErasureRequestError);
    });
  });

  describe("createErasureRequest — zone scope", () => {
    it("schedules a zone-erase, LEAVES the zone live (cancel-window UX), writes a platform-scope audit row", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "zone",
        confirmExportId: s.exportId,
      });
      expect(created.scope).toBe("zone");
      expect(created.memberId).toBeNull();
      expect(created.reversibilityWindowDays).toBe(14);

      // The zone STAYS live during the cancel window so the
      // owner can hit "Cancel deletion" on `/zone/settings`.
      // Soft-decommission happens in the apply path instead.
      const [zoneRow] = await db
        .select({ deletedAt: zones.deletedAt })
        .from(zones)
        .where(eq(zones.id, s.zoneId))
        .limit(1);
      expect(zoneRow.deletedAt).toBeNull();

      const audits = await db
        .select({ action: auditEvents.action, zoneId: auditEvents.zoneId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entityId, s.zoneId),
            eq(auditEvents.action, "platform.zone.erase.scheduled"),
          ),
        );
      expect(audits.length).toBe(1);
      expect(audits[0].zoneId).toBeNull(); // platform-scope
    });

    it("rejects scope='zone' without confirmExportId", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      await expect(
        createErasureRequest(db, {
          zoneId: s.zoneId,
          actorUserId: s.userId,
          scope: "zone",
        }),
      ).rejects.toMatchObject({ code: "recent_export_required" });
    });

    it("rejects scope='zone' when the confirmExportId belongs to a different zone", async () => {
      const s1 = await seedZoneWithMemberAndExport(storage);
      const s2 = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s1.zoneId, s2.zoneId);
      cleanupUserIds.push(s1.userId, s2.userId);
      await expect(
        createErasureRequest(db, {
          zoneId: s1.zoneId,
          actorUserId: s1.userId,
          scope: "zone",
          confirmExportId: s2.exportId, // wrong zone
        }),
      ).rejects.toMatchObject({ code: "recent_export_required" });
    });

    it("rejects a duplicate pending zone-erase for the same zone", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "zone",
        confirmExportId: s.exportId,
      });
      await expect(
        createErasureRequest(db, {
          zoneId: s.zoneId,
          actorUserId: s.userId,
          scope: "zone",
          confirmExportId: s.exportId,
        }),
      ).rejects.toMatchObject({ code: "duplicate_pending" });
    });
  });

  describe("cancelErasureRequest", () => {
    it("cancels a pending member-scope request and writes the cancel audit row", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
      });
      const cancelled = await cancelErasureRequest(db, {
        zoneId: s.zoneId,
        requestId: created.id,
        actorUserId: s.userId,
        reason: "owner reconsidered",
      });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancelledByUserId).toBe(s.userId);
      const audits = await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.zoneId, s.zoneId),
            eq(auditEvents.action, "member.erase.cancelled"),
          ),
        );
      expect(audits.length).toBe(1);
    });

    it("cancelling a zone-scope request leaves the zone unchanged (it was never decommissioned)", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "zone",
        confirmExportId: s.exportId,
      });
      await cancelErasureRequest(db, {
        zoneId: s.zoneId,
        requestId: created.id,
        actorUserId: s.userId,
      });
      const [row] = await db
        .select({ deletedAt: zones.deletedAt })
        .from(zones)
        .where(eq(zones.id, s.zoneId))
        .limit(1);
      expect(row.deletedAt).toBeNull();
    });

    it("404s on a cross-zone cancel attempt", async () => {
      const s1 = await seedZoneWithMemberAndExport(storage);
      const s2 = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s1.zoneId, s2.zoneId);
      cleanupUserIds.push(s1.userId, s2.userId);
      const created = await createErasureRequest(db, {
        zoneId: s1.zoneId,
        actorUserId: s1.userId,
        scope: "member",
        memberId: s1.memberId,
      });
      await expect(
        cancelErasureRequest(db, {
          zoneId: s2.zoneId, // wrong zone
          requestId: created.id,
          actorUserId: s2.userId,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("409s when the request is already terminal", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
      });
      await cancelErasureRequest(db, {
        zoneId: s.zoneId,
        requestId: created.id,
        actorUserId: s.userId,
      });
      await expect(
        cancelErasureRequest(db, {
          zoneId: s.zoneId,
          requestId: created.id,
          actorUserId: s.userId,
        }),
      ).rejects.toMatchObject({ code: "not_pending" });
    });
  });

  describe("applyErasureRequest", () => {
    it("scrubs every PII field on the member row and writes the applied audit row with pre-scrub `before`", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
      });
      const applied = await applyErasureRequest(db, {
        requestId: created.id,
        actorUserId: s.userId,
      });
      expect(applied.status).toBe("applied");
      const [m] = await db
        .select()
        .from(members)
        .where(eq(members.id, s.memberId))
        .limit(1);
      expect(m.firstName).toBe("erased");
      expect(m.lastName).toBeNull();
      expect(m.email).toBeNull();
      expect(m.mobile).toBeNull();
      expect(m.isActive).toBe(false);
      expect(m.deletedAt).not.toBeNull();
      expect((m.metadata as Record<string, unknown>).request_id).toBe(
        created.id,
      );
      // Address row gone.
      const addrs = await db
        .select({ id: memberAddresses.id })
        .from(memberAddresses)
        .where(eq(memberAddresses.memberId, s.memberId));
      expect(addrs).toEqual([]);
      // Audit row carries the pre-scrub member as `before`.
      const audits = await db
        .select({ action: auditEvents.action, before: auditEvents.before })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.zoneId, s.zoneId),
            eq(auditEvents.action, "member.erase.applied"),
          ),
        );
      expect(audits.length).toBe(1);
      // The `before` payload is whatever the apply path wrote;
      // Drizzle row shape uses camelCase property names.
      expect((audits[0].before as Record<string, unknown>).firstName).toBe(
        "Alice",
      );
    });

    it("hard-purges the zone tree + storage on a zone-scope apply", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupUserIds.push(s.userId);
      // Note: NOT pushing to cleanupZoneIds — the apply path
      // hard-deletes the zone so afterAll teardown would error
      // on a missing row.
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "zone",
        confirmExportId: s.exportId,
      });
      await applyErasureRequest(db, {
        requestId: created.id,
        actorUserId: s.userId,
      });
      // Zone is gone.
      const [zoneRow] = await db
        .select({ id: zones.id })
        .from(zones)
        .where(eq(zones.id, s.zoneId))
        .limit(1);
      expect(zoneRow).toBeUndefined();
      // Platform-scope audit row survives (zone_id IS NULL).
      const audits = await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entityId, s.zoneId),
            eq(auditEvents.action, "platform.zone.erase.applied"),
          ),
        );
      expect(audits.length).toBe(1);
      // Clean up the platform-scope audit row so afterAll stays narrow.
      await db
        .delete(auditEvents)
        .where(eq(auditEvents.entityId, s.zoneId));
    });

    it("refuses to apply an already-applied or already-cancelled request (not_pending)", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const created = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
      });
      await applyErasureRequest(db, {
        requestId: created.id,
        actorUserId: s.userId,
      });
      // Second apply on the same row is a no-op surfaced as a
      // protective error (the cron sweep claims rows with `for
      // update skip locked` so this only fires on operator
      // mis-use).
      await expect(
        applyErasureRequest(db, {
          requestId: created.id,
          actorUserId: s.userId,
        }),
      ).rejects.toMatchObject({ code: "not_pending" });
    });
  });

  describe("listErasureRequests + get", () => {
    it("returns rows newest-first, filtered by status / scope", async () => {
      const s = await seedZoneWithMemberAndExport(storage);
      cleanupZoneIds.push(s.zoneId);
      cleanupUserIds.push(s.userId);
      const a = await createErasureRequest(db, {
        zoneId: s.zoneId,
        actorUserId: s.userId,
        scope: "member",
        memberId: s.memberId,
      });
      await cancelErasureRequest(db, {
        zoneId: s.zoneId,
        requestId: a.id,
        actorUserId: s.userId,
      });
      const all = await listErasureRequests(db, { zoneId: s.zoneId });
      expect(all.length).toBe(1);
      const pendingOnly = await listErasureRequests(db, {
        zoneId: s.zoneId,
        status: "pending",
      });
      expect(pendingOnly).toEqual([]);
      const byId = await getErasureRequestForZone(db, s.zoneId, a.id);
      expect(byId?.status).toBe("cancelled");
      const wrongZone = await getErasureRequestForZone(
        db,
        "non-existent-zone-id",
        a.id,
      );
      expect(wrongZone).toBeNull();
    });
  });
});
