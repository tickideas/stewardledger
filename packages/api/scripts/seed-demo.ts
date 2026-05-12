// packages/api/scripts/seed-demo.ts
// Seeds the local DB with a few demo zones, chapters, members, and a small
// pile of posted contributions so the super-admin dashboard has something
// real to show.
//
// Usage:
//   pnpm seed:demo                  # default: idempotent re-run, safe
//   pnpm seed:demo -- --reset       # delete demo zones first
//
// All demo zones use slugs prefixed with "demo-" so the cleanup is
// unambiguous and never touches a real tenant.

import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  chapters,
  contributionLines,
  contributionMembers,
  contributions,
  givingPeriods,
  givingTypes,
  members,
  paymentMethods,
  serviceEvents,
  serviceTypes,
  zones,
} from "@stewardledger/db/schema";

// Load .env from repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
config({ path: resolve(repoRoot, ".env") });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@stewardledger/db/schema";
import { seedZoneGivingSetup } from "../src/services/giving-setup-seed";
import { seedZoneLookups } from "../src/services/lookup-seed";
import { seedZonePeriods } from "../src/services/period-seed";
import { seedZoneRoles } from "../src/services/role-seed";
import { nextChapterReferenceCode } from "../src/services/chapter-codes";
import { nextMemberReferenceCode } from "../src/services/member-codes";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const client = postgres(databaseUrl);
const db = drizzle(client, { schema });

interface DemoZoneSpec {
  slug: string;
  name: string;
  legalName?: string;
  countryCode: string;
  currency: string;
  timeZone: string;
  chapters: { name: string; memberCount: number }[];
}

const SPECS: DemoZoneSpec[] = [
  {
    slug: "demo-grace-uk",
    name: "Grace Christian Centre UK",
    legalName: "Grace Christian Centre (UK) Ltd",
    countryCode: "GB",
    currency: "GBP",
    timeZone: "Europe/London",
    chapters: [
      { name: "London Central", memberCount: 28 },
      { name: "Manchester", memberCount: 19 },
      { name: "Birmingham", memberCount: 14 },
    ],
  },
  {
    slug: "demo-lighthouse-us",
    name: "Lighthouse Fellowship USA",
    countryCode: "US",
    currency: "USD",
    timeZone: "America/New_York",
    chapters: [
      { name: "Brooklyn", memberCount: 31 },
      { name: "Atlanta", memberCount: 22 },
    ],
  },
  {
    slug: "demo-river-ng",
    name: "River of Life Nigeria",
    countryCode: "NG",
    currency: "NGN",
    timeZone: "Africa/Lagos",
    chapters: [
      { name: "Lagos HQ", memberCount: 64 },
      { name: "Abuja", memberCount: 38 },
      { name: "Port Harcourt", memberCount: 24 },
      { name: "Ibadan", memberCount: 18 },
    ],
  },
];

const FIRST_NAMES = [
  "Aaron", "Abigail", "Adaeze", "Adam", "Adaora", "Aisha", "Akin", "Alex",
  "Alice", "Amaka", "Amos", "Andrea", "Angela", "Anita", "Anna", "Anthony",
  "Bola", "Brian", "Caleb", "Carla", "Chen", "Chidi", "Chinonso", "Chioma",
  "Chris", "Daniel", "David", "Deborah", "Eli", "Elizabeth", "Emeka", "Emma",
  "Esther", "Faith", "Femi", "Funmi", "Grace", "Hannah", "Henry", "Isaac",
  "Jacob", "James", "Jane", "Janelle", "Jared", "Jasmine", "Jennifer", "Joel",
  "John", "Joseph", "Joshua", "Joy", "Kelechi", "Kemi", "Lara", "Leah",
  "Linda", "Mark", "Mary", "Matthew", "Michael", "Nathan", "Ngozi", "Ola",
  "Olu", "Patricia", "Paul", "Peter", "Priscilla", "Rachel", "Ruth", "Sade",
  "Samuel", "Sarah", "Simon", "Stephen", "Tayo", "Tobi", "Tochukwu", "Tunde",
  "Victor", "Wale", "Yemi", "Yusuf", "Zara", "Zion",
];
const LAST_NAMES = [
  "Adebayo", "Adeyemi", "Anderson", "Brown", "Chen", "Clark", "Davis",
  "Eze", "Garcia", "Harris", "Jackson", "Johnson", "Jones", "Kim",
  "King", "Lewis", "Martin", "Martinez", "Moore", "Nwosu", "Obi",
  "Ogun", "Okafor", "Okeke", "Okonkwo", "Patel", "Perez", "Rivera",
  "Robinson", "Rodriguez", "Smith", "Taylor", "Thomas", "Thompson",
  "Walker", "Williams", "Wilson", "Wright", "Young",
];

