// packages/api/src/services/signup.ts
// Public zone signup: creates the zone in pending_setup, seeds system roles,
// and emails the primary contact a zone_owner invitation. No Better Auth user
// is created here — that happens when the invitation is accepted.

import type { Database } from "@stewardledger/db";
import { regions, zones } from "@stewardledger/db/schema";
import { ZONE_ROLES, type ZoneSignupInput } from "@stewardledger/shared";
import { eq } from "drizzle-orm";

import { writeAudit } from "./audit";
import { seedZoneGivingSetup } from "./giving-setup-seed";
import { createInvitation, sendZoneOwnerInviteEmail } from "./invitations";
import { seedZoneLookups } from "./lookup-seed";
import { assertNameAvailable, NameTakenError } from "./names";
import { seedZonePeriods } from "./period-seed";
import { seedZoneRoles } from "./role-seed";

export class SignupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SignupResult {
  zoneId: string;
  invitationId: string;
}

export interface SignupOptions {
  /** Platform admin who initiated the invite. Null for public signup. */
  invitedByUserId?: string | null;
}

export async function signupZone(
  database: Database,
  input: ZoneSignupInput,
  options: SignupOptions = {},
): Promise<SignupResult> {
  // Slug uniqueness — fast pre-check, but the unique index is the source of truth.
  const slugCollision = await database
    .select({ id: zones.id })
    .from(zones)
    .where(eq(zones.slug, input.slug))
    .limit(1);
  if (slugCollision[0]) {
    throw new SignupError("slug_taken", `The subdomain "${input.slug}" is already in use.`);
  }

  // Region xor: if regionId provided, it must exist and be active.
  if (input.regionId) {
    const region = await database
      .select({ id: regions.id, isActive: regions.isActive })
      .from(regions)
      .where(eq(regions.id, input.regionId))
      .limit(1);
    if (!region[0]?.isActive) {
      throw new SignupError("region_not_found", "Selected region is not available.");
    }
  }

  // Region/zone shared name namespace.
  try {
    await assertNameAvailable(database, input.name);
    if (input.regionNameUnverified) {
      // The unverified region name must also be unique against existing rows.
      await assertNameAvailable(database, input.regionNameUnverified);
    }
  } catch (err) {
    if (err instanceof NameTakenError) {
      throw new SignupError(err.code, err.message);
    }
    throw err;
  }

  return database.transaction(async (tx) => {
    const [zone] = await tx
      .insert(zones)
      .values({
        slug: input.slug,
        name: input.name,
        countryCode: input.countryCode,
        defaultCurrencyCode: input.defaultCurrency,
        defaultTimeZone: input.timeZone,
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        ministryYearStartMonth: input.ministryYearStartMonth,
        regionId: input.regionId ?? null,
        regionNameUnverified: input.regionNameUnverified ?? null,
        status: "pending_setup",
        primaryContactUserId: null,
      })
      .returning({ id: zones.id });

    await seedZoneRoles(tx, zone.id);
    await seedZoneLookups(tx, zone.id);
    await seedZoneGivingSetup(tx, zone.id, input.defaultCurrency);
    await seedZonePeriods(tx, zone.id, {
      fiscalYearStartMonth: input.fiscalYearStartMonth,
      ministryYearStartMonth: input.ministryYearStartMonth,
    });

    const invitation = await createInvitation(tx, {
      zoneId: zone.id,
      email: input.primaryContactEmail,
      roleCode: ZONE_ROLES.ZONE_OWNER,
      createdByUserId: options.invitedByUserId ?? null,
    });

    await writeAudit(tx, {
      zoneId: zone.id,
      actorUserId: options.invitedByUserId ?? null,
      action: "zone.invite",
      entityType: "zone",
      entityId: zone.id,
      after: {
        slug: input.slug,
        name: input.name,
        primaryContactEmail: input.primaryContactEmail,
        invitationId: invitation.id,
      },
    });

    await sendZoneOwnerInviteEmail({
      to: input.primaryContactEmail,
      contactName: input.primaryContactName,
      zoneSlug: input.slug,
      zoneName: input.name,
      token: invitation.token,
    });

    return { zoneId: zone.id, invitationId: invitation.id };
  });
}
