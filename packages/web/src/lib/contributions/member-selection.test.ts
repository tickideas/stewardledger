// packages/web/src/lib/contributions/member-selection.test.ts

import { describe, expect, it } from "vitest";
import {
  resolveMemberSelection,
  type ResolutionInput,
  type ResolutionMember,
} from "./member-selection";

const john: ResolutionMember = { id: "m-john", label: "John Smith · M0000001" };
const johnny: ResolutionMember = { id: "m-johnny", label: "Johnny Cash · M0000002" };
const johanna: ResolutionMember = { id: "m-johanna", label: "Johanna · M0000003" };

function input(overrides: Partial<ResolutionInput>): ResolutionInput {
  return {
    query: "",
    pickedMemberId: "",
    results: [],
    resultsForQuery: null,
    ...overrides,
  };
}

describe("resolveMemberSelection", () => {
  it("empty query → unattributed (loose-cash row)", () => {
    expect(resolveMemberSelection(input({ query: "" }))).toEqual({
      kind: "ok",
      memberId: null,
      auto: false,
    });
    // Whitespace-only is still empty.
    expect(resolveMemberSelection(input({ query: "   " }))).toEqual({
      kind: "ok",
      memberId: null,
      auto: false,
    });
  });

  it("explicit pick wins over query state", () => {
    // Even with stale results, if the user clicked a dropdown row, trust it.
    expect(
      resolveMemberSelection(
        input({
          query: "John",
          pickedMemberId: "m-john",
          results: [],
          resultsForQuery: null,
        }),
      ),
    ).toEqual({ kind: "ok", memberId: "m-john", auto: false });
  });

  it("rejects stale results — query has drifted past the last typeahead", () => {
    // The hot-path bug: cached results from the previous query.
    const result = resolveMemberSelection(
      input({
        query: "John Smit Jr",
        pickedMemberId: "",
        results: [john],
        resultsForQuery: "John Smith",
      }),
    );
    expect(result).toEqual({
      kind: "error",
      code: "stale_results",
      message: expect.stringContaining("Wait a moment"),
    });
  });

  it("rejects when typeahead has not yet run for any query", () => {
    const result = resolveMemberSelection(
      input({
        query: "Anything",
        results: [],
        resultsForQuery: null,
      }),
    );
    expect(result).toEqual({
      kind: "error",
      code: "stale_results",
      message: expect.any(String),
    });
  });

  it("trims the query before comparing to resultsForQuery", () => {
    const result = resolveMemberSelection(
      input({
        query: "  John Smith  ",
        results: [john],
        resultsForQuery: "John Smith",
      }),
    );
    expect(result).toEqual({ kind: "ok", memberId: "m-john", auto: true });
  });

  it("zero matches → rejects with a clear message", () => {
    const result = resolveMemberSelection(
      input({
        query: "Nobody",
        results: [],
        resultsForQuery: "Nobody",
      }),
    );
    expect(result).toEqual({
      kind: "error",
      code: "no_match",
      message: expect.stringContaining("No member matches"),
    });
  });

  it("exactly one match → auto-pick", () => {
    const result = resolveMemberSelection(
      input({
        query: "John Smith",
        results: [john],
        resultsForQuery: "John Smith",
      }),
    );
    expect(result).toEqual({ kind: "ok", memberId: "m-john", auto: true });
  });

  it("multiple matches → rejects, names the first three", () => {
    const result = resolveMemberSelection(
      input({
        query: "Joh",
        results: [john, johnny, johanna],
        resultsForQuery: "Joh",
      }),
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return; // narrow for TS
    expect(result.code).toBe("ambiguous_match");
    expect(result.message).toContain("John Smith");
    expect(result.message).toContain("Johnny Cash");
    expect(result.message).toContain("Johanna");
  });

  it("multiple matches > 3 → message includes ellipsis", () => {
    const fourth: ResolutionMember = { id: "m-josh", label: "Josh · M0000004" };
    const result = resolveMemberSelection(
      input({
        query: "Jo",
        results: [john, johnny, johanna, fourth],
        resultsForQuery: "Jo",
      }),
    );
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toContain(", …");
  });
});