const GIVING_SHORT_CODES = ["TITHE", "OFFERING", "PARTNER", "SPECIAL"] as const;

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

// Mulberry32 — tiny seeded PRNG so demo data is deterministic per zone slug.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSlug(slug: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h ^ slug.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

async function dropExistingDemoZones(slugs: string[]): Promise<void> {
  if (slugs.length === 0) return;
  // Find ids first, then cascade delete in a transaction with triggers
  // temporarily relaxed (posted contributions are immutable; we own the
  // demo data and can wipe it).
  const rows = await db
    .select({ id: zones.id, slug: zones.slug })
    .from(zones)
    .where(inArray(zones.slug, slugs));
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
    );
    const guards = [
      ["contributions", "contributions_posted_guard"],
      ["contributions", "contributions_no_delete_when_posted"],
      ["contribution_lines", "contribution_lines_posted_guard"],
    ] as const;
    for (const [t, n] of guards) {
      await tx.execute(sql.raw(`alter table ${t} disable trigger ${n}`));
    }
    try {
      // Delete in FK-safe order via drizzle's inArray.
      await tx.delete(contributionLines).where(inArray(contributionLines.zoneId, ids));
      await tx.delete(contributionMembers).where(inArray(contributionMembers.zoneId, ids));
      await tx.delete(contributions).where(inArray(contributions.zoneId, ids));
      await tx.delete(members).where(inArray(members.zoneId, ids));
      await tx.delete(chapters).where(inArray(chapters.zoneId, ids));
      await tx.delete(zones).where(inArray(zones.id, ids));
    } finally {
      for (const [t, n] of guards) {
        await tx.execute(sql.raw(`alter table ${t} enable trigger ${n}`));
      }
    }
  });
  console.log(`[seed:demo] removed ${rows.length} existing demo zone(s)`);
}

