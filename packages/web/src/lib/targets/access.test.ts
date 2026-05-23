// packages/web/src/lib/targets/access.test.ts
// Phase 8 — happy + rejection-path coverage for the financial-targets
// write predicate. Mirrors the server-side route gate so a future
// drift between client and server surfaces as a failing test.
// RELEVANT FILES: packages/web/src/lib/targets/access.ts, packages/api/src/routes/tenant-targets.ts

import { describe, expect, it } from "vitest";
import type { AuthorizedContext } from "@stewardledger/shared";
import {
  canWriteFinancialTarget,
  hasChapterWriteTargets,
  hasZoneWriteTargets,
} from "./access";

function ctx(overrides: Partial<AuthorizedContext> = {}): AuthorizedContext {
  return {
    userId: "u-stub",
    zoneId: "z-stub",
    regionId: null,
    roleCodes: [],
    chapterIds: [],
    groupIds: [],
    isPlatformAdmin: false,
    ...overrides,
  };
}

describe("hasZoneWriteTargets", () => {
  it("accepts zone_owner / zone_admin / zone_finance_admin", () => {
    expect(hasZoneWriteTargets(ctx({ roleCodes: ["zone_owner"] }))).toBe(true);
    expect(hasZoneWriteTargets(ctx({ roleCodes: ["zone_admin"] }))).toBe(true);
    expect(hasZoneWriteTargets(ctx({ roleCodes: ["zone_finance_admin"] }))).toBe(true);
  });

  it("accepts a platform admin", () => {
    expect(hasZoneWriteTargets(ctx({ isPlatformAdmin: true }))).toBe(true);
  });

  it("rejects viewer roles, chapter roles, null", () => {
    expect(hasZoneWriteTargets(ctx({ roleCodes: ["zone_auditor"] }))).toBe(false);
    expect(hasZoneWriteTargets(ctx({ roleCodes: ["chapter_admin"] }))).toBe(false);
    expect(hasZoneWriteTargets(ctx({ roleCodes: ["chapter_treasurer"] }))).toBe(false);
    expect(hasZoneWriteTargets(null)).toBe(false);
  });
});

describe("hasChapterWriteTargets", () => {
  it("accepts chapter_admin with at least one binding", () => {
    expect(
      hasChapterWriteTargets(
        ctx({ roleCodes: ["chapter_admin"], chapterIds: ["c-bound"] }),
      ),
    ).toBe(true);
  });

  it("rejects chapter_admin with no bindings", () => {
    // A chapter_admin role assignment without any bindings is a
    // data-integrity edge case; the server-side route rejects
    // writes for it, so the UI must not show a 'new target' CTA.
    expect(
      hasChapterWriteTargets(ctx({ roleCodes: ["chapter_admin"], chapterIds: [] })),
    ).toBe(false);
  });

  it("rejects non-admin chapter roles + null", () => {
    expect(
      hasChapterWriteTargets(
        ctx({ roleCodes: ["chapter_treasurer"], chapterIds: ["c-bound"] }),
      ),
    ).toBe(false);
    expect(
      hasChapterWriteTargets(
        ctx({ roleCodes: ["chapter_bookkeeper"], chapterIds: ["c-bound"] }),
      ),
    ).toBe(false);
    expect(hasChapterWriteTargets(null)).toBe(false);
  });
});

describe("canWriteFinancialTarget", () => {
  it("zone-write roles can write any chapter's target + zone-wide", () => {
    expect(
      canWriteFinancialTarget(ctx({ roleCodes: ["zone_finance_admin"] }), "c-any"),
    ).toBe(true);
    expect(
      canWriteFinancialTarget(ctx({ roleCodes: ["zone_owner"] }), null),
    ).toBe(true);
  });

  it("chapter_admin can write only their bound chapter's target", () => {
    const auth = ctx({ roleCodes: ["chapter_admin"], chapterIds: ["c-bound"] });
    expect(canWriteFinancialTarget(auth, "c-bound")).toBe(true);
    expect(canWriteFinancialTarget(auth, "c-other")).toBe(false);
  });

  it("chapter_admin cannot write a zone-wide target", () => {
    // Zone-wide policy is a zone-level decision; chapter-admin
    // ownership doesn't grant it.
    const auth = ctx({ roleCodes: ["chapter_admin"], chapterIds: ["c-bound"] });
    expect(canWriteFinancialTarget(auth, null)).toBe(false);
  });

  it("chapter_admin with no bindings rejects everything", () => {
    const auth = ctx({ roleCodes: ["chapter_admin"], chapterIds: [] });
    expect(canWriteFinancialTarget(auth, "c-any")).toBe(false);
    expect(canWriteFinancialTarget(auth, null)).toBe(false);
  });

  it("treasurer is never a writer", () => {
    const auth = ctx({
      roleCodes: ["chapter_treasurer"],
      chapterIds: ["c-bound"],
    });
    expect(canWriteFinancialTarget(auth, "c-bound")).toBe(false);
    expect(canWriteFinancialTarget(auth, null)).toBe(false);
  });

  it("null auth always rejects", () => {
    expect(canWriteFinancialTarget(null, "c-any")).toBe(false);
    expect(canWriteFinancialTarget(null, null)).toBe(false);
  });
});
