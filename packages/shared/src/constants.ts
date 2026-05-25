// packages/shared/src/constants.ts
// Shared platform constants. Branding, versions, defaults.
// See docs/BRAND.md for naming/casing rules.

/** Wordmark — see docs/BRAND.md. */
export const BRAND_WORDMARK = "StewardLedger";

/** Primary domain. */
export const APP_DOMAIN = "stewardledger.church";

/** App version — bumped per release. */
export const APP_VERSION = "0.1.0";

/** Session length, days. Matches the legacy Church Plus default. */
export const DEFAULT_SESSION_DAYS = 35;

/** Notify before session expiry, minutes. */
export const SESSION_EXPIRY_NOTICE_MINUTES = 5;

/** OTP code length and validity, minutes. */
export const OTP_LENGTH = 6;
export const OTP_VALIDITY_MINUTES = 5;

/** Default fiscal year start month (1-12). Per zone, override at signup. */
export const DEFAULT_FISCAL_YEAR_START_MONTH = 1;

/** Default ministry year start month for Christ Embassy (March). */
export const DEFAULT_MINISTRY_YEAR_START_MONTH = 3;

/** Reference code formats — configurable per zone. These are defaults. */
export const DEFAULT_MEMBER_REFERENCE_PREFIX = "M";
export const DEFAULT_CHAPTER_REFERENCE_PREFIX = "C";

/** Invitation token length, raw bytes (URL-safe base64-encoded in the email link). */
export const INVITATION_TOKEN_BYTES = 32;

/** Invitation validity, hours. Owner invites and team invites both default here. */
export const INVITATION_VALIDITY_HOURS = 168; // 7 days

/** Money precision: numeric(19,4). Display rounded to 2 dp. */
export const MONEY_PRECISION = 4;
export const MONEY_DISPLAY_DECIMALS = 2;

// ─── GDPR erasure (Phase 9 §6) ────────────────────────────────────
// Single source of truth for the windows the server enforces in
// `services/erasure/requests.ts` and the UI mirrors in
// `routes/zone/settings/+page.svelte`. If the server-side gate
// moves, importing here keeps the UI predicate aligned in lockstep
// rather than silently drifting.

/**
 * Default reversibility window for member-scope erases (days).
 * Zone-scope is fixed at this value; member-scope reads the
 * per-zone retention policy and floors to this value when the
 * policy is 0 ("never purge"). An operator can override via the
 * UI modal up to 365.
 */
export const ERASURE_DEFAULT_WINDOW_DAYS = 14;

/**
 * Reversibility window for zone-scope erases (days). Fixed; the
 * retention policy doesn't move it.
 */
export const ERASURE_ZONE_WINDOW_DAYS = 14;

/**
 * Recency requirement for the `confirmExportId` gate on a
 * zone-scope erase: the referenced `zone_exports` row must have
 * completed within this window. Stops an owner decommissioning
 * the tenant without a fresh take-with-them artefact.
 */
export const ERASURE_RECENT_EXPORT_WINDOW_DAYS = 7;
