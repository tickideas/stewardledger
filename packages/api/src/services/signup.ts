// packages/api/src/services/signup.ts
// Public zone signup: creates the zone in pending_setup, seeds system roles,
// and emails the primary contact a zone_owner invitation. No Better Auth user
// is created here — that happens when the invitation is accepted.

import { BRAND_WORDMARK, ZONE_ROLES, type ZoneSignupInput } from "@stewardledger/shared";
import { eq } from "drizzle-orm";
import { regions, zones } from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";

import { env } from "../env";
import { brandedEmailHtml, escapeHtml, sendEmail } from "./email";
import { createInvitation } from "./invitations";
import { seedZoneLookups } from "./lookup-seed";
import { assertNameAvailable, NameTakenError } from "./names";
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

export async function signupZone(
  database: Database,
  input: ZoneSignupInput,
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
    if (!region[0] || !region[0].isActive) {
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

    const invitation = await createInvitation(tx, {
      zoneId: zone.id,
      email: input.primaryContactEmail,
      roleCode: ZONE_ROLES.ZONE_OWNER,
      createdByUserId: null,
    });

    const acceptUrl = buildAcceptUrl(input.slug, invitation.token);
    await sendEmail({
      to: input.primaryContactEmail,
      subject: `Set up your ${BRAND_WORDMARK} zone`,
      body:
        `Hi ${input.primaryContactName},\n\n` +
        `${input.name} is ready to set up on ${BRAND_WORDMARK}.\n\n` +
        `Accept your owner invitation and choose a password:\n${acceptUrl}\n\n` +
        `This link expires in 7 days.`,
      html: brandedEmailHtml({
        zoneName: input.name,
        body: `
          <p>Hi ${escapeHtml(input.primaryContactName)},</p>
          <p><strong>${escapeHtml(input.name)}</strong> is ready to set up on ${BRAND_WORDMARK}.</p>
          <p>
            <a href="${acceptUrl}"
               style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">
              Accept owner invitation
            </a>
          </p>
          <p style="color:#6b7280;font-size:13px;">This link expires in 7 days.</p>
        `,
      }),
    });

    return { zoneId: zone.id, invitationId: invitation.id };
  });
}

function buildAcceptUrl(slug: string, token: string): string {
  // For local dev (PUBLIC_TENANT_DOMAIN=localhost) the marketing host is the
  // app URL; for prod the zone subdomain hosts the accept page.
  if (env.PUBLIC_TENANT_DOMAIN === "localhost") {
    return `${env.PUBLIC_APP_URL}/invite/${encodeURIComponent(token)}`;
  }
  const url = new URL(env.PUBLIC_APP_URL);
  url.host = `${slug}.${env.PUBLIC_TENANT_DOMAIN}`;
  url.pathname = `/invite/${encodeURIComponent(token)}`;
  return url.toString();
}
