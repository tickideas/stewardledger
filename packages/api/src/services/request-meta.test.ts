// packages/api/src/services/request-meta.test.ts
// Unit tests for the x-forwarded-for parser. No DB — these are pure.
//
// RELEVANT FILES: packages/api/src/services/request-meta.ts

import { describe, expect, it } from "vitest";

import { parseForwardedIp } from "./request-meta";

describe("parseForwardedIp", () => {
  it("returns null for null / undefined / empty / whitespace", () => {
    expect(parseForwardedIp(null)).toBeNull();
    expect(parseForwardedIp(undefined)).toBeNull();
    expect(parseForwardedIp("")).toBeNull();
    expect(parseForwardedIp("   ")).toBeNull();
    expect(parseForwardedIp(",  , ")).toBeNull();
  });

  it("returns the left-most entry from a comma-separated chain", () => {
    expect(parseForwardedIp("203.0.113.7, 10.0.0.1, 10.0.0.2")).toBe("203.0.113.7");
    expect(parseForwardedIp("203.0.113.7,10.0.0.1")).toBe("203.0.113.7");
  });

  it("passes a single IPv4 / IPv6 through unchanged", () => {
    expect(parseForwardedIp("203.0.113.7")).toBe("203.0.113.7");
    expect(parseForwardedIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("strips an enclosing IPv6 bracket form", () => {
    expect(parseForwardedIp("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("refuses obvious non-IP tokens that would break inet inserts", () => {
    expect(parseForwardedIp("unknown")).toBeNull();
    expect(parseForwardedIp("not-an-ip!")).toBeNull();
    expect(parseForwardedIp("203.0.113.7; injection")).toBeNull();
  });
});
