// packages/api/src/services/erasure/scrub-member.ts
// Phase 9 §6 — pure PII scrub for a single member row.
//
// Takes the pre-scrub member row + the erasure request that
// authorised the scrub, returns the partial update payload the
// caller hands to `db.update(members).set(...)`. Pure +
// side-effect-free so unit tests can exercise every branch
// without a database round-trip, and the apply path stays a
// transparent `UPDATE` with a known set of columns.
//
// Scope per `tasks/gdpr-erase-workflow.md`:
//
//   first_name        → 'erased'
//   middle_names      → null
//   last_name         → null
//   gender            → null
//   email             → null
//   date_of_birth     → null
//   mobile            → null
//   telephone         → null
//   kingschat_username→ null
//   metadata          → { erased_at, request_id }    (overwrites)
//   deleted_at        → now() if currently null
//   is_active         → false
//
// Out of scope (intentional, see DOMAIN-MODEL.md §16):
//   - `reference_code`: stays so contributions still resolve to
//     "Erased member #ref" rather than orphaning the ledger.
//   - `chapter_id`, `zone_id`, `created_at`: stay so financial
//     reports keep their structural anchors.
//   - `members.full_name` is a generated column; it recomputes
//     automatically from the new name parts ("erased").
//
// RELEVANT FILES: ./requests.ts (apply path), ./scrub-member.test.ts,
//                 packages/db/src/schema/members.ts

import type { Member } from "@stewardledger/db/schema";

export interface MemberScrubMetadata {
  erased_at: string;
  request_id: string;
}

/**
 * The shape `db.update(members).set(...)` expects. Every column we
 * touch is listed; columns we leave alone are absent from this
 * type so a future schema change that adds a PII field shows up
 * as a compile error in the apply path until this map is updated.
 */
export interface MemberScrubPatch {
  firstName: string;
  middleNames: null;
  lastName: null;
  gender: null;
  email: null;
  dateOfBirth: null;
  mobile: null;
  telephone: null;
  kingschatUsername: null;
  metadata: MemberScrubMetadata;
  isActive: false;
  /** Set when the row isn't already soft-deleted; preserved otherwise. */
  deletedAt: Date;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface BuildMemberScrubPatchInput {
  /** Pre-scrub row, as returned by `db.select().from(members)`. */
  member: Pick<Member, "deletedAt">;
  /** Erasure request id — recorded in `metadata.request_id`. */
  requestId: string;
  /** Operator applying the scrub (cron service-user is `null`). */
  actorUserId: string | null;
  /** Injected for deterministic tests. */
  now?: Date;
}

/**
 * Build the partial column patch. The function does *not* perform
 * the UPDATE — the caller stays in control of the transaction so
 * the audit row + the member update + the request status flip all
 * commit atomically.
 *
 * `deletedAt`: a member who's already soft-deleted keeps their
 * original deletion timestamp (the erase doesn't move the
 * audit-relevant soft-delete instant); a not-yet-deleted member
 * gets `deletedAt = now`. Either way `is_active` flips to false so
 * any in-flight UI render that reads the active flag stops
 * surfacing the row.
 */
export function buildMemberScrubPatch(
  input: BuildMemberScrubPatchInput,
): MemberScrubPatch {
  const now = input.now ?? new Date();
  return {
    firstName: "erased",
    middleNames: null,
    lastName: null,
    gender: null,
    email: null,
    dateOfBirth: null,
    mobile: null,
    telephone: null,
    kingschatUsername: null,
    metadata: {
      erased_at: now.toISOString(),
      request_id: input.requestId,
    },
    isActive: false,
    deletedAt: input.member.deletedAt ?? now,
    updatedAt: now,
    updatedByUserId: input.actorUserId,
  };
}
