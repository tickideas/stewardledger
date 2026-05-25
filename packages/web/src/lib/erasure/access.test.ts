// packages/web/src/lib/erasure/access.test.ts
// Phase 9 §6 — coverage for the erasure read/write predicates.
// Mirrors the server-side route gates so a future drift surfaces
// as a failing test.
// RELEVANT FILES: ./access.ts, packages/api/src/routes/tenant-erasure.ts

import { describe, expect, it } from "vitest";
import type { AuthorizedContext } from "@stewardledger/shared";
import { canManageMemberErasure, canManageZoneErasure } from "./access";

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

describe("canManageMemberErasure", () => {
  it("accepts the three PII-tier zone roles", () => {
    expect(canManageMemberErasure(ctx({ roleCodes: ["zone_owner"] }))).toBe(
      true,
    );
    expect(canManageMemberErasure(ctx({ roleCodes: ["zone_admin"] }))).toBe(
      true,
    );
    expect(
      canManageMemberErasure(ctx({ roleCodes: ["zone_finance_admin"] })),
    ).toBe(true);
  });

  it("rejects auditor + chapter / viewer roles", () => {
    expect(canManageMemberErasure(ctx({ roleCodes: ["zone_auditor"] }))).toBe(
      false,
    );
    expect(
      canManageMemberErasure(ctx({ roleCodes: ["zone_pastor_viewer"] })),
    ).toBe(false);
    expect(canManageMemberErasure(ctx({ roleCodes: ["chapter_admin"] }))).toBe(
      false,
    );
    expect(
      canManageMemberErasure(ctx({ roleCodes: ["chapter_treasurer"] })),
    ).toBe(false);
  });

  it("rejects a platform admin without an admin-tier zone binding", () => {
    expect(canManageMemberErasure(ctx({ isPlatformAdmin: true }))).toBe(false);
  });

  it("rejects null and empty contexts", () => {
    expect(canManageMemberErasure(null)).toBe(false);
    expect(canManageMemberErasure(ctx({ roleCodes: [] }))).toBe(false);
  });
});

describe("canManageZoneErasure", () => {
  it("accepts zone_owner only", () => {
    expect(canManageZoneErasure(ctx({ roleCodes: ["zone_owner"] }))).toBe(true);
  });

  it("rejects every non-owner role (including zone_admin)", () => {
    expect(canManageZoneErasure(ctx({ roleCodes: ["zone_admin"] }))).toBe(
      false,
    );
    expect(
      canManageZoneErasure(ctx({ roleCodes: ["zone_finance_admin"] })),
    ).toBe(false);
    expect(canManageZoneErasure(ctx({ roleCodes: ["zone_auditor"] }))).toBe(
      false,
    );
    expect(canManageZoneErasure(ctx({ roleCodes: ["chapter_admin"] }))).toBe(
      false,
    );
  });

  it("rejects a platform admin without a zone_owner binding", () => {
    expect(canManageZoneErasure(ctx({ isPlatformAdmin: true }))).toBe(false);
  });

  it("rejects null and empty contexts", () => {
    expect(canManageZoneErasure(null)).toBe(false);
    expect(canManageZoneErasure(ctx({ roleCodes: [] }))).toBe(false);
  });
});
