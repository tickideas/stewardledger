// packages/web/src/lib/nav.test.ts
// Checks dashboard navigation labels and route activation behavior.
// Protects sidebar information architecture from accidental regressions.
// RELEVANT FILES: packages/web/src/lib/nav.ts, packages/web/src/routes/zone/+layout.svelte, docs/ARCHITECTURE.md

import { describe, expect, it } from "vitest";
import { ZONAL_NAV, isNavActive } from "./nav";

describe("ZONAL_NAV", () => {
  it("starts with the Organization group and orders Groups before Chapters", () => {
    expect(ZONAL_NAV[0]).toMatchObject({
      label: "Organization",
      items: [
        { href: "/zone/groups", label: "Groups" },
        { href: "/zone/chapters", label: "Chapters" },
      ],
    });
  });

  it("keeps team administration under Settings with a clearer label", () => {
    const settings = ZONAL_NAV.find((group) => group.label === "Settings");

    expect(settings?.items).toContainEqual({
      href: "/zone/administrators",
      label: "Team access",
    });
  });
});

describe("isNavActive", () => {
  it("marks nested routes active for their sidebar item", () => {
    expect(isNavActive({ href: "/zone/groups", label: "Groups" }, "/zone/groups/g-1")).toBe(
      true,
    );
  });

  it("does not mark prefix-similar routes as active", () => {
    expect(isNavActive({ href: "/zone/groups", label: "Groups" }, "/zone/groupsish")).toBe(
      false,
    );
  });
});
