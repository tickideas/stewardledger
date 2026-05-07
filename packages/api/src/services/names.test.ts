// packages/api/src/services/names.test.ts
// Integration test for the region/zone name disjointness check.

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { regions, zones } from "@stewardledger/db/schema";
import { db } from "../db";
import { assertNameAvailable, NameTakenError } from "./names";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("assertNameAvailable", () => {
  const cleanups: { kind: "zone" | "region"; key: string }[] = [];

  afterAll(async () => {
    for (const c of cleanups) {
      if (c.kind === "zone") await db.execute(sql`delete from zones where slug = ${c.key}`);
      else await db.execute(sql`delete from regions where id = ${c.key}`);
    }
  });

  it("passes when the name is unused", async () => {
    await expect(assertNameAvailable(db, `Fresh Name ${unique()}`)).resolves.toBeUndefined();
  });

  it("rejects when an existing region has the same name (case-insensitive)", async () => {
    const name = `Region Name ${unique()}`;
    const [r] = await db.insert(regions).values({ name }).returning({ id: regions.id });
    cleanups.push({ kind: "region", key: r.id });
    await expect(assertNameAvailable(db, name.toUpperCase())).rejects.toBeInstanceOf(
      NameTakenError,
    );
  });

  it("rejects when an existing zone has the same name", async () => {
    const slug = `t-${unique()}`;
    const name = `Zone Name ${unique()}`;
    await db.insert(zones).values({
      slug,
      name,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Inbox ${unique()}`,
    });
    cleanups.push({ kind: "zone", key: slug });
    await expect(assertNameAvailable(db, name)).rejects.toBeInstanceOf(NameTakenError);
  });

  it("ignores a self-reference when ignoreZoneId is given", async () => {
    const slug = `t-${unique()}`;
    const name = `Self Zone ${unique()}`;
    const [z] = await db
      .insert(zones)
      .values({
        slug,
        name,
        countryCode: "GB",
        defaultCurrencyCode: "GBP",
        defaultTimeZone: "Europe/London",
        regionNameUnverified: `Inbox ${unique()}`,
      })
      .returning({ id: zones.id });
    cleanups.push({ kind: "zone", key: slug });
    await expect(
      assertNameAvailable(db, name, { ignoreZoneId: z.id }),
    ).resolves.toBeUndefined();
  });
});
