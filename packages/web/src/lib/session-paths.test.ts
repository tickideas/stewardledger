// packages/web/src/lib/session-paths.test.ts

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authenticatedLandingPath,
  isProtectedPath,
  isSafeInternalPath,
  isSuperAdminOnlyPath,
  PROTECTED_PREFIXES,
  PUBLIC_PREFIXES,
} from "./session-paths";

describe("isProtectedPath", () => {
  for (const prefix of PROTECTED_PREFIXES) {
    it(`matches the prefix itself: ${prefix}`, () => {
      expect(isProtectedPath(prefix)).toBe(true);
    });
    it(`matches nested children of ${prefix}`, () => {
      expect(isProtectedPath(`${prefix}/anything/deep`)).toBe(true);
    });
  }

  it("does not match the public home page", () => {
    expect(isProtectedPath("/")).toBe(false);
  });

  it("does not match prefix-similar but distinct paths", () => {
    // /memberships should not collide with /members.
    expect(isProtectedPath("/memberships")).toBe(false);
    expect(isProtectedPath("/loginish")).toBe(false);
  });
});

describe("isSafeInternalPath", () => {
  it("accepts plain absolute paths", () => {
    expect(isSafeInternalPath("/members")).toBe(true);
    expect(isSafeInternalPath("/members/abc?x=1")).toBe(true);
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(isSafeInternalPath("//evil.com")).toBe(false);
    expect(isSafeInternalPath("//evil.com/members")).toBe(false);
  });

  it("rejects backslash variants (/\\evil.com)", () => {
    expect(isSafeInternalPath("/\\evil.com")).toBe(false);
  });

  it("rejects absolute external URLs", () => {
    expect(isSafeInternalPath("http://evil.com")).toBe(false);
    expect(isSafeInternalPath("https://evil.com/members")).toBe(false);
  });

  it("rejects empty / non-slash inputs", () => {
    expect(isSafeInternalPath("")).toBe(false);
    expect(isSafeInternalPath("members")).toBe(false);
  });
});

describe("isSuperAdminOnlyPath", () => {
  it("matches only the zones admin surface", () => {
    expect(isSuperAdminOnlyPath("/admin/zones")).toBe(true);
    expect(isSuperAdminOnlyPath("/admin/zones/demo-grace-uk")).toBe(true);
    expect(isSuperAdminOnlyPath("/admin/regions")).toBe(false);
    expect(isSuperAdminOnlyPath("/admin/zonesish")).toBe(false);
  });
});

describe("authenticatedLandingPath", () => {
  it("routes platform-only super-admins to zones", () => {
    expect(authenticatedLandingPath({ activeZoneSlug: null, isSuperAdmin: true })).toBe(
      "/admin/zones",
    );
  });

  it("allows platform-only super-admins to honor only zones-admin next paths", () => {
    const session = { activeZoneSlug: null, isSuperAdmin: true };
    expect(authenticatedLandingPath(session, "/admin/zones/demo-grace-uk")).toBe(
      "/admin/zones/demo-grace-uk",
    );
    expect(authenticatedLandingPath(session, "/members")).toBe("/admin/zones");
    expect(authenticatedLandingPath(session, "//evil.com")).toBe("/admin/zones");
  });

  it("honors protected next paths for tenant-bound users", () => {
    expect(
      authenticatedLandingPath({ activeZoneSlug: "demo-grace-uk", isSuperAdmin: false }, "/members"),
    ).toBe("/members");
  });

  it("falls back to the zone chapter surface for tenant-bound users", () => {
    expect(authenticatedLandingPath({ activeZoneSlug: "demo grace", isSuperAdmin: false })).toBe(
      "/members?zone=demo%20grace",
    );
  });
});

describe("route partitioning", () => {
  // Every top-level entry in src/routes/ must be classified as either
  // protected or public. This catches drift the moment a developer adds a
  // new feature folder without telling the gating layer about it.
  it("classifies every top-level routes/ directory", () => {
    const routesDir = join(__dirname, "..", "routes");
    const entries = readdirSync(routesDir, { withFileTypes: true });

    const known = new Set<string>([
      ...PROTECTED_PREFIXES.map((p) => p.slice(1)),
      ...PUBLIC_PREFIXES.filter((p) => p !== "/").map((p) => p.slice(1)),
    ]);

    const unclassified = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      // SvelteKit conventions: parenthesised groups (e.g. (app)) are layout
      // groupings and don't appear in the URL.
      .filter((name) => !name.startsWith("(") && !name.startsWith("_"))
      .filter((name) => !known.has(name));

    expect(unclassified).toEqual([]);
  });
});
