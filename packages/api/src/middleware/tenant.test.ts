// packages/api/src/middleware/tenant.test.ts

import { describe, expect, it } from "vitest";
import { resolveDevZoneSlugFromHeader, resolveZoneSlugFromHost } from "./tenant";

describe("resolveZoneSlugFromHost", () => {
  const apex = "stewardledger.church";

  it("extracts slug from valid subdomain", () => {
    expect(resolveZoneSlugFromHost(`uk-zone-1.${apex}`, apex)).toBe("uk-zone-1");
  });

  it("ignores port", () => {
    expect(resolveZoneSlugFromHost(`uk-zone-1.${apex}:443`, apex)).toBe("uk-zone-1");
  });

  it("returns null for apex itself", () => {
    expect(resolveZoneSlugFromHost(apex, apex)).toBeNull();
  });

  it("returns null for unrelated host", () => {
    expect(resolveZoneSlugFromHost("evil.example.com", apex)).toBeNull();
  });

  it("returns null for reserved subdomains", () => {
    for (const reserved of ["www", "api", "demo", "admin", "marketing"]) {
      expect(resolveZoneSlugFromHost(`${reserved}.${apex}`, apex)).toBeNull();
    }
  });

  it("works against a localhost dev domain", () => {
    expect(resolveZoneSlugFromHost("uk-zone-1.localhost", "localhost")).toBe("uk-zone-1");
  });
});

describe("resolveDevZoneSlugFromHeader", () => {
  it("accepts a valid dev-only localhost zone header", () => {
    expect(resolveDevZoneSlugFromHeader("uk-zone-1", "development", "localhost")).toBe(
      "uk-zone-1",
    );
  });

  it("rejects the dev header in production", () => {
    expect(resolveDevZoneSlugFromHeader("uk-zone-1", "production", "localhost")).toBeNull();
  });

  it("rejects invalid slugs", () => {
    expect(resolveDevZoneSlugFromHeader("Not A Slug", "development", "localhost")).toBeNull();
  });
});
