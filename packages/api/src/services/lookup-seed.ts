// packages/api/src/services/lookup-seed.ts
// Seeds the per-zone member lookup tables (titles, marital_statuses,
// member_types) with sensible defaults at zone creation. Operators can
// edit/disable rows post-seed via the tenant API.

import { maritalStatuses, memberTypes, titles } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

const TITLE_SEEDS: Array<{ name: string; gender?: "M" | "F" | null }> = [
  { name: "Mr", gender: "M" },
  { name: "Mrs", gender: "F" },
  { name: "Ms", gender: "F" },
  { name: "Miss", gender: "F" },
  { name: "Dr", gender: null },
  { name: "Pastor", gender: null },
  { name: "Deacon", gender: "M" },
  { name: "Deaconess", gender: "F" },
  { name: "Rev", gender: null },
  { name: "Bro", gender: "M" },
  { name: "Sis", gender: "F" },
];

const MARITAL_STATUS_SEEDS = ["Single", "Married", "Divorced", "Widowed", "Separated"];

const MEMBER_TYPE_SEEDS = [
  "Member",
  "Cell Leader",
  "Pastor",
  "Visitor",
  "Workforce",
];

/** Seed all member-related lookup tables for a freshly-created zone. */
export async function seedZoneLookups(database: Db, zoneId: string): Promise<void> {
  await database.insert(titles).values(
    TITLE_SEEDS.map((t, i) => ({
      zoneId,
      name: t.name,
      gender: t.gender ?? null,
      ordinal: i,
    })),
  );
  await database.insert(maritalStatuses).values(
    MARITAL_STATUS_SEEDS.map((name, i) => ({ zoneId, name, ordinal: i })),
  );
  await database.insert(memberTypes).values(
    MEMBER_TYPE_SEEDS.map((name, i) => ({ zoneId, name, ordinal: i })),
  );
}
