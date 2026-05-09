// packages/web/src/lib/contributions/member-selection.ts
//
// Pure resolution of "what member did the treasurer mean to attribute
// this contribution to?" — extracted from the batch detail's add-row
// flow so the rules are testable in isolation.
//
// The hot-path bug we are guarding against:
//
//   1. Treasurer types "John Smith" — typeahead fires, returns one match.
//   2. Treasurer overtypes to "John Smit Jr" (no such member).
//   3. Treasurer presses "Add row" within the debounce window, before
//      the new typeahead query has run.
//   4. The cached `results` are still from step 1 → naive auto-pick
//      attaches the row to the wrong John.
//
// We close it by tracking which query produced the cached results, and
// refusing to auto-pick when the trimmed input has drifted.

export interface ResolutionMember {
  id: string;
  /** Free-form label used in error messages to disambiguate. */
  label: string;
}

export type Resolution =
  | { kind: "ok"; memberId: string | null; auto: boolean }
  | { kind: "error"; code: ResolutionErrorCode; message: string };

export type ResolutionErrorCode =
  | "stale_results"
  | "no_match"
  | "ambiguous_match";

export interface ResolutionInput {
  /** The text currently in the search field. */
  query: string;
  /** The id of a member the user explicitly clicked in the dropdown. */
  pickedMemberId: string;
  /** The most recent typeahead result set. */
  results: ResolutionMember[];
  /**
   * The trimmed query string that produced `results`. `null` means we
   * have no fresh results (initial state, or the user just typed and
   * the debounce hasn't fired yet).
   */
  resultsForQuery: string | null;
}

/**
 * Resolve which `memberId` (if any) to attach a contribution to.
 *
 * Rules, in order:
 *   1. Empty query → ok, unattributed (`memberId: null`). Loose-cash rows.
 *   2. User explicitly clicked a dropdown row → ok, that id.
 *   3. Query is non-empty and no explicit pick → look at typeahead:
 *      a. Results are stale (different query) → reject; ask the user to
 *         wait or pick from the list.
 *      b. Zero matches for the current query → reject.
 *      c. Exactly one match → auto-pick (`auto: true`).
 *      d. Multiple matches → reject; ask the user to disambiguate.
 */
export function resolveMemberSelection(input: ResolutionInput): Resolution {
  const trimmed = input.query.trim();

  if (trimmed === "") {
    return { kind: "ok", memberId: null, auto: false };
  }

  if (input.pickedMemberId) {
    return { kind: "ok", memberId: input.pickedMemberId, auto: false };
  }

  if (input.resultsForQuery !== trimmed) {
    return {
      kind: "error",
      code: "stale_results",
      message:
        "Wait a moment for the search to finish, or pick a member from the list.",
    };
  }

  if (input.results.length === 0) {
    return {
      kind: "error",
      code: "no_match",
      message:
        "No member matches that search. Pick one from the list, or clear the field for an unattributed row.",
    };
  }

  if (input.results.length === 1) {
    return { kind: "ok", memberId: input.results[0].id, auto: true };
  }

  // Surface the first three matches to help the treasurer disambiguate
  // without re-opening the dropdown. (Round-2 review additional suggestion.)
  const sample = input.results
    .slice(0, 3)
    .map((m) => m.label)
    .join(", ");
  return {
    kind: "error",
    code: "ambiguous_match",
    message: `More than one member matches: ${sample}${
      input.results.length > 3 ? ", …" : ""
    }. Pick one from the list, or clear the field for an unattributed row.`,
  };
}
