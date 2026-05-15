// packages/api/src/services/mfa-policy.ts
// Phase 9 §5 (PR 2) — bypass closure + per-role enforcement helpers.
//
// Two responsibilities, both expressed as pure functions so the
// hooks.before wiring stays trivial in `auth.ts`:
//
//   1. `isMfaEnrolled(email)` — has this user enabled TOTP?
//      The Better Auth before-hook calls this to decide whether to
//      let an OTP / magic-link sign-in path proceed.
//
//   2. `mfaRequiredInZone(zone, userRoleCodes)` — does at least one
//      of the user's role codes intersect this zone's
//      `mfa_required_role_codes`? Used by /api/public/session-zones
//      to decorate each zone with `mfaRequired: boolean`.
//
// RELEVANT FILES: packages/api/src/auth.ts, packages/api/src/routes/public.ts, packages/db/src/schema/zones.ts

import { sql } from "drizzle-orm";
import { user as userTable } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

/**
 * Endpoints that hand out a sign-in capability (OTP code, magic link)
 * without going through the password / TOTP challenge. Better Auth's
 * existing two-factor after-hook only matches `/sign-in/email|username|
 * phone-number`, so an MFA-enrolled user could sign in unchallenged
 * via these paths until we close them.
 *
 * Ordering is irrelevant; the global matcher does a simple set check.
 */
export const MFA_BYPASS_PATHS = new Set<string>([
  // Issues a magic link by email. We refuse before the link is sent.
  "/sign-in/magic-link",
  // Issues an OTP by email (type="sign-in" leads to /sign-in/email-otp).
  "/email-otp/send-verification-otp",
  // Verifies an OTP and creates a session in one shot. We refuse to
  // accept the code even if it was issued before the user enrolled
  // (5-minute window; small but not zero).
  "/sign-in/email-otp",
]);

/**
 * Pull the email out of a request body for the bypass-closure check.
 * Each of the three endpoints accepts `{ email, ... }`, so the
 * extraction is uniform; for `/email-otp/send-verification-otp` we
 * additionally require `type === "sign-in"` because the same
 * endpoint also handles email-verification and password-reset flows,
 * which run for users who don't yet have a session and aren't a
 * bypass risk.
 *
 * Returns `null` when the body doesn't have the shape we expect
 * (malformed JSON, missing email, wrong OTP type). The caller treats
 * `null` as "let Better Auth's own validator handle this" — we never
 * fail a request our hook can't reason about; we let the platform's
 * standard error flow.
 */
export function extractBypassEmail(
  path: string,
  body: unknown,
): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const email = typeof obj.email === "string" ? obj.email : null;
  if (!email) return null;

  if (path === "/email-otp/send-verification-otp") {
    // The endpoint also serves email-verification + password-reset.
    // Only the sign-in flavour can be used to bypass MFA.
    return obj.type === "sign-in" ? email : null;
  }
  return email;
}

/**
 * Has this user enabled TOTP? Looks up `user.two_factor_enabled`.
 * Returns `false` for unknown emails (no user → not enrolled → the
 * default sign-in path keeps working; the caller will get the same
 * "no such user" error it would have gotten without us).
 *
 * Comparison is case-insensitive: we don't depend on Better Auth's
 * (current) lowercase-on-write contract because future code paths
 * (imports, migration backfills, ad-hoc admin scripts) could insert
 * a mixed-case email. The `user_email_lower_idx` functional unique
 * index (migration 0008) backs this query so the lookup stays
 * indexed instead of degrading to a seq scan.
 */
export async function isMfaEnrolled(
  database: Db,
  email: string,
): Promise<boolean> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return false;
  const [row] = await database
    .select({ twoFactorEnabled: userTable.twoFactorEnabled })
    .from(userTable)
    .where(sql`lower(${userTable.email}) = ${normalised}`)
    .limit(1);
  return row?.twoFactorEnabled === true;
}

/**
 * Per-zone enforcement: a zone's `mfa_required_role_codes` is the
 * list of role codes whose holders must have TOTP active. Return
 * `true` if any of the user's role codes in this zone is on the
 * zone's required list.
 *
 * Empty `requiredRoleCodes` → never required (the default for new
 * zones, so this PR ships the mechanism without changing existing
 * tenant behaviour). Empty `userRoleCodes` → never required (the
 * user has no roles in this zone, so they couldn't trigger an
 * enforcement gate anyway).
 */
export function mfaRequiredInZone(
  requiredRoleCodes: readonly string[],
  userRoleCodes: readonly string[],
): boolean {
  if (requiredRoleCodes.length === 0) return false;
  if (userRoleCodes.length === 0) return false;
  const required = new Set(requiredRoleCodes);
  return userRoleCodes.some((code) => required.has(code));
}
