// packages/web/src/lib/paying-in-books/access.test.ts
// Phase 8 — happy + rejection-path coverage for the paying-in-books
// write-predicate. Mirrors the server-side route gate so a future
// drift between client and server surfaces as a failing test.
// RELEVANT FILES: packages/web/src/lib/paying-in-books/access.ts, packages/api/src/routes/tenant-paying-in-books.ts

import { describe, expect, it } from "vitest";
import type { AuthorizedContext } from "@stewardledger/shared";
import {
  canWritePayingInBook,
  hasChapterWritePayingInBooks,
  hasZoneWritePayingInBooks,
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

describe("hasZoneWritePayingInBooks", () => {
  it("accepts zone_owner / zone_admin / zone_finance_admin", () => {
    expect(hasZoneWritePayingInBooks(ctx({ roleCodes: ["zone_owner"] }))).toBe(true);
    expect(hasZoneWritePayingInBooks(ctx({ roleCodes: ["zone_admin"] }))).toBe(true);
    expect(
      hasZoneWritePayingInBooks(ctx({ roleCodes: ["zone_finance_admin"] })),
    ).toBe(true);
  });

  it("accepts a platform admin even without an explicit role", () => {
    expect(hasZoneWritePayingInBooks(ctx({ isPlatformAdmin: true }))).toBe(true);
  });

  it("rejects zone_auditor / zone_pastor_viewer / chapter roles / no auth", () => {
    expect(hasZoneWritePayingInBooks(ctx({ roleCodes: ["zone_auditor"] }))).toBe(false);
    expect(
      hasZoneWritePayingInBooks(ctx({ roleCodes: ["zone_pastor_viewer"] })),
    ).toBe(false);
    expect(hasZoneWritePayingInBooks(ctx({ roleCodes: ["chapter_admin"] }))).toBe(false);
    expect(
      hasZoneWritePayingInBooks(ctx({ roleCodes: ["chapter_treasurer"] })),
    ).toBe(false);
    expect(hasZoneWritePayingInBooks(null)).toBe(false);
  });
});

describe("hasChapterWritePayingInBooks", () => {
  it("accepts chapter_admin only", () => {
    expect(hasChapterWritePayingInBooks(ctx({ roleCodes: ["chapter_admin"] }))).toBe(
      true,
    );
    expect(
      hasChapterWritePayingInBooks(ctx({ roleCodes: ["chapter_treasurer"] })),
    ).toBe(false);
    expect(
      hasChapterWritePayingInBooks(ctx({ roleCodes: ["chapter_bookkeeper"] })),
    ).toBe(false);
    expect(hasChapterWritePayingInBooks(null)).toBe(false);
  });
});

describe("canWritePayingInBook", () => {
  it("zone-write roles can write any chapter's book", () => {
    expect(
      canWritePayingInBook(ctx({ roleCodes: ["zone_finance_admin"] }), "c-any"),
    ).toBe(true);
    // Even when chapter_ids is empty (zone owners don't need a
    // chapter binding to write).
    expect(canWritePayingInBook(ctx({ roleCodes: ["zone_owner"] }), "c-any")).toBe(
      true,
    );
  });

  it("chapter_admin can write only their bound chapter's book", () => {
    const auth = ctx({ roleCodes: ["chapter_admin"], chapterIds: ["c-bound"] });
    expect(canWritePayingInBook(auth, "c-bound")).toBe(true);
    expect(canWritePayingInBook(auth, "c-other")).toBe(false);
  });

  it("chapter_admin with no bindings cannot write any book", () => {
    // Edge case: a chapter_admin role assignment without any chapter
    // bindings (data integrity glitch). The predicate must not grant
    // access on the basis of the role alone.
    const auth = ctx({ roleCodes: ["chapter_admin"], chapterIds: [] });
    expect(canWritePayingInBook(auth, "c-any")).toBe(false);
  });

  it("chapter_treasurer is never a writer", () => {
    const auth = ctx({
      roleCodes: ["chapter_treasurer"],
      chapterIds: ["c-bound"],
    });
    expect(canWritePayingInBook(auth, "c-bound")).toBe(false);
  });

  it("null auth always rejects", () => {
    expect(canWritePayingInBook(null, "c-any")).toBe(false);
  });
});
