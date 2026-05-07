// packages/api/src/services/member-codes.ts
// Member reference-code generator. Default format: `${prefix}{padded7}`,
// e.g. "M0000001". The prefix and pad can be overridden per zone via
// zones.branding.memberCode. The numeric tail is monotonic per zone. A
// transaction-scoped advisory lock serializes generation for each zone so two
// concurrent creates cannot choose the same count-based tail.

import { sql } from "drizzle-orm";
import { DEFAULT_MEMBER_REFERENCE_PREFIX } from "@stewardledger/shared";
import { members, zones } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

interface BrandingMemberCode {
  prefix?: string;
  pad?: number;
}

export async function nextMemberReferenceCode(database: Db, zoneId: string): Promise<string> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${zoneId}))`);

  const [zone] = await database
    .select({ branding: zones.branding })
    .from(zones)
    .where(sql`${zones.id} = ${zoneId}`)
    .limit(1);
  const branding = (zone?.branding ?? {}) as { memberCode?: BrandingMemberCode };
  const prefix = branding.memberCode?.prefix ?? DEFAULT_MEMBER_REFERENCE_PREFIX;
  const pad = branding.memberCode?.pad ?? 7;

  const [{ count }] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(members)
    .where(sql`${members.zoneId} = ${zoneId}`);
  const next = (count ?? 0) + 1;
  return `${prefix}${String(next).padStart(pad, "0")}`;
}
