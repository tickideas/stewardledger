// packages/web/src/lib/cookie-scope.test.ts
// Coverage for the topology classifier used by hooks.server.ts to warn on
// deployment configurations that will silently brick SSR auth.

import { describe, expect, it } from "vitest";
import {
  diagnoseCookieScope,
  isSameOriginHost,
  sharesParentDomain,
} from "./cookie-scope";

describe("isSameOriginHost", () => {
  it("matches exact hosts", () => {
    expect(isSameOriginHost("app.example.com", "app.example.com")).toBe(true);
  });
  it("ignores port", () => {
    expect(isSameOriginHost("localhost:5173", "localhost:3000")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isSameOriginHost("App.Example.com", "app.example.COM")).toBe(true);
  });
  it("returns false for different hosts", () => {
    expect(isSameOriginHost("app.example.com", "api.example.com")).toBe(false);
  });
});

describe("sharesParentDomain", () => {
  it("returns true for sibling subdomains", () => {
    expect(sharesParentDomain("app.example.com", "api.example.com")).toBe(true);
  });
  it("returns true for deeper siblings sharing the registrable parent", () => {
    expect(sharesParentDomain("eu.app.example.com", "us.api.example.com")).toBe(true);
  });
  it("returns false when only the TLD matches", () => {
    expect(sharesParentDomain("example.com", "other.com")).toBe(false);
  });
  it("returns false for unrelated hosts", () => {
    expect(sharesParentDomain("app.example.com", "api.different.org")).toBe(false);
  });
  it("returns false for single-label hosts (localhost)", () => {
    expect(sharesParentDomain("localhost", "localhost")).toBe(false);
  });
});

describe("diagnoseCookieScope", () => {
  it("classifies identical hosts as same-origin", () => {
    expect(diagnoseCookieScope("app.example.com", "app.example.com")).toEqual({
      kind: "same-origin",
    });
  });
  it("classifies localhost on different ports as same-origin", () => {
    expect(diagnoseCookieScope("localhost:5173", "localhost:3000")).toEqual({
      kind: "same-origin",
    });
  });
  it("classifies sibling subdomains as shared-parent with the parent", () => {
    expect(diagnoseCookieScope("app.example.com", "api.example.com")).toEqual({
      kind: "shared-parent",
      parent: "example.com",
    });
  });
  it("classifies unrelated hosts as cross-site", () => {
    expect(diagnoseCookieScope("app.example.com", "api.other.org")).toEqual({
      kind: "cross-site",
    });
  });
});
