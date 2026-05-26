// packages/web/src/lib/nav.test.ts
// Checks dashboard navigation labels and route activation behavior.
// Protects sidebar information architecture from accidental regressions.
// RELEVANT FILES: packages/web/src/lib/nav.ts, packages/web/src/routes/zone/+layout.svelte, docs/ARCHITECTURE.md

import { describe, expect, it } from "vitest";
import { ZONAL_NAV, isNavActive } from "./nav";

describe("ZONAL_NAV", () => {
  it("starts with Insight so Dashboard is the first sidebar item", () => {
    // `toMatchObject` matches arrays positionally, so this assertion locks the
    // sidebar order by index. Do not switch to `arrayContaining` — ordering is
    // part of the contract this test protects. The zonal admin lands on
    // `/zone/dashboard`; pinning Insight first means the auto-open group is
    // also the top group, satisfying "Dashboard at the top, first thing open."
    expect(ZONAL_NAV[0]).toMatchObject({
      label: "Insight",
      items: [
        { href: "/zone/dashboard", label: "Dashboard" },
        { href: "/zone/partnership-progress", label: "Partnership progress" },
        { href: "/zone/reports", label: "Reports" },
      ],
    });
  });

  it("keeps the Organization group ordered Groups before Chapters", () => {
    const organization = ZONAL_NAV.find((group) => group.label === "Organization");
    expect(organization?.items).toEqual([
      { href: "/zone/groups", label: "Groups" },
      { href: "/zone/chapters", label: "Chapters" },
    ]);
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

  it("keeps Settings items active only on their own routes", () => {
    expect(
      isNavActive({ href: "/zone/audit", label: "Audit search" }, "/zone/audit/events/42"),
    ).toBe(true);
    expect(
      isNavActive({ href: "/zone/audit", label: "Audit search" }, "/zone/auditor"),
    ).toBe(false);
  });
});
