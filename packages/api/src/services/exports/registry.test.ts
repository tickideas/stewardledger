// packages/api/src/services/exports/registry.test.ts
// Coverage test: every Drizzle table with a `zone_id` column must
// be either INCLUDED in the export bundle or EXPLICITLY EXCLUDED
// with a written reason. A schema author who adds a new
// zone-scoped table and forgets to extend the registry breaks this
// test.

import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@stewardledger/db/schema";
import {
  EXCLUDED_ZONE_SCOPED_TABLES,
  ZONE_SCOPED_TABLES,
  exportOrder,
  restoreOrder,
} from "./registry";

/**
 * Reflect on the imported schema barrel and return the SQL name of
 * every table whose Drizzle definition carries a column named
 * `zone_id` at the SQL layer. Inspecting the column's SQL name
 * (rather than the JS property name) means a future schema author
 * who names their property `tenantZoneId` while keeping the column
 * `zone_id` still gets caught by this coverage test.
 */
function discoverZoneScopedTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cols = getTableColumns(value);
    const hasZoneIdColumn = Object.values(cols).some(
      (c) => (c as { name: string }).name === "zone_id",
    );
    if (hasZoneIdColumn) names.push(getTableName(value));
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

  it("the `zones` row is declared with selector=self", () => {
    // `zones` has no `zone_id` column — its PK *is* the zone
    // identity — so the discovery test won't catch its omission.
    // Pin it explicitly: the bundle is unrestorable without it.
    const zonesEntry = ZONE_SCOPED_TABLES.find((t) => t.name === "zones");
    expect(zonesEntry, "zones row must be in the registry").toBeDefined();
    expect(zonesEntry?.selector).toBe("self");
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
    // The `zones` row is declared with `selector: "self"` and is
    // legitimately absent from `discovered` (no `zone_id` column).
    const stale = ZONE_SCOPED_TABLES.filter(
      (t) => t.selector !== "self" && !discovered.has(t.name),
    );
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

  it("every in-bundle FK respects restore order (parent before child)", () => {
    // Reflect on every declared table's `foreignKeys` array, look
    // up the parent table by name in the registry, and assert
    // parent.restoreOrder < child.restoreOrder. This catches *any*
    // future ordering bug — not just the hand-picked spot checks
    // above — because it derives the parent set from the live
    // schema rather than from a maintained allowlist.
    const byName = new Map(
      ZONE_SCOPED_TABLES.map((t) => [t.name, t.restoreOrder]),
    );
    const violations: string[] = [];
    for (const entry of ZONE_SCOPED_TABLES) {
      const { foreignKeys } = getTableConfig(entry.table);
      for (const fk of foreignKeys) {
        const ref = fk.reference();
        const parentName = getTableName(ref.foreignTable);
        // Self-references (e.g. a table FK'ing its own PK for a
        // tree structure) are fine — the row is its own parent.
        if (parentName === entry.name) continue;
        // Parents outside the bundle (e.g. `user`, `regions`) are
        // the restorer's problem, not the registry's — see header.
        const parentOrder = byName.get(parentName);
        if (parentOrder === undefined) continue;
        if (parentOrder >= entry.restoreOrder) {
          violations.push(
            `${entry.name} (order=${entry.restoreOrder}) FKs ${parentName} (order=${parentOrder}) — parent must restore first`,
          );
        }
      }
    }
    expect(violations, "FK restore-order violations").toEqual([]);
  });
});
