// packages/api/src/services/retention/cron.test.ts
// Phase 9 — tests for runRetentionSweep orchestration: multi-zone
// iteration, per-zone error isolation, audit fan-out (per-zone tenant
// row + platform-scope summary), no-op skip on a zone that touched
// nothing, and soft-deleted zones excluded from the pass.
//
// RELEVANT FILES: ./cron.ts, ./sweep.ts, ./policy.ts

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, zones } from "@stewardledger/db/schema";

import { db } from "../../db";
import { runRetentionSweep } from "./cron";
import { updateRetentionPolicy } from "./policy";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedZone(opts: { softDeleted?: boolean } = {}): Promise<{
  id: string;
  slug: string;
}> {
  const slug = `cron-${unique()}`;
  const [row] = await db
    .insert(zones)
    .values({
      slug,
      name: `Cron Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
      deletedAt: opts.softDeleted ? new Date() : null,
    })
    .returning({ id: zones.id, slug: zones.slug });
  return row;
}

const cleanupSlugs: string[] = [];

beforeAll(() => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("cron.test.ts requires a *_test DATABASE_URL");
  }
});

afterAll(async () => {
  // Best-effort cleanup. The platform-scope summary rows
  // (`platform.retention.sweep.run`) are zone-less so they can't be
  // wiped on a per-slug basis; do that explicitly.
  for (const slug of cleanupSlugs) {
    const zoneIdSubq = sql`(select id from zones where slug = ${slug})`;
    await db.execute(sql`delete from audit_events where zone_id = ${zoneIdSubq}`);
    await db.execute(sql`delete from zones where slug = ${slug}`);
  }
  await db
    .delete(auditEvents)
    .where(eq(auditEvents.action, "platform.retention.sweep.run"));
});

describe("runRetentionSweep", () => {
  it("emits a platform-scope summary row even when no zone changed", async () => {
    const zone = await seedZone();
    cleanupSlugs.push(zone.slug);
    // Seed an audit row that's only a day old so the 5-year default
    // window cannot touch it. The pass should still write the
    // platform summary; it should NOT write a per-zone row.
    await db.insert(auditEvents).values({
      zoneId: zone.id,
      action: "member.create",
      entityType: "member",
      occurredAt: new Date(),
    });
    const before = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "platform.retention.sweep.run"));
    const result = await runRetentionSweep(db);
    const after = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "platform.retention.sweep.run"));
    expect(after.length).toBe(before.length + 1);
    expect(result.zonesScanned).toBeGreaterThanOrEqual(1);
    // No per-zone row for this zone (nothing was deleted).
    const perZone = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        sql`${auditEvents.zoneId} = ${zone.id} and ${auditEvents.action} = 'zone.retention.sweep'`,
      );
    expect(perZone.length).toBe(0);
  });

  it("writes a per-zone tenant audit row when the pass deleted something", async () => {
    const zone = await seedZone();
    cleanupSlugs.push(zone.slug);
    // Tighten the policy so a 30-day-old row gets swept on this pass.
    await updateRetentionPolicy(db, {
      zoneId: zone.id,
      actorUserId: null,
      policy: { audit_events: { retainDays: 7 } },
    });
    await db.insert(auditEvents).values({
      zoneId: zone.id,
      action: "member.create",
      entityType: "member",
      occurredAt: new Date(Date.now() - 30 * 86_400_000),
    });

    await runRetentionSweep(db);

    const perZone = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(
        sql`${auditEvents.zoneId} = ${zone.id} and ${auditEvents.action} = 'zone.retention.sweep'`,
      );
    expect(perZone.length).toBe(1);
    const summary = perZone[0].after as { audit_events: number };
    expect(summary.audit_events).toBeGreaterThanOrEqual(1);
  });

  it("skips soft-deleted zones (deleted_at IS NOT NULL)", async () => {
    const dead = await seedZone({ softDeleted: true });
    cleanupSlugs.push(dead.slug);
    // Seed an aged row that WOULD be swept if the zone were live.
    await db.insert(auditEvents).values({
      zoneId: dead.id,
      action: "member.create",
      entityType: "member",
      occurredAt: new Date(Date.now() - 365 * 86_400_000),
    });
    // Tighten the policy directly via raw update because the service
    // layer wouldn't refuse a soft-deleted zone but cron-time
    // selection is the contract we're testing.
    await db
      .update(zones)
      .set({ retentionPolicy: { audit_events: { retainDays: 7 } } })
      .where(eq(zones.id, dead.id));

    await runRetentionSweep(db);

    const remaining = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.zoneId, dead.id));
    // The seeded row is still there because the soft-deleted zone
    // was never visited.
    expect(remaining.length).toBe(1);
  });

  it("isolates per-zone errors: a broken zone does not block other zones", async () => {
    const good = await seedZone();
    cleanupSlugs.push(good.slug);
    // Tighten + seed something old so we can confirm the good zone
    // was actually swept.
    await updateRetentionPolicy(db, {
      zoneId: good.id,
      actorUserId: null,
      policy: { audit_events: { retainDays: 7 } },
    });
    await db.insert(auditEvents).values({
      zoneId: good.id,
      action: "member.create",
      entityType: "member",
      occurredAt: new Date(Date.now() - 30 * 86_400_000),
    });

    // Drop in a "broken" zone with an absurd policy that the column-
    // level safeParse fallback recovers from. (Stored shape uses an
    // unknown key + a string-typed retainDays. The fallback parser
    // falls back to `{}` and the pass continues.)
    const broken = await seedZone();
    cleanupSlugs.push(broken.slug);
    await db.execute(
      sql`update zones set retention_policy = '{"bogus": 1}'::jsonb where id = ${broken.id}`,
    );

    const result = await runRetentionSweep(db);
    expect(result.zonesScanned).toBeGreaterThanOrEqual(2);

    // good zone got its row swept
    const goodSummary = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        sql`${auditEvents.zoneId} = ${good.id} and ${auditEvents.action} = 'zone.retention.sweep'`,
      );
    expect(goodSummary.length).toBe(1);
  });
});
