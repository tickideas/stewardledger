// packages/api/src/services/names.ts
// Region.name and zone.name share a single global namespace (case-insensitive).
// AGENTS rule 4 forbids stored-proc business logic, so this constraint is
// enforced in the service layer at every insert/update site.

import { sql } from "drizzle-orm";
import { regions, zones } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

export class NameTakenError extends Error {
  readonly code = "name_taken";
  constructor(
    readonly field: "name",
    readonly conflictsWith: "region" | "zone",
    name: string,
  ) {
    super(`The name "${name}" is already used by a ${conflictsWith}.`);
  }
}

export async function assertNameAvailable(
  database: Db,
  name: string,
  options: { ignoreZoneId?: string; ignoreRegionId?: string } = {},
): Promise<void> {
  const lower = name.trim().toLowerCase();

  const zoneRows = await database
    .select({ id: zones.id })
    .from(zones)
    .where(sql`lower(${zones.name}) = ${lower}`)
    .limit(1);
  const zoneHit = zoneRows[0];
  if (zoneHit && zoneHit.id !== options.ignoreZoneId) {
    throw new NameTakenError("name", "zone", name);
  }

  const regionRows = await database
    .select({ id: regions.id })
    .from(regions)
    .where(sql`lower(${regions.name}) = ${lower}`)
    .limit(1);
  const regionHit = regionRows[0];
  if (regionHit && regionHit.id !== options.ignoreRegionId) {
    throw new NameTakenError("name", "region", name);
  }
}
