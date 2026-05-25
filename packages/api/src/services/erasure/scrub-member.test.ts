// packages/api/src/services/erasure/scrub-member.test.ts
// Unit tests for the pure scrub-patch builder. No DB; every
// branch covered.

import { describe, expect, it } from "vitest";
import { buildMemberScrubPatch } from "./scrub-member";

const fixedNow = new Date("2026-01-15T12:34:56.000Z");

describe("buildMemberScrubPatch", () => {
  it("scrubs every PII field to the documented sentinel / null", () => {
    const patch = buildMemberScrubPatch({
      member: { deletedAt: null },
      requestId: "er_test_123",
      actorUserId: "user_admin",
      now: fixedNow,
    });
    expect(patch.firstName).toBe("erased");
    expect(patch.middleNames).toBeNull();
    expect(patch.lastName).toBeNull();
    expect(patch.gender).toBeNull();
    expect(patch.email).toBeNull();
    expect(patch.dateOfBirth).toBeNull();
    expect(patch.mobile).toBeNull();
    expect(patch.telephone).toBeNull();
    expect(patch.kingschatUsername).toBeNull();
    expect(patch.isActive).toBe(false);
  });

  it("writes the erasure marker into metadata with the request id", () => {
    const patch = buildMemberScrubPatch({
      member: { deletedAt: null },
      requestId: "er_test_456",
      actorUserId: null,
      now: fixedNow,
    });
    expect(patch.metadata).toEqual({
      erased_at: "2026-01-15T12:34:56.000Z",
      request_id: "er_test_456",
    });
  });

  it("sets deleted_at = now when the member is not yet soft-deleted", () => {
    const patch = buildMemberScrubPatch({
      member: { deletedAt: null },
      requestId: "er_test_789",
      actorUserId: null,
      now: fixedNow,
    });
    expect(patch.deletedAt).toBe(fixedNow);
  });

  it("preserves the original soft-delete instant when the member was already soft-deleted", () => {
    const priorDeleteAt = new Date("2025-11-02T08:00:00.000Z");
    const patch = buildMemberScrubPatch({
      member: { deletedAt: priorDeleteAt },
      requestId: "er_test_dup",
      actorUserId: null,
      now: fixedNow,
    });
    expect(patch.deletedAt).toBe(priorDeleteAt);
  });

  it("records the operator as updated_by_user_id; cron-applied scrubs carry null", () => {
    const operator = buildMemberScrubPatch({
      member: { deletedAt: null },
      requestId: "er_test_op",
      actorUserId: "user_owner",
      now: fixedNow,
    });
    expect(operator.updatedByUserId).toBe("user_owner");
    const cron = buildMemberScrubPatch({
      member: { deletedAt: null },
      requestId: "er_test_cron",
      actorUserId: null,
      now: fixedNow,
    });
    expect(cron.updatedByUserId).toBeNull();
  });

  it("defaults `now` to `new Date()` when omitted", () => {
    const before = Date.now();
    const patch = buildMemberScrubPatch({
      member: { deletedAt: null },
      requestId: "er_test_now",
      actorUserId: null,
    });
    const after = Date.now();
    const t = patch.updatedAt.getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
