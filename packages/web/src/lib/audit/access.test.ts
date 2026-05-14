// packages/web/src/lib/audit/access.test.ts
// Phase 9 — coverage for the audit-search predicate. Mirrors the
// server-side `hasZoneAdminRole` gate so a future drift between
// client and server surfaces as a failing test.
// RELEVANT FILES: packages/web/src/lib/audit/access.ts, packages/api/src/services/reports/access.ts

import { describe, expect, it } from "vitest";
import type { AuthorizedContext } from "@stewardledger/shared";
import { canSearchAudit } from "./access";

function ctx(overrides: Partial<AuthorizedContext> = {}): AuthorizedContext {
  return {
    userId: "u-stub",
    zoneId: "z-stub",
    regionId: null,
    roleCodes: [],
    chapterIds: [],
    isPlatformAdmin: false,
    ...overrides,
  };
}

describe("canSearchAudit", () => {
  it("accepts zone_owner / zone_admin / zone_finance_admin", () => {
    expect(canSearchAudit(ctx({ roleCodes: ["zone_owner"] }))).toBe(true);
    expect(canSearchAudit(ctx({ roleCodes: ["zone_admin"] }))).toBe(true);
    expect(canSearchAudit(ctx({ roleCodes: ["zone_finance_admin"] }))).toBe(true);
  });

  it("rejects a platform admin who lacks a zone-admin role (mirrors server gate)", () => {
    // The server-side `hasZoneAdminRole` is role-code-only and does
    // NOT honour `isPlatformAdmin` — a platform admin without one of
    // the admin role codes 403s on the audit endpoint. Mirror that
    // here so the UI doesn't show as authorised then fail every
    // search.
    expect(canSearchAudit(ctx({ isPlatformAdmin: true }))).toBe(false);
  });

  it("accepts a platform admin who also holds a zone-admin role", () => {
    expect(
      canSearchAudit(ctx({ isPlatformAdmin: true, roleCodes: ["zone_admin"] })),
    ).toBe(true);
  });

  it("rejects zone_auditor (viewer tier, not admin)", () => {
    // REPORTS.md §2.13: the audit log is admin-facing; viewer roles
    // are denied outright rather than served a redacted view.
    expect(canSearchAudit(ctx({ roleCodes: ["zone_auditor"] }))).toBe(false);
  });

  it("rejects zone_pastor_viewer (viewer tier, not admin)", () => {
    expect(canSearchAudit(ctx({ roleCodes: ["zone_pastor_viewer"] }))).toBe(false);
  });

  it("rejects chapter-scoped roles (no chapter dimension on the audit log)", () => {
    expect(canSearchAudit(ctx({ roleCodes: ["chapter_admin"] }))).toBe(false);
    expect(canSearchAudit(ctx({ roleCodes: ["chapter_treasurer"] }))).toBe(false);
    expect(canSearchAudit(ctx({ roleCodes: ["chapter_bookkeeper"] }))).toBe(false);
    expect(canSearchAudit(ctx({ roleCodes: ["chapter_pastor_viewer"] }))).toBe(false);
  });

  it("rejects null and empty-role contexts", () => {
    expect(canSearchAudit(null)).toBe(false);
    expect(canSearchAudit(ctx({ roleCodes: [] }))).toBe(false);
  });
});
