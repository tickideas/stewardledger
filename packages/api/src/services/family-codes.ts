// packages/api/src/services/family-codes.ts
// Family reference-code generator. Default format: `${prefix}{padded7}`,
// e.g. "F0000001". The prefix and pad can be overridden per zone via
// zones.branding.familyCode. The numeric tail is monotonic per zone. A
// transaction-scoped advisory lock serializes generation for each zone so
// two concurrent creates cannot choose the same count-based tail.
// RELEVANT FILES: packages/api/src/services/member-codes.ts, packages/api/src/services/families.ts, packages/db/src/schema/families.ts

import { sql } from "drizzle-orm";
import { DEFAULT_FAMILY_REFERENCE_PREFIX } from "@stewardledger/shared";
import { families, zones } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

interface BrandingFamilyCode {
  prefix?: string;
  pad?: number;
}

export async function nextFamilyReferenceCode(database: Db, zoneId: string): Promise<string> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`families:${zoneId}`}))`);

  const [zone] = await database
    .select({ branding: zones.branding })
    .from(zones)
    .where(sql`${zones.id} = ${zoneId}`)
    .limit(1);
  const branding = (zone?.branding ?? {}) as { familyCode?: BrandingFamilyCode };
  const prefix = branding.familyCode?.prefix ?? DEFAULT_FAMILY_REFERENCE_PREFIX;
  const pad = branding.familyCode?.pad ?? 7;

  // Count includes soft-deleted rows so re-using a numeric tail after a
  // delete is impossible. The reference code is treasurer-visible and
  // should never recycle.
  const [{ count }] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(families)
    .where(sql`${families.zoneId} = ${zoneId}`);
  const next = (count ?? 0) + 1;
  return `${prefix}${String(next).padStart(pad, "0")}`;
}
