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
// unambiguous and never touches a real tenant. The script refuses to run
// against NODE_ENV=production unless --force-production is passed, and
// prints the database host before doing anything destructive.

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
  zones,
} from "@stewardledger/db/schema";
import * as schema from "@stewardledger/db/schema";
import { dropDemoZones } from "../src/services/demo-seed";
import { seedZoneGivingSetup } from "../src/services/giving-setup-seed";
import { seedZoneLookups } from "../src/services/lookup-seed";
import { seedZonePeriods } from "../src/services/period-seed";
import { seedZoneRoles } from "../src/services/role-seed";
import { nextChapterReferenceCode } from "../src/services/chapter-codes";

// Load .env from repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
config({ path: resolve(repoRoot, ".env") });

const DEMO_SLUG_PREFIX = "demo-";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const args = new Set(process.argv.slice(2));
const isReset = args.has("--reset");

// Hard guard: never silently mutate a production database. The reset path
// temporarily disables posted-contribution triggers; running that against
// real data would be catastrophic.
if (process.env.NODE_ENV === "production" && !args.has("--force-production")) {
  console.error(
    "Refusing to run against NODE_ENV=production. Pass --force-production if you really mean it.",
  );
  process.exit(1);
}
const dbHost = (() => {
  try {
    return new URL(databaseUrl).host;
  } catch {
    return "<unparseable DATABASE_URL>";
  }
})();
console.log(`[seed:demo] target database: ${dbHost} (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);
if (isReset) {
  console.log(`[seed:demo] --reset: will delete existing zones with slug prefix "${DEMO_SLUG_PREFIX}"`);
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

const SPECS: readonly DemoZoneSpec[] = [
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

async function dropExistingDemoZones(slugs: readonly string[]): Promise<void> {
  const { deletedZones } = await dropDemoZones(db, slugs, DEMO_SLUG_PREFIX);
  if (deletedZones > 0) {
    console.log(`[seed:demo] removed ${deletedZones} existing demo zone(s)`);
  }
}

/** Return the union of last year + this year of seeded Sundays for a zone. */
async function loadSundays(
  zoneId: string,
  spec: DemoZoneSpec,
): Promise<{ id: string; date: string }[]> {
  const today = new Date().toISOString().slice(0, 10);
  // Always seed last year as well so a January run still finds recent
  // Sundays. seedZonePeriods is idempotent on (zone, date) — re-running for
  // the current year is a no-op.
  await seedZonePeriods(
    db,
    zoneId,
    { fiscalYearStartMonth: 1, ministryYearStartMonth: 3 },
    new Date(new Date().getUTCFullYear() - 1, 0, 1),
  );

  void spec;
  const rows = await db
    .select({ id: givingPeriods.id, date: givingPeriods.date })
    .from(givingPeriods)
    .where(and(eq(givingPeriods.zoneId, zoneId), eq(givingPeriods.weekday, 7))) // ISO 7 = Sun
    .orderBy(givingPeriods.date);
  // Only past-or-today Sundays — demo contributions must never be future-dated.
  return rows.filter((p) => p.date <= today);
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

  // 2. Seed everything signup would normally seed (current year only).
  await seedZoneRoles(db, zone.id);
  await seedZoneLookups(db, zone.id);
  await seedZoneGivingSetup(db, zone.id, spec.currency);
  await seedZonePeriods(db, zone.id, {
    fiscalYearStartMonth: 1,
    ministryYearStartMonth: 3,
  });

  // 3. Load seeded lookups we'll need to wire contributions. Failures here
  //    mean the seed dependencies upstream have changed; surface a clear
  //    message instead of an `undefined` deref.
  const givingTypeRows = await db
    .select({ id: givingTypes.id, shortCode: givingTypes.shortCode })
    .from(givingTypes)
    .where(eq(givingTypes.zoneId, zone.id));
  const givingTypeByCode = new Map(givingTypeRows.map((g) => [g.shortCode, g.id]));

  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.zoneId, zone.id));
  const generalFund = accountRows.find((a) => a.name === "General Fund");
  if (!generalFund) {
    throw new Error(
      `[seed:demo] zone ${spec.slug}: missing "General Fund" account (seedZoneGivingSetup contract changed?). Found: ${accountRows
        .map((a) => a.name)
        .join(", ")}`,
    );
  }
  const generalFundId = generalFund.id;

  const paymentMethodRows = await db
    .select({ id: paymentMethods.id, code: paymentMethods.code })
    .from(paymentMethods)
    .where(eq(paymentMethods.zoneId, zone.id));
  const cashMethod = paymentMethodRows.find((p) => p.code === "cash");
  if (!cashMethod) {
    throw new Error(
      `[seed:demo] zone ${spec.slug}: missing "cash" payment method (seedZoneGivingSetup contract changed?). Found: ${paymentMethodRows
        .map((p) => p.code)
        .join(", ")}`,
    );
  }
  const cashMethodId = cashMethod.id;

  // Last 12 past-or-today Sundays across this year + last year. Never future.
  const allPastSundays = await loadSundays(zone.id, spec);
  const periodsToUse = allPastSundays.slice(-12);
  if (periodsToUse.length === 0) {
    throw new Error(
      `[seed:demo] no past Sundays available for zone ${spec.slug}; seedZonePeriods produced nothing usable`,
    );
  }
  // Assert all picked dates are in the past — invariant.
  const today = new Date().toISOString().slice(0, 10);
  for (const p of periodsToUse) {
    if (p.date > today) {
      throw new Error(`[seed:demo] invariant: picked future date ${p.date}`);
    }
  }

  // 4. Create chapters and members. Member inserts are batched per chapter.
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

    // Member reference codes are generated by counting existing rows under
    // a per-zone advisory lock. The lock is transaction-scoped, so we have
    // to do the count + insert inside one tx. We allocate codes locally
    // from `count + 1`, build the rows, and insert in a single batch.
    const memberIds: string[] = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${zone.id}))`);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(members)
        .where(eq(members.zoneId, zone.id));
      const startAt = (count ?? 0) + 1;
      const memberRows: typeof members.$inferInsert[] = [];
      for (let i = 0; i < chSpec.memberCount; i++) {
        memberRows.push({
          zoneId: zone.id,
          chapterId: chapter.id,
          referenceCode: `M${String(startAt + i).padStart(7, "0")}`,
          firstName: pick(FIRST_NAMES, rng),
          lastName: pick(LAST_NAMES, rng),
          gender: rng() < 0.5 ? "M" : "F",
          isActive: true,
        });
      }
      const inserted = await tx
        .insert(members)
        .values(memberRows)
        .returning({ id: members.id });
      return inserted.map((m) => m.id);
    });

    // 5. A handful of posted contributions per chapter, distributed across
    //    recent Sundays. Built in three phases because the posted-guard
    //    trigger forbids inserting lines under a parent that's already
    //    posted: insert all parents as `draft`, insert lines/members, then
    //    UPDATE them all to `posted` in a single statement.
    const numContribs = Math.max(8, Math.floor(chSpec.memberCount * 0.8));
    const draftRows: typeof contributions.$inferInsert[] = [];
    const draftMeta: { givingTypeId: string; amount: string; memberId: string | null }[] = [];
    for (let i = 0; i < numContribs; i++) {
      const memberId = memberIds[Math.floor(rng() * memberIds.length)] ?? null;
      const period = periodsToUse[Math.floor(rng() * periodsToUse.length)]!;
      const givingCode = pick(GIVING_SHORT_CODES, rng);
      const givingTypeId = givingTypeByCode.get(givingCode);
      if (!givingTypeId) continue;
      const base =
        givingCode === "TITHE" ? 50 + Math.floor(rng() * 400) :
        givingCode === "OFFERING" ? 5 + Math.floor(rng() * 60) :
        givingCode === "PARTNER" ? 20 + Math.floor(rng() * 200) :
        10 + Math.floor(rng() * 100);
      const amount = `${base}.0000`;
      draftRows.push({
        zoneId: zone.id,
        chapterId: chapter.id,
        memberId,
        sourceType: "manual",
        paymentMethodId: cashMethodId,
        givingPeriodId: period.id,
        contributionDate: period.date,
        totalAmount: amount,
        currencyCode: spec.currency,
        status: "draft",
        description: `Demo ${givingCode.toLowerCase()}`,
      });
      draftMeta.push({ givingTypeId, amount, memberId });
    }
    if (draftRows.length === 0) continue;

    const insertedContribs = await db
      .insert(contributions)
      .values(draftRows)
      .returning({ id: contributions.id });

    const lineRows: typeof contributionLines.$inferInsert[] = [];
    const memberAllocRows: typeof contributionMembers.$inferInsert[] = [];
    for (let i = 0; i < insertedContribs.length; i++) {
      const cId = insertedContribs[i]!.id;
      const meta = draftMeta[i]!;
      lineRows.push({
        zoneId: zone.id,
        contributionId: cId,
        givingTypeId: meta.givingTypeId,
        accountId: generalFundId,
        amount: meta.amount,
        currencyCode: spec.currency,
      });
      if (meta.memberId) {
        memberAllocRows.push({
          zoneId: zone.id,
          contributionId: cId,
          memberId: meta.memberId,
          allocationPercent: "100.00",
        });
      }
    }
    await db.insert(contributionLines).values(lineRows);
    if (memberAllocRows.length > 0) {
      await db.insert(contributionMembers).values(memberAllocRows);
    }
    // Promote all drafts to posted in one statement.
    await db
      .update(contributions)
      .set({ status: "posted", postedAt: new Date() })
      .where(
        inArray(
          contributions.id,
          insertedContribs.map((r) => r.id),
        ),
      );
  }

  console.log(`[seed:demo] seeded ${spec.slug} — ${spec.chapters.length} chapters`);
}

async function main(): Promise<void> {
  if (isReset) {
    await dropExistingDemoZones(SPECS.map((s) => s.slug));
  }

  // Build the work list without mutating SPECS. On a non-reset run, skip any
  // slug that's already seeded.
  let pending: readonly DemoZoneSpec[] = SPECS;
  if (!isReset) {
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
    pending = SPECS.filter((s) => !skip.has(s.slug));
  }

  if (pending.length === 0) {
    console.log("[seed:demo] nothing to do");
    return;
  }
  for (const spec of pending) {
    await seedZone(spec);
  }
  console.log(`[seed:demo] done. ${pending.length} zone(s) seeded.`);
}

try {
  await main();
} catch (err) {
  console.error("[seed:demo] failed:", err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
