// packages/web/src/lib/partnership-progress/url.test.ts
// Phase 8 — happy + rejection-path coverage for the
// partnership-progress query-string builder.
// RELEVANT FILES: packages/web/src/lib/partnership-progress/url.ts

import { describe, expect, it } from "vitest";
import { buildPartnershipProgressQuery } from "./url";

describe("buildPartnershipProgressQuery", () => {
  it("emits only ministryYearId when other filters are blank", () => {
    expect(
      buildPartnershipProgressQuery({ ministryYearId: "my-1" }),
    ).toBe("ministryYearId=my-1");
  });

  it("appends chapterId + givingTypeId when set", () => {
    expect(
      buildPartnershipProgressQuery({
        ministryYearId: "my-1",
        chapterId: "c-7",
        givingTypeId: "gt-4",
      }),
    ).toBe("ministryYearId=my-1&chapterId=c-7&givingTypeId=gt-4");
  });

  it("drops empty-string chapter / giving-type filters", () => {
    // Sending `chapterId=` would Zod-coerce to an empty UUID and
    // 400 the request. The builder must omit the key entirely.
    expect(
      buildPartnershipProgressQuery({
        ministryYearId: "my-1",
        chapterId: "",
        givingTypeId: "",
      }),
    ).toBe("ministryYearId=my-1");
  });

  it("escapes special characters in IDs", () => {
    // UUIDs don't contain these, but the builder shouldn't
    // assume that.
    expect(
      buildPartnershipProgressQuery({
        ministryYearId: "my 1&x",
      }),
    ).toBe("ministryYearId=my+1%26x");
  });
});
