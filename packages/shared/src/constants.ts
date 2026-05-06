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

/** Money precision: numeric(19,4). Display rounded to 2 dp. */
export const MONEY_PRECISION = 4;
export const MONEY_DISPLAY_DECIMALS = 2;
