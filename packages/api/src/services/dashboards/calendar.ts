// packages/api/src/services/dashboards/calendar.ts
// Phase 7 — tenant-timezone-aware calendar bounds.
// Reports take user-supplied date filters and never auto-derive a
// window. Dashboards do — they show "this month" and "year to date"
// in the tenant's own civil calendar. UTC math would silently slide
// the window for a tenant 12h off UTC (Auckland, Honolulu), so we
// resolve "now" in the zone's IANA TZ before extracting month / year.
//
// Scope note: this module computes *calendar boundaries* (month / year
// edges) only. It is NOT a general date-arithmetic helper. "Past 7
// days in tenant TZ" or "end of fiscal quarter" need DST-aware
// interval arithmetic and should grow alongside the report that asks
// for them rather than getting bolted on here.
// RELEVANT FILES: packages/api/src/services/dashboards/zone-dashboard.ts, packages/db/src/schema/zones.ts

/** Inclusive-start, exclusive-end half-open date range. */
export interface DateBounds {
  /** ISO date — inclusive. Used as `contributionDate >= start`. */
  start: string;
  /** ISO date — inclusive. Used for display only. */
  end: string;
  /** ISO date — exclusive. Used as `contributionDate < endExclusive`. */
  endExclusive: string;
}

/**
 * Resolve the calendar parts (year / month / day) of `at` in the given
 * IANA timezone. Uses `Intl.DateTimeFormat` (Node-builtin, no
 * dependency).
 *
 * `Intl.DateTimeFormat` is inconsistent about invalid IANA ids across
 * Node versions: some throw at construction, some throw on
 * `formatToParts`, and some silently fall back to UTC. To avoid a
 * silent `0000-00-00` window in the latter case, we validate that
 * every required part actually came back populated. The caller is
 * expected to pass `zones.defaultTimeZone`, which onboarding
 * constrains, but a stale or hand-edited value would surface here
 * loudly instead of producing a phantom window.
 */
function partsInZone(
  at: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch (cause) {
    throw new RangeError(`Invalid IANA timezone: ${timeZone}`, { cause });
  }
  const parts = fmt.formatToParts(at);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const p of parts) {
    if (p.type === "year") year = Number(p.value);
    else if (p.type === "month") month = Number(p.value);
    else if (p.type === "day") day = Number(p.value);
  }
  if (!year || !month || !day) {
    throw new RangeError(
      `Could not resolve year/month/day in timezone ${timeZone}`,
    );
  }
  return { year, month, day };
}

/**
 * Half-open month bounds for the civil month containing `at` in
 * `timeZone`. The returned `start` / `end` / `endExclusive` are pure
 * ISO dates (no TZ on the wire) because `contributions.contributionDate`
 * is a `date` column — the comparison is calendar arithmetic, not
 * wall-clock.
 *
 * Example: at = 2025-12-31T20:00:00Z, timeZone = "Pacific/Auckland"
 * (UTC+13 in summer). Local civil date is 2026-01-01, so the window
 * is January 2026, not December 2025.
 */
export function monthBoundsInZone(at: Date, timeZone: string): DateBounds {
  const { year, month } = partsInZone(at, timeZone);
  const start = isoDate(year, month, 1);
  const endExclusive = month === 12 ? isoDate(year + 1, 1, 1) : isoDate(year, month + 1, 1);
  // Inclusive `end` is the last day of the month. Constructed as
  // (next-month's start − 1 day) via Date math on a UTC instant so
  // we don't accidentally re-enter the zone-shift trap.
  const end = shiftIsoDateByDays(endExclusive, -1);
  return { start, end, endExclusive };
}

/** Half-open year bounds for the civil year containing `at` in `timeZone`. */
export function yearBoundsInZone(at: Date, timeZone: string): DateBounds {
  const { year } = partsInZone(at, timeZone);
  const start = isoDate(year, 1, 1);
  const end = isoDate(year, 12, 31);
  const endExclusive = isoDate(year + 1, 1, 1);
  return { start, end, endExclusive };
}

/**
 * Half-open ISO-week bounds (Monday → Sunday) for the week containing
 * `at` in `timeZone`. The chapter dashboard's "this week" card uses
 * this so a Sunday-evening UTC check from Auckland doesn't roll into
 * "next week" because of the timezone shift.
 *
 * Week numbering follows ISO-8601: weeks start on Monday. Sunday
 * evenings therefore land on the day before the next week begins
 * (correct for the legacy reports too, which key off ISO weeks).
 */
export function weekBoundsInZone(at: Date, timeZone: string): DateBounds {
  const { year, month, day } = partsInZone(at, timeZone);
  // Compute the JS weekday (0=Sun..6=Sat) for the civil date. We
  // anchor at noon UTC on the resolved (year, month, day) so the
  // `Date.UTC(...)` round-trip preserves the civil weekday: midnight
  // would put us on a different calendar day in some timezones, and
  // noon is the safest interior point that no TZ shift can move
  // across a day boundary.
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const jsDow = anchor.getUTCDay(); // 0=Sun..6=Sat
  // ISO weekday: 1=Mon..7=Sun. Days to subtract to reach Monday.
  const isoDow = jsDow === 0 ? 7 : jsDow;
  const start = shiftIsoDateByDays(isoDate(year, month, day), -(isoDow - 1));
  const endExclusive = shiftIsoDateByDays(start, 7);
  const end = shiftIsoDateByDays(endExclusive, -1);
  return { start, end, endExclusive };
}

function isoDate(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function shiftIsoDateByDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  // Construct on UTC midnight; the date math doesn't depend on TZ
  // because we're shifting a pure date.
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + days);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(
    next.getUTCDate(),
  ).padStart(2, "0")}`;
}
