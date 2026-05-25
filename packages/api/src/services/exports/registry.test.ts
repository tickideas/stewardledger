// packages/api/src/services/exports/registry.test.ts
// Coverage test: every Drizzle table with a `zone_id` column must
// be either INCLUDED in the export bundle or EXPLICITLY EXCLUDED
// with a written reason. A schema author who adds a new
// zone-scoped table and forgets to extend the registry breaks this
// test.

import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@stewardledger/db/schema";
import {
  EXCLUDED_ZONE_SCOPED_TABLES,
  ZONE_SCOPED_TABLES,
  exportOrder,
  restoreOrder,
} from "./registry";

/**
 * Reflect on the imported schema barrel and return the SQL name of
 * every table whose Drizzle definition carries a `zoneId` column.
 * `getTableColumns` reads the column map regardless of how the
 * column was declared (snake/camel; with/without an alias), so a
 * future schema change can't drift this list out of sync as long
 * as the JS property is named `zoneId` (the codebase convention).
 */
function discoverZoneScopedTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cols = getTableColumns(value);
    if ("zoneId" in cols) names.push(getTableName(value));
  }
  return names.sort();
}

describe("zone export registry coverage", () => {
  it("every zone-scoped table is either declared or explicitly excluded", () => {
    const discovered = new Set(discoverZoneScopedTableNames());
    const declared = new Set(ZONE_SCOPED_TABLES.map((t) => t.name));
    const excluded = new Set(EXCLUDED_ZONE_SCOPED_TABLES.map((t) => t.name));
    const missing: string[] = [];
    for (const name of discovered) {
      if (!declared.has(name) && !excluded.has(name)) missing.push(name);
    }
    expect(missing, "uncovered zone-scoped tables").toEqual([]);
  });

  it("no declared table is also excluded", () => {
    const declared = new Set(ZONE_SCOPED_TABLES.map((t) => t.name));
    const collisions = EXCLUDED_ZONE_SCOPED_TABLES.filter((t) =>
      declared.has(t.name),
    );
    expect(collisions).toEqual([]);
  });

  it("no declared table has a stale name (must exist in the schema)", () => {
    const discovered = new Set(discoverZoneScopedTableNames());
    const stale = ZONE_SCOPED_TABLES.filter((t) => !discovered.has(t.name));
    expect(stale, "declared tables not present in the live schema").toEqual([]);
  });

  it("no excluded table is stale (must exist + be zone-scoped)", () => {
    // An entry in EXCLUDED_ZONE_SCOPED_TABLES that no longer has a
    // `zoneId` column is dead documentation. Catch it.
    const discovered = new Set(discoverZoneScopedTableNames());
    const stale = EXCLUDED_ZONE_SCOPED_TABLES.filter(
      (t) => !discovered.has(t.name),
    );
    expect(stale).toEqual([]);
  });

  it("restoreOrder values are unique", () => {
    const seen = new Map<number, string>();
    for (const t of ZONE_SCOPED_TABLES) {
      const collision = seen.get(t.restoreOrder);
      if (collision !== undefined) {
        throw new Error(
          `restoreOrder collision: ${t.name} and ${collision} both at ${t.restoreOrder}`,
        );
      }
      seen.set(t.restoreOrder, t.name);
    }
  });

  it("export order is exactly the reverse of restore order", () => {
    const exp = exportOrder().map((t) => t.name);
    const res = restoreOrder().map((t) => t.name);
    expect(exp).toEqual([...res].reverse());
  });

  it("members come after chapters in restore order (FK consistency spot-check)", () => {
    const order = restoreOrder().map((t) => t.name);
    expect(order.indexOf("members")).toBeGreaterThan(
      order.indexOf("chapters"),
    );
  });

  it("contributions come after members, batches, giving_types in restore order", () => {
    const order = restoreOrder().map((t) => t.name);
    const c = order.indexOf("contributions");
    expect(c).toBeGreaterThan(order.indexOf("members"));
    expect(c).toBeGreaterThan(order.indexOf("contribution_batches"));
    expect(c).toBeGreaterThan(order.indexOf("giving_types"));
  });

  it("audit_events is restored last (so the timeline reflects pre-restore state)", () => {
    const order = restoreOrder().map((t) => t.name);
    expect(order[order.length - 1]).toBe("audit_events");
  });

  it("user_role_bindings comes after roles (binding FKs the per-zone role row)", () => {
    const order = restoreOrder().map((t) => t.name);
    expect(order.indexOf("user_role_bindings")).toBeGreaterThan(
      order.indexOf("roles"),
    );
  });
});
