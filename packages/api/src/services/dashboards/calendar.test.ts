// packages/api/src/services/dashboards/calendar.test.ts
// Phase 7 — tenant-timezone-aware month / year boundary tests.
// Exercises the UTC-shift trap that motivated the helper: an instant
// at 23:00 UTC on Dec 31 maps to a different civil month in Auckland
// (Jan 1) than in Honolulu (Dec 31), and the dashboard window has to
// follow the tenant's calendar.
// RELEVANT FILES: packages/api/src/services/dashboards/calendar.ts, packages/api/src/services/dashboards/zone-dashboard.ts

import { describe, expect, it } from "vitest";
import { monthBoundsInZone, yearBoundsInZone } from "./calendar";

describe("monthBoundsInZone", () => {
  it("returns the civil month containing `at` in the given timezone", () => {
    // 2025-05-15 12:00 UTC is May 15 everywhere relevant.
    const at = new Date("2025-05-15T12:00:00Z");
    expect(monthBoundsInZone(at, "Europe/London")).toEqual({
      start: "2025-05-01",
      end: "2025-05-31",
      endExclusive: "2025-06-01",
    });
    expect(monthBoundsInZone(at, "America/New_York")).toEqual({
      start: "2025-05-01",
      end: "2025-05-31",
      endExclusive: "2025-06-01",
    });
  });

  it("honours tenant TZ for instants near a month boundary", () => {
    // 2025-12-31 21:00 UTC.
    //   • Auckland (UTC+13 in summer) → 2026-01-01 10:00 local.
    //   • Honolulu (UTC−10) → 2025-12-31 11:00 local.
    const at = new Date("2025-12-31T21:00:00Z");
    expect(monthBoundsInZone(at, "Pacific/Auckland")).toEqual({
      start: "2026-01-01",
      end: "2026-01-31",
      endExclusive: "2026-02-01",
    });
    expect(monthBoundsInZone(at, "Pacific/Honolulu")).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
      endExclusive: "2026-01-01",
    });
  });

  it("handles February in a leap year", () => {
    const at = new Date("2024-02-15T12:00:00Z");
    expect(monthBoundsInZone(at, "Europe/London")).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
      endExclusive: "2024-03-01",
    });
  });

  it("handles February in a non-leap year", () => {
    const at = new Date("2025-02-15T12:00:00Z");
    expect(monthBoundsInZone(at, "Europe/London")).toEqual({
      start: "2025-02-01",
      end: "2025-02-28",
      endExclusive: "2025-03-01",
    });
  });

  it("rolls into the next year for December", () => {
    const at = new Date("2025-12-15T12:00:00Z");
    expect(monthBoundsInZone(at, "Europe/London")).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
      endExclusive: "2026-01-01",
    });
  });
});

describe("monthBoundsInZone error paths", () => {
  it("throws RangeError for an invalid IANA timezone", () => {
    expect(() => monthBoundsInZone(new Date("2025-05-15T12:00:00Z"), "Not/AZone")).toThrow(
      RangeError,
    );
  });

  it("throws RangeError for an empty timezone string", () => {
    expect(() => monthBoundsInZone(new Date("2025-05-15T12:00:00Z"), "")).toThrow(RangeError);
  });
});

describe("yearBoundsInZone", () => {
  it("returns the civil year containing `at` in the given timezone", () => {
    const at = new Date("2025-07-04T12:00:00Z");
    expect(yearBoundsInZone(at, "Europe/London")).toEqual({
      start: "2025-01-01",
      end: "2025-12-31",
      endExclusive: "2026-01-01",
    });
  });

  it("rolls between civil years for late-year UTC instants in eastern timezones", () => {
    // 2025-12-31 14:00 UTC is 2026-01-01 03:00 in Auckland.
    const at = new Date("2025-12-31T14:00:00Z");
    expect(yearBoundsInZone(at, "Pacific/Auckland")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
      endExclusive: "2027-01-01",
    });
  });
});
