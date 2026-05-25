// packages/web/src/lib/exports/access.test.ts
// Phase 9 §3 — coverage for the owner-only export predicate.
// Mirrors the server gate (`ZONE_ROLES.ZONE_OWNER` in tenant-exports.ts)
// so a future drift between client and server surfaces as a failing test.
// RELEVANT FILES: packages/web/src/lib/exports/access.ts, packages/api/src/routes/tenant-exports.ts

import { describe, expect, it } from "vitest";
import type { AuthorizedContext } from "@stewardledger/shared";
import { canRequestExport } from "./access";

function ctx(overrides: Partial<AuthorizedContext> = {}): AuthorizedContext {
  return {
    userId: "u-stub",
    zoneId: "z-stub",
    regionId: null,
    roleCodes: [],
    chapterIds: [],
    groupIds: [],
    isPlatformAdmin: false,
    ...overrides,
  };
}

describe("canRequestExport", () => {
  it("accepts zone_owner", () => {
    expect(canRequestExport(ctx({ roleCodes: ["zone_owner"] }))).toBe(true);
  });

  it("rejects zone_admin (export is owner-only, not admin-tier)", () => {
    expect(canRequestExport(ctx({ roleCodes: ["zone_admin"] }))).toBe(false);
  });

  it("rejects zone_finance_admin", () => {
    expect(canRequestExport(ctx({ roleCodes: ["zone_finance_admin"] }))).toBe(false);
  });

  it("rejects zone_auditor and zone_pastor_viewer (read-only tiers)", () => {
    expect(canRequestExport(ctx({ roleCodes: ["zone_auditor"] }))).toBe(false);
    expect(canRequestExport(ctx({ roleCodes: ["zone_pastor_viewer"] }))).toBe(false);
  });

  it("rejects a platform admin who lacks a zone_owner binding (mirrors server gate)", () => {
    // The server-side `hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)` check is
    // role-code-only and does NOT honour `isPlatformAdmin`. Mirror that
    // here so the UI doesn't render the request affordance and then 403.
    expect(canRequestExport(ctx({ isPlatformAdmin: true }))).toBe(false);
  });

  it("accepts a platform admin who also holds a zone_owner role", () => {
    expect(
      canRequestExport(ctx({ isPlatformAdmin: true, roleCodes: ["zone_owner"] })),
    ).toBe(true);
  });

  it("rejects null and empty-role contexts", () => {
    expect(canRequestExport(null)).toBe(false);
    expect(canRequestExport(ctx({ roleCodes: [] }))).toBe(false);
  });
});
