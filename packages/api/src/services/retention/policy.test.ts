// packages/api/src/services/retention/policy.test.ts
// Phase 9 — service-layer tests for the retention policy reader /
// writer. Covers default hydration, audit row on real change, no-op
// on duplicate write, and the "compact" behaviour (defaults stripped
// from the stored column).
//
// RELEVANT FILES: ./policy.ts, ../audit.ts

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import { DEFAULT_RETENTION_POLICY } from "@stewardledger/shared";

import { db } from "../../db";
import {
  loadRetentionPolicy,
  RetentionPolicyError,
  updateRetentionPolicy,
} from "./policy";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const cleanupSlugs: string[] = [];
const cleanupUserIds: string[] = [];

async function seedZone(): Promise<{ id: string; slug: string }> {
  const slug = `pol-${unique()}`;
  cleanupSlugs.push(slug);
  const [row] = await db
    .insert(zones)
    .values({
      slug,
      name: `Policy Zone ${unique()}`,
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
  cleanupUserIds.push(id);
  await db.insert(userTable).values({
    id,
    email: `pol-${unique()}@example.com`,
    emailVerified: true,
  });
  return id;
}

beforeAll(() => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("policy.test.ts requires a *_test DATABASE_URL");
  }
});

afterAll(async () => {
  for (const slug of cleanupSlugs) {
    const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
    await db.execute(sql`delete from audit_events where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from zones where slug = ${slug}`);
  }
  for (const id of cleanupUserIds) {
    await db.execute(sql`delete from "user" where id = ${id}`);
  }
});

describe("loadRetentionPolicy", () => {
  it("returns hydrated defaults for a fresh zone", async () => {
    const zone = await seedZone();
    const policy = await loadRetentionPolicy(db, zone.id);
    expect(policy).toEqual(DEFAULT_RETENTION_POLICY);
  });

  it("throws zone_not_found for an unknown id", async () => {
    await expect(loadRetentionPolicy(db, "does-not-exist")).rejects.toBeInstanceOf(
      RetentionPolicyError,
    );
  });
});

describe("updateRetentionPolicy", () => {
  it("writes a partial policy + emits a single audit row", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    const result = await updateRetentionPolicy(db, {
      zoneId: zone.id,
      actorUserId: actor,
      policy: { audit_events: { retainDays: 30 } },
    });
    expect(result.audit_events.retainDays).toBe(30);
    expect(result.import_files.retainDays).toBe(
      DEFAULT_RETENTION_POLICY.import_files.retainDays,
    );
    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.zoneId, zone.id));
    expect(audits.map((a) => a.action)).toEqual([
      "zone.retention_policy.update",
    ]);
  });

  it("is a no-op + skips audit when the effective policy is unchanged", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    await updateRetentionPolicy(db, {
      zoneId: zone.id,
      actorUserId: actor,
      policy: { audit_events: { retainDays: 30 } },
    });
    // Second write with the same value — should be a no-op.
    await updateRetentionPolicy(db, {
      zoneId: zone.id,
      actorUserId: actor,
      policy: { audit_events: { retainDays: 30 } },
    });
    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.zoneId, zone.id));
    expect(audits.length).toBe(1);
  });

  it("merges partial input on top of the stored shape (does not reset other dimensions)", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    // First write tightens import_files.
    await updateRetentionPolicy(db, {
      zoneId: zone.id,
      actorUserId: actor,
      policy: { import_files: { retainDays: 30 } },
    });
    // Second write tightens audit_events only. The previous
    // import_files override must survive.
    const after = await updateRetentionPolicy(db, {
      zoneId: zone.id,
      actorUserId: actor,
      policy: { audit_events: { retainDays: 60 } },
    });
    expect(after.audit_events.retainDays).toBe(60);
    expect(after.import_files.retainDays).toBe(30);
  });

  it("re-validates input inside the service layer", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    await expect(
      updateRetentionPolicy(db, {
        zoneId: zone.id,
        actorUserId: actor,
        // Bypassing the route, so the service has to be the guard.
        policy: { audit_events: { retainDays: -1 } } as never,
      }),
    ).rejects.toThrow();
  });

  it("strips defaults from the stored column (compactPolicy)", async () => {
    const zone = await seedZone();
    const actor = await seedUser();
    await updateRetentionPolicy(db, {
      zoneId: zone.id,
      actorUserId: actor,
      // Mix of override + default value. The default should not be
      // persisted; the override should be.
      policy: {
        audit_events: { retainDays: 30 },
        import_files: {
          retainDays: DEFAULT_RETENTION_POLICY.import_files.retainDays,
        },
      },
    });
    const [row] = await db
      .select({ retentionPolicy: zones.retentionPolicy })
      .from(zones)
      .where(eq(zones.id, zone.id))
      .limit(1);
    expect(row.retentionPolicy).toEqual({ audit_events: { retainDays: 30 } });
  });
});
