// packages/web/src/lib/targets/numeric.test.ts
// Phase 8 — happy + rejection-path coverage for the text-input
// integer parser used by the financial-targets form. Existed
// specifically because `Number("abc")` is NaN, which JSON-serialises
// to null and would silently clear the server-side field.
// RELEVANT FILES: packages/web/src/lib/targets/numeric.ts

import { describe, expect, it } from "vitest";
import { parseOptionalCount } from "./numeric";

describe("parseOptionalCount", () => {
  it("returns null for blank / whitespace input", () => {
    expect(parseOptionalCount("", "X")).toBeNull();
    expect(parseOptionalCount("   ", "X")).toBeNull();
  });

  it("accepts well-formed non-negative integers", () => {
    expect(parseOptionalCount("0", "X")).toBe(0);
    expect(parseOptionalCount("7", "X")).toBe(7);
    expect(parseOptionalCount("42", "X")).toBe(42);
    expect(parseOptionalCount("  100  ", "X")).toBe(100);
  });

  it("rejects non-numeric / mistyped values", () => {
    // Each of these would have been Number()'d to NaN and shipped
    // as JSON null — the bug we're guarding against.
    expect(() => parseOptionalCount("abc", "Partners")).toThrow(/Partners/);
    expect(() => parseOptionalCount("5o", "Partners")).toThrow(/Partners/);
    expect(() => parseOptionalCount("5e2", "Copies")).toThrow(/Copies/);
  });

  it("rejects negatives, signs, and decimals", () => {
    expect(() => parseOptionalCount("-1", "X")).toThrow();
    expect(() => parseOptionalCount("+1", "X")).toThrow();
    expect(() => parseOptionalCount("3.5", "X")).toThrow();
    expect(() => parseOptionalCount("3.0", "X")).toThrow();
  });

  it("rejects leading zeros (other than the literal '0')", () => {
    expect(() => parseOptionalCount("007", "X")).toThrow();
    expect(() => parseOptionalCount("0123", "X")).toThrow();
  });

  it("rejects values larger than MAX_SAFE_INTEGER", () => {
    // 17 digits of 9s overflows MAX_SAFE_INTEGER.
    expect(() => parseOptionalCount("99999999999999999", "X")).toThrow(/too large/);
  });
});