async function seedZone(spec: DemoZoneSpec): Promise<void> {
  const rng = makeRng(hashSlug(spec.slug));

  // 1. Insert the zone in active status with a placeholder region.
  const [zone] = await db
    .insert(zones)
    .values({
      slug: spec.slug,
      name: spec.name,
      legalName: spec.legalName,
      countryCode: spec.countryCode,
      defaultCurrencyCode: spec.currency,
      defaultTimeZone: spec.timeZone,
      fiscalYearStartMonth: 1,
      ministryYearStartMonth: 3,
      status: "active",
      activatedAt: new Date(),
      regionNameUnverified: `${spec.countryCode} Region (demo)`,
    })
    .returning({ id: zones.id });

  // 2. Seed everything signup would normally seed.
  await seedZoneRoles(db, zone.id);
  await seedZoneLookups(db, zone.id);
  await seedZoneGivingSetup(db, zone.id, spec.currency);
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });

  // 3. Load seeded lookups we'll need to wire contributions.
  const givingTypeRows = await db
    .select({ id: givingTypes.id, shortCode: givingTypes.shortCode })
    .from(givingTypes)
    .where(eq(givingTypes.zoneId, zone.id));
  const givingTypeByCode = new Map(givingTypeRows.map((g) => [g.shortCode, g.id]));

  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.zoneId, zone.id));
  const generalFundId = accountRows.find((a) => a.name === "General Fund")!.id;

  const paymentMethodRows = await db
    .select({ id: paymentMethods.id, code: paymentMethods.code })
    .from(paymentMethods)
    .where(eq(paymentMethods.zoneId, zone.id));
  const cashMethodId = paymentMethodRows.find((p) => p.code === "cash")!.id;

  const serviceTypeRows = await db
    .select({ id: serviceTypes.id, name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.zoneId, zone.id));
  const sundayServiceTypeId = serviceTypeRows.find((s) => s.name === "Sunday Service")!.id;

  // Use Sundays from the seeded calendar year so contributions land on real
  // giving_periods rows. weekday is ISO (1=Mon…7=Sun).
  const periodRows = await db
    .select({ id: givingPeriods.id, date: givingPeriods.date })
    .from(givingPeriods)
    .where(and(eq(givingPeriods.zoneId, zone.id), eq(givingPeriods.weekday, 7)))
    .orderBy(givingPeriods.date);

  // 4. Create chapters and members.
  for (const chSpec of spec.chapters) {
    const refCode = await nextChapterReferenceCode(db, zone.id);
    const [chapter] = await db
      .insert(chapters)
      .values({
        zoneId: zone.id,
        referenceCode: refCode,
        name: chSpec.name,
        countryCode: spec.countryCode,
        dateFrom: new Date().toISOString().slice(0, 10),
      })
      .returning({ id: chapters.id });

    const memberIds: string[] = [];
    for (let i = 0; i < chSpec.memberCount; i++) {
      const memberRef = await nextMemberReferenceCode(db, zone.id);
      const first = pick(FIRST_NAMES, rng);
      const last = pick(LAST_NAMES, rng);
      const [m] = await db
        .insert(members)
        .values({
          zoneId: zone.id,
          chapterId: chapter.id,
          referenceCode: memberRef,
          firstName: first,
          lastName: last,
          gender: rng() < 0.5 ? "M" : "F",
          isActive: true,
        })
        .returning({ id: members.id });
      memberIds.push(m.id);
    }

    // 5. A handful of posted contributions per chapter, randomly distributed
    //    across recent Sundays for visual variety in the dashboard.
    const today = new Date().toISOString().slice(0, 10);
    const recentPeriods = periodRows.filter((p) => p.date <= today).slice(-12);
    const periodsToUse = recentPeriods.length > 0 ? recentPeriods : periodRows.slice(-12);
    const numContribs = Math.max(8, Math.floor(chSpec.memberCount * 0.8));
    for (let i = 0; i < numContribs; i++) {
      const memberId = memberIds[Math.floor(rng() * memberIds.length)] ?? null;
      const period = periodsToUse[Math.floor(rng() * periodsToUse.length)];
      if (!period) continue;
      const contributionDate = period.date;
      const givingCode = pick(GIVING_SHORT_CODES, rng);
      const givingTypeId = givingTypeByCode.get(givingCode);
      if (!givingTypeId) continue;
      // Amount: weighted skew. Tithes tend to be higher; offerings smaller.
      const base =
        givingCode === "TITHE" ? 50 + Math.floor(rng() * 400) :
        givingCode === "OFFERING" ? 5 + Math.floor(rng() * 60) :
        givingCode === "PARTNER" ? 20 + Math.floor(rng() * 200) :
        10 + Math.floor(rng() * 100);
      const amount = `${base}.0000`;

      // Optional service event linking — keep it simple, don't create one per
      // contribution. Skip serviceEventId for the demo so we don't need to
      // pre-create events.
      void sundayServiceTypeId;
      void serviceEvents;

      // Insert as draft so the line + member rows can land, then promote
      // to posted. The posted-guard trigger forbids inserts under a posted
      // parent.
      const [c] = await db
        .insert(contributions)
        .values({
          zoneId: zone.id,
          chapterId: chapter.id,
          memberId,
          sourceType: "manual",
          paymentMethodId: cashMethodId,
          givingPeriodId: period.id,
          contributionDate,
          totalAmount: amount,
          currencyCode: spec.currency,
          status: "draft",
          description: `Demo ${givingCode.toLowerCase()}`,
        })
        .returning({ id: contributions.id });

      await db.insert(contributionLines).values({
        zoneId: zone.id,
        contributionId: c.id,
        givingTypeId,
        accountId: generalFundId,
        amount,
        currencyCode: spec.currency,
      });
      if (memberId) {
        await db.insert(contributionMembers).values({
          zoneId: zone.id,
          contributionId: c.id,
          memberId,
          allocationPercent: "100.00",
        });
      }
      await db
        .update(contributions)
        .set({ status: "posted", postedAt: new Date() })
        .where(eq(contributions.id, c.id));
    }
  }

  console.log(`[seed:demo] seeded ${spec.slug} — ${spec.chapters.length} chapters`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--reset")) {
    await dropExistingDemoZones(SPECS.map((s) => s.slug));
  } else {
    // Idempotent: skip any already-seeded slug.
    const existing = await db
      .select({ slug: zones.slug })
      .from(zones)
      .where(inArray(zones.slug, SPECS.map((s) => s.slug)));
    const skip = new Set(existing.map((r) => r.slug));
    if (skip.size > 0) {
      console.log(
        `[seed:demo] skipping already-seeded zones: ${[...skip].join(", ")} ` +
          `(re-run with --reset to recreate)`,
      );
    }
    for (const slug of skip) {
      const idx = SPECS.findIndex((s) => s.slug === slug);
      if (idx >= 0) SPECS.splice(idx, 1);
    }
  }

  if (SPECS.length === 0) {
    console.log("[seed:demo] nothing to do");
    return;
  }

  for (const spec of SPECS) {
    await seedZone(spec);
  }
  console.log(`[seed:demo] done. ${SPECS.length} zone(s) seeded.`);
}

try {
  await main();
} catch (err) {
  console.error("[seed:demo] failed:", err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
