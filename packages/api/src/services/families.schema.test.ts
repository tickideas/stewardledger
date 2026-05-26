// packages/api/src/services/families.schema.test.ts
// DB-level invariants for the families / family_members tables.
// Asserts the composite cross-tenant FKs reject mixed-zone references
// even when the application layer is bypassed.
// RELEVANT FILES: packages/db/src/schema/families.ts, packages/api/src/services/families.ts, packages/api/src/routes/tenant-families.test.ts

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chapters,
  families,
  familyMembers,
  members,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedZone(): Promise<string> {
  const [row] = await db
    .insert(zones)
    .values({
      slug: `fams-fk-${unique()}`,
      name: `Family FK zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  return row.id;
}

async function seedChapter(zoneId: string): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name: `FK chapter ${unique()}`,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  return row.id;
}

async function seedMember(zoneId: string, chapterId: string): Promise<string> {
  const [row] = await db
    .insert(members)
    .values({
      zoneId,
      chapterId,
      referenceCode: `M-${unique()}`,
      firstName: "FK",
      lastName: "Probe",
    })
    .returning({ id: members.id });
  return row.id;
}

describe("families schema — composite cross-tenant FKs", () => {
  let zoneA: string;
  let zoneB: string;
  let chapterA: string;
  let chapterB: string;
  let memberA: string;
  let memberB: string;
  let familyA: string;

  beforeAll(async () => {
    zoneA = await seedZone();
    zoneB = await seedZone();
    chapterA = await seedChapter(zoneA);
    chapterB = await seedChapter(zoneB);
    memberA = await seedMember(zoneA, chapterA);
    memberB = await seedMember(zoneB, chapterB);

    const [row] = await db
      .insert(families)
      .values({
        zoneId: zoneA,
        chapterId: chapterA,
        referenceCode: `F-${unique()}`,
        name: `FK Family ${unique()}`,
      })
      .returning({ id: families.id });
    familyA = row.id;
  });

  afterAll(async () => {
    for (const z of [zoneA, zoneB]) {
      await db.execute(sql`delete from family_members where zone_id = ${z}`);
      await db.execute(sql`delete from families where zone_id = ${z}`);
      await db.execute(sql`delete from members where zone_id = ${z}`);
      await db.execute(sql`delete from chapters where zone_id = ${z}`);
      await db.execute(sql`delete from zones where id = ${z}`);
    }
  });

  it("rejects a families row whose chapter belongs to a different zone", async () => {
    let raised: { code?: string; cause?: { code?: string } } | null = null;
    try {
      await db.insert(families).values({
        zoneId: zoneA,
        chapterId: chapterB, // wrong-zone chapter
        referenceCode: `F-${unique()}`,
        name: `Bad family ${unique()}`,
      });
    } catch (err) {
      raised = err as { code?: string; cause?: { code?: string } };
    }
    expect(raised).not.toBeNull();
    expect(raised?.code ?? raised?.cause?.code).toBe("23503");
  });

  it("rejects a family_members row whose member belongs to a different zone", async () => {
    let raised: { code?: string; cause?: { code?: string } } | null = null;
    try {
      await db.insert(familyMembers).values({
        zoneId: zoneA,
        familyId: familyA,
        memberId: memberB, // wrong-zone member
      });
    } catch (err) {
      raised = err as { code?: string; cause?: { code?: string } };
    }
    expect(raised).not.toBeNull();
    expect(raised?.code ?? raised?.cause?.code).toBe("23503");
  });

  it("accepts a family_members row when both zone_id columns line up", async () => {
    const [row] = await db
      .insert(familyMembers)
      .values({
        zoneId: zoneA,
        familyId: familyA,
        memberId: memberA,
      })
      .returning({ id: familyMembers.id });
    expect(row.id).toBeTruthy();
  });
});
