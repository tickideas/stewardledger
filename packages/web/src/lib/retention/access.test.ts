// packages/web/src/lib/retention/access.test.ts
// Phase 9 — coverage for the retention read/write predicates. Mirrors
// the server-side route gates so a future drift surfaces as a failing
// test.
// RELEVANT FILES: packages/web/src/lib/retention/access.ts, packages/api/src/routes/tenant-zones.ts

import { describe, expect, it } from "vitest";
import type { AuthorizedContext } from "@stewardledger/shared";
import { canEditRetention, canReadRetention } from "./access";

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

describe("canReadRetention", () => {
  it("accepts every admin-tier zone role", () => {
    expect(canReadRetention(ctx({ roleCodes: ["zone_owner"] }))).toBe(true);
    expect(canReadRetention(ctx({ roleCodes: ["zone_admin"] }))).toBe(true);
    expect(canReadRetention(ctx({ roleCodes: ["zone_finance_admin"] }))).toBe(true);
    expect(canReadRetention(ctx({ roleCodes: ["zone_auditor"] }))).toBe(true);
  });

  it("rejects viewer + chapter-scoped roles", () => {
    expect(canReadRetention(ctx({ roleCodes: ["zone_pastor_viewer"] }))).toBe(false);
    expect(canReadRetention(ctx({ roleCodes: ["chapter_admin"] }))).toBe(false);
    expect(canReadRetention(ctx({ roleCodes: ["chapter_treasurer"] }))).toBe(false);
  });

  it("rejects a platform admin without an admin-tier zone binding", () => {
    expect(canReadRetention(ctx({ isPlatformAdmin: true }))).toBe(false);
  });

  it("rejects null and empty contexts", () => {
    expect(canReadRetention(null)).toBe(false);
    expect(canReadRetention(ctx({ roleCodes: [] }))).toBe(false);
  });
});

describe("canEditRetention", () => {
  it("accepts zone_owner only", () => {
    expect(canEditRetention(ctx({ roleCodes: ["zone_owner"] }))).toBe(true);
  });

  it("rejects zone_admin and below (write is owner-only)", () => {
    expect(canEditRetention(ctx({ roleCodes: ["zone_admin"] }))).toBe(false);
    expect(canEditRetention(ctx({ roleCodes: ["zone_finance_admin"] }))).toBe(false);
    expect(canEditRetention(ctx({ roleCodes: ["zone_auditor"] }))).toBe(false);
  });

  it("rejects a platform admin without a zone_owner binding", () => {
    expect(canEditRetention(ctx({ isPlatformAdmin: true }))).toBe(false);
  });

  it("rejects null and empty contexts", () => {
    expect(canEditRetention(null)).toBe(false);
    expect(canEditRetention(ctx({ roleCodes: [] }))).toBe(false);
  });
});
