// packages/api/src/services/paying-in-books/validate.test.ts
// Phase 8 — paying-in book reference-code validator coverage.
// Membership / date-window / chapter-scope / out-of-range — every
// reject path surfaces the tagged service error.
// RELEVANT FILES: packages/api/src/services/paying-in-books/validate.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  chapters,
  payingInBooks,
  user as userTable,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import { assertReferenceCodeInRange, PayingInBookError } from "./validate";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface Fixture {
  zoneId: string;
  chapterAId: string;
  chapterBId: string;
  userId: string;
}

let fx: Fixture;

beforeAll(async () => {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("validate.test.ts requires a *_test DATABASE_URL");
  }
  const slug = `pib-${unique()}`;
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name: `PayingInBook Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id });
  const [chA] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `CA${unique()}`,
      name: `Chapter A ${unique()}`,
      dateFrom: "2024-01-01",
    })
    .returning({ id: chapters.id });
  const [chB] = await db
    .insert(chapters)
    .values({
      zoneId: zone.id,
      referenceCode: `CB${unique()}`,
      name: `Chapter B ${unique()}`,
      dateFrom: "2024-01-01",
    })
    .returning({ id: chapters.id });

  const userId = `u-${unique()}`;
  await db.insert(userTable).values({
    id: userId,
    email: `${userId}@test.local`,
    emailVerified: true,
  });

  // Books:
  // - Chapter A, codes 0001..0100, open from 2025-01-01 onwards.
  // - Chapter A, codes 1000..1050, closed 2024-12-31.
  // - Chapter B, codes 5000..5100, open from 2025-01-01. Disjoint
  //   from chapter A on purpose so a cross-chapter rejection test
  //   has a code that exists in one chapter but not the other.
  await db.insert(payingInBooks).values([
    {
      zoneId: zone.id,
      chapterId: chA.id,
      referenceCodeStart: "0001",
      referenceCodeEnd: "0100",
      dateFrom: "2025-01-01",
      dateTo: null,
    },
    {
      zoneId: zone.id,
      chapterId: chA.id,
      referenceCodeStart: "1000",
      referenceCodeEnd: "1050",
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
    },
    {
      zoneId: zone.id,
      chapterId: chB.id,
      referenceCodeStart: "5000",
      referenceCodeEnd: "5100",
      dateFrom: "2025-01-01",
      dateTo: null,
    },
  ]);

  fx = {
    zoneId: zone.id,
    chapterAId: chA.id,
    chapterBId: chB.id,
    userId,
  };
});

afterAll(async () => {
  await db.execute(sql`delete from paying_in_books where zone_id = ${fx.zoneId}`);
  await db.execute(sql`delete from chapters where zone_id = ${fx.zoneId}`);
  await db.execute(sql`delete from zones where id = ${fx.zoneId}`);
  await db.execute(sql`delete from "user" where id = ${fx.userId}`);
});

describe("assertReferenceCodeInRange", () => {
  it("accepts a code that falls within an active book", async () => {
    await expect(
      assertReferenceCodeInRange(db, {
        zoneId: fx.zoneId,
        chapterId: fx.chapterAId,
        referenceCode: "0050",
        onDate: "2025-06-01",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a code outside every active book range", async () => {
    await expect(
      assertReferenceCodeInRange(db, {
        zoneId: fx.zoneId,
        chapterId: fx.chapterAId,
        referenceCode: "0200",
        onDate: "2025-06-01",
      }),
    ).rejects.toBeInstanceOf(PayingInBookError);
  });

  it("rejects a code whose book has expired on the lookup date", async () => {
    // 1000..1050 was open 2024 only; checking 2025 → rejected.
    await expect(
      assertReferenceCodeInRange(db, {
        zoneId: fx.zoneId,
        chapterId: fx.chapterAId,
        referenceCode: "1025",
        onDate: "2025-06-01",
      }),
    ).rejects.toBeInstanceOf(PayingInBookError);
  });

  it("accepts a code in a now-closed book when the lookup date falls inside the window", async () => {
    await expect(
      assertReferenceCodeInRange(db, {
        zoneId: fx.zoneId,
        chapterId: fx.chapterAId,
        referenceCode: "1025",
        onDate: "2024-06-01",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a code belonging to another chapter", async () => {
    // Chapter B's book covers 5000..5100; chapter A's covers
    // 0001..0100. Querying chapter A with a chapter-B-only code
    // (5050) must reject. The mirror query (chapter B, 5050)
    // must accept — same code, but only when scoped to its
    // owning chapter.
    await expect(
      assertReferenceCodeInRange(db, {
        zoneId: fx.zoneId,
        chapterId: fx.chapterAId,
        referenceCode: "5050",
        onDate: "2025-06-01",
      }),
    ).rejects.toBeInstanceOf(PayingInBookError);
    await expect(
      assertReferenceCodeInRange(db, {
        zoneId: fx.zoneId,
        chapterId: fx.chapterBId,
        referenceCode: "5050",
        onDate: "2025-06-01",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when no book exists for the chapter at all", async () => {
    // A phantom chapter id has no books → reject.
    const phantomChapter = "00000000-0000-4000-8000-000000000000";
    await expect(
      assertReferenceCodeInRange(db, {
        zoneId: fx.zoneId,
        chapterId: phantomChapter,
        referenceCode: "0050",
        onDate: "2025-06-01",
      }),
    ).rejects.toBeInstanceOf(PayingInBookError);
  });
});
