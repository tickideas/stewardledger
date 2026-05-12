// packages/api/src/middleware/tenant.test.ts
// Unit coverage for tenant slug resolution across tenant and split API hosts.
// Prevents production split-host deploys from losing tenant context.
// RELEVANT FILES: ./tenant.ts, ../app.ts, ../../../web/src/lib/api.ts

import { describe, expect, it } from "vitest";
import {
  hostMatchesPublicApiOrigin,
  resolveDevZoneSlugFromHeader,
  resolveZoneSlugFromHeader,
  resolveZoneSlugFromHost,
} from "./tenant";

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

describe("resolveZoneSlugFromHeader", () => {
  it("accepts valid zone slugs", () => {
    expect(resolveZoneSlugFromHeader("uk-zone-1")).toBe("uk-zone-1");
  });

  it("rejects invalid zone slugs", () => {
    expect(resolveZoneSlugFromHeader("Not A Slug")).toBeNull();
  });
});

describe("hostMatchesPublicApiOrigin", () => {
  it("matches the configured split API host", () => {
    expect(
      hostMatchesPublicApiOrigin(
        "api.stewardledger.church",
        "https://api.stewardledger.church",
      ),
    ).toBe(true);
  });

  it("ignores the request port when comparing hostnames", () => {
    expect(hostMatchesPublicApiOrigin("localhost:3000", "http://localhost:3000")).toBe(true);
  });

  it("does not let tenant custom domains opt into header-based tenant selection", () => {
    expect(
      hostMatchesPublicApiOrigin(
        "custom.example.org",
        "https://api.stewardledger.church",
      ),
    ).toBe(false);
  });

  it("fails closed when PUBLIC_API_URL is malformed", () => {
    expect(hostMatchesPublicApiOrigin("api.stewardledger.church", "not a url")).toBe(false);
  });
});
