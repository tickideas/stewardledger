// packages/api/src/services/chapter-codes.ts
// Chapter reference-code generator. Default format: `${prefix}{padded6}`,
// e.g. "C000001". The prefix can be overridden per zone via zones.branding
// (legacy zones used "LWUKZ1" etc.). The numeric tail is monotonic per zone
// and obtained by counting existing chapters at insert time inside the same
// transaction.

import { sql } from "drizzle-orm";
import { DEFAULT_CHAPTER_REFERENCE_PREFIX } from "@stewardledger/shared";
import { chapters, zones } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

interface BrandingChapterCode {
  prefix?: string;
  pad?: number;
}

export async function nextChapterReferenceCode(
  database: Db,
  zoneId: string,
): Promise<string> {
  const [zone] = await database
    .select({ branding: zones.branding })
    .from(zones)
    .where(sql`${zones.id} = ${zoneId}`)
    .limit(1);
  const branding = (zone?.branding ?? {}) as { chapterCode?: BrandingChapterCode };
  const prefix = branding.chapterCode?.prefix ?? DEFAULT_CHAPTER_REFERENCE_PREFIX;
  const pad = branding.chapterCode?.pad ?? 6;

  const [{ count }] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(chapters)
    .where(sql`${chapters.zoneId} = ${zoneId}`);
  const next = (count ?? 0) + 1;
  return `${prefix}${String(next).padStart(pad, "0")}`;
}
