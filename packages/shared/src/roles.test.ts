// packages/shared/src/roles.test.ts
// Tests for the role taxonomy.

import { describe, expect, it } from "vitest";
import {
  CHAPTER_ROLES,
  GROUP_ROLES,
  PLATFORM_ROLES,
  ZONE_ROLES,
  isGroupScopedRole,
  isZoneWideRole,
  roleScope,
} from "./roles";

describe("roles taxonomy — group tier", () => {
  it("exposes group_admin and group_pastor_viewer", () => {
    expect(GROUP_ROLES.GROUP_ADMIN).toBe("group_admin");
    expect(GROUP_ROLES.GROUP_PASTOR_VIEWER).toBe("group_pastor_viewer");
  });

  it("roleScope returns 'group' for group codes", () => {
    expect(roleScope("group_admin")).toBe("group");
    expect(roleScope("group_pastor_viewer")).toBe("group");
  });

  it("isGroupScopedRole identifies group codes", () => {
    expect(isGroupScopedRole("group_admin")).toBe(true);
    expect(isGroupScopedRole("group_pastor_viewer")).toBe(true);
    expect(isGroupScopedRole("zone_admin")).toBe(false);
    expect(isGroupScopedRole("chapter_admin")).toBe(false);
  });

  it("isZoneWideRole stays false for group roles", () => {
    expect(isZoneWideRole("group_admin")).toBe(false);
    expect(isZoneWideRole("group_pastor_viewer")).toBe(false);
    expect(isZoneWideRole("zone_admin")).toBe(true);
  });
});

describe("role code uniqueness", () => {
  it("every role code across all tiers is unique", () => {
    const all = [
      ...Object.values(PLATFORM_ROLES),
      ...Object.values(ZONE_ROLES),
      ...Object.values(GROUP_ROLES),
      ...Object.values(CHAPTER_ROLES),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
