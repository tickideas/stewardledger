// packages/web/src/lib/session-paths.test.ts

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authenticatedLandingPath,
  canAccessRole,
  canAccessRoleAnyZone,
  canEnterAdminPath,
  isProtectedPath,
  isSafeInternalPath,
  isPlatformAdminPath,
  isSuperAdminOnlyPath,
  landingInputFromServerSession,
  platformInviteLandingPath,
  primaryRole,
  PROTECTED_PREFIXES,
  PUBLIC_PREFIXES,
} from "./session-paths";

describe("isProtectedPath", () => {
  for (const prefix of PROTECTED_PREFIXES) {
    it(`matches the prefix itself: ${prefix}`, () => {
      expect(isProtectedPath(prefix)).toBe(true);
    });
    it(`matches nested children of ${prefix}`, () => {
      expect(isProtectedPath(`${prefix}/anything/deep`)).toBe(true);
    });
  }

  it("does not match the public home page", () => {
    expect(isProtectedPath("/")).toBe(false);
  });

  it("does not match prefix-similar but distinct paths", () => {
    // /zonesomething should not collide with /zone.
    expect(isProtectedPath("/zoneless")).toBe(false);
    expect(isProtectedPath("/churchill")).toBe(false);
    expect(isProtectedPath("/loginish")).toBe(false);
  });
});

describe("isSafeInternalPath", () => {
  it("accepts plain absolute paths", () => {
    expect(isSafeInternalPath("/zone/members")).toBe(true);
    expect(isSafeInternalPath("/zone/members/abc?x=1")).toBe(true);
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(isSafeInternalPath("//evil.com")).toBe(false);
    expect(isSafeInternalPath("//evil.com/members")).toBe(false);
  });

  it("rejects backslash variants (/\\evil.com)", () => {
    expect(isSafeInternalPath("/\\evil.com")).toBe(false);
  });

  it("rejects absolute external URLs", () => {
    expect(isSafeInternalPath("http://evil.com")).toBe(false);
    expect(isSafeInternalPath("https://evil.com/members")).toBe(false);
  });

  it("rejects empty / non-slash inputs", () => {
    expect(isSafeInternalPath("")).toBe(false);
    expect(isSafeInternalPath("members")).toBe(false);
  });
});

describe("isSuperAdminOnlyPath", () => {
  it("matches only /admin/administrators after SSR learned about support_admin", () => {
    // /admin/zones used to be super-admin-only here, but support_admin
    // is now admitted by both the API gate and the SSR admin layout,
    // so it is no longer in the super-admin-only set. /admin/regions
    // remains reachable by region_curator + zone-bound users.
    expect(isSuperAdminOnlyPath("/admin/zones")).toBe(false);
    expect(isSuperAdminOnlyPath("/admin/zones/demo-grace-uk")).toBe(false);
    expect(isSuperAdminOnlyPath("/admin/regions")).toBe(false);
    expect(isSuperAdminOnlyPath("/admin/zonesish")).toBe(false);
  });
  it("matches the administrators admin surface", () => {
    expect(isSuperAdminOnlyPath("/admin/administrators")).toBe(true);
    expect(isSuperAdminOnlyPath("/admin/administrators/u-123")).toBe(true);
    expect(isSuperAdminOnlyPath("/admin/administratorsish")).toBe(false);
  });
  it("matches the platform audit surface", () => {
    expect(isSuperAdminOnlyPath("/admin/audit")).toBe(true);
    expect(isSuperAdminOnlyPath("/admin/audit/anything")).toBe(true);
    expect(isSuperAdminOnlyPath("/admin/auditish")).toBe(false);
  });
});

describe("authenticatedLandingPath", () => {
  it("routes platform-only super-admins to zones", () => {
    expect(authenticatedLandingPath({ activeZoneSlug: null, isSuperAdmin: true })).toBe(
      "/admin/zones",
    );
  });

  it("allows platform-only super-admins to honor only zones-admin next paths", () => {
    const session = { activeZoneSlug: null, isSuperAdmin: true };
    expect(authenticatedLandingPath(session, "/admin/zones/demo-grace-uk")).toBe(
      "/admin/zones/demo-grace-uk",
    );
    expect(authenticatedLandingPath(session, "/zone/chapters")).toBe("/admin/zones");
    expect(authenticatedLandingPath(session, "//evil.com")).toBe("/admin/zones");
  });

  it("routes signed-in users without a usable binding to the no-zone banner", () => {
    expect(authenticatedLandingPath({ activeZoneSlug: null, isSuperAdmin: false })).toBe(
      "/login?error=no_zone",
    );
  });

  it("honors protected next paths for tenant-bound users", () => {
    expect(
      authenticatedLandingPath(
        { activeZoneSlug: "demo-grace-uk", isSuperAdmin: false },
        "/zone/contributions",
      ),
    ).toBe("/zone/contributions");
  });

  it("falls back to the zone chapter surface for tenant-bound users", () => {
    expect(authenticatedLandingPath({ activeZoneSlug: "demo grace", isSuperAdmin: false })).toBe(
      "/zone/chapters?zone=demo%20grace",
    );
  });

  it("lands chapter-only admins on the church overview", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: "demo-grace-uk",
        isSuperAdmin: false,
        activeZoneRoles: [],
        activeZoneChapterRoles: [{ chapterId: "c1", roleCode: "chapter_treasurer" }],
      }),
    ).toBe("/church/overview?zone=demo-grace-uk");
  });

  it("lands users with zone roles on the zonal dashboard even if they also have chapter roles", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: "demo-grace-uk",
        isSuperAdmin: false,
        activeZoneRoles: ["zone_admin"],
        activeZoneChapterRoles: [{ chapterId: "c1", roleCode: "chapter_treasurer" }],
      }),
    ).toBe("/zone/chapters?zone=demo-grace-uk");
  });

  it("prefers the platform surface for super-admins even when zone-bound", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: "demo-grace-uk",
        isSuperAdmin: true,
        activeZoneRoles: ["zone_admin"],
      }),
    ).toBe("/admin/zones");
  });

  it("honors a safe next regardless of primary role", () => {
    expect(
      authenticatedLandingPath(
        {
          activeZoneSlug: "demo-grace-uk",
          isSuperAdmin: false,
          activeZoneChapterRoles: [{ chapterId: "c1", roleCode: "chapter_treasurer" }],
        },
        "/church/contributions",
      ),
    ).toBe("/church/contributions");
  });
});

describe("authenticatedLandingPath \u2014 group tier", () => {
  it("group-tier without zone-tier \u2192 /group/dashboard", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: "demo",
        isSuperAdmin: false,
        platformRoles: [],
        activeZoneRoles: [],
        activeZoneGroupRoles: [{ groupId: "g1", roleCode: "group_admin" }],
        activeZoneChapterRoles: [],
      }),
    ).toBe("/group/dashboard?zone=demo");
  });

  it("group + chapter \u2192 /group/dashboard (group beats church)", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: "demo",
        isSuperAdmin: false,
        activeZoneRoles: [],
        activeZoneGroupRoles: [{ groupId: "g1", roleCode: "group_pastor_viewer" }],
        activeZoneChapterRoles: [{ chapterId: "c1", roleCode: "chapter_admin" }],
      }),
    ).toBe("/group/dashboard?zone=demo");
  });

  it("zone + group \u2192 /zone/chapters (zone still wins)", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: "demo",
        isSuperAdmin: false,
        activeZoneRoles: ["zone_admin"],
        activeZoneGroupRoles: [{ groupId: "g1", roleCode: "group_admin" }],
        activeZoneChapterRoles: [],
      }),
    ).toBe("/zone/chapters?zone=demo");
  });

  it("chapter only \u2192 /church/overview (unchanged)", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: "demo",
        isSuperAdmin: false,
        activeZoneRoles: [],
        activeZoneGroupRoles: [],
        activeZoneChapterRoles: [{ chapterId: "c1", roleCode: "chapter_admin" }],
      }),
    ).toBe("/church/overview?zone=demo");
  });
});

describe("canAccessRoleAnyZone \u2014 group", () => {
  it("returns true for any zone with group bindings", () => {
    expect(
      canAccessRoleAnyZone(
        {
          isSuperAdmin: false,
          items: [{ slug: "demo", zoneRoles: [], chapterRoles: [], groupRoles: [{ groupId: "g1", roleCode: "group_admin" }] }],
        },
        "group",
      ),
    ).toBe(true);
  });

  it("returns true for zone-tier (zone admins can also use /group)", () => {
    expect(
      canAccessRoleAnyZone(
        {
          isSuperAdmin: false,
          items: [{ slug: "demo", zoneRoles: ["zone_admin"], chapterRoles: [], groupRoles: [] }],
        },
        "group",
      ),
    ).toBe(true);
  });

  it("returns false for chapter-only users", () => {
    expect(
      canAccessRoleAnyZone(
        {
          isSuperAdmin: false,
          items: [{ slug: "demo", zoneRoles: [], chapterRoles: [{ chapterId: "c1", roleCode: "chapter_admin" }], groupRoles: [] }],
        },
        "group",
      ),
    ).toBe(false);
  });
});

describe("canAccessRole", () => {
  // Super-admins reach every dashboard. They have no zone bindings of their
  // own — the platform shell is their home, but they routinely drop into a
  // zone or chapter view for support.
  it("super-admins reach every surface", () => {
    const s = { activeZoneSlug: null, isSuperAdmin: true };
    expect(canAccessRole(s, "platform")).toBe(true);
    expect(canAccessRole(s, "zonal")).toBe(true);
    expect(canAccessRole(s, "church")).toBe(true);
  });

  // Zonal admins live one rung below platform. They run the zone and they
  // get to spot-check any chapter within it (the church surface).
  it("zone-role holders reach zonal + church but not platform", () => {
    const s = {
      activeZoneSlug: "z",
      isSuperAdmin: false,
      activeZoneRoles: ["zone_admin"],
      activeZoneChapterRoles: [],
    };
    expect(canAccessRole(s, "platform")).toBe(false);
    expect(canAccessRole(s, "zonal")).toBe(true);
    expect(canAccessRole(s, "church")).toBe(true);
  });

  // Chapter-only admins can't see zone-wide data. Bouncing them off /zone
  // saves them from a sidebar that 403s every API call.
  it("chapter-only users reach church but not zonal or platform", () => {
    const s = {
      activeZoneSlug: "z",
      isSuperAdmin: false,
      activeZoneRoles: [],
      activeZoneChapterRoles: [{ chapterId: "c1", roleCode: "chapter_treasurer" }],
    };
    expect(canAccessRole(s, "platform")).toBe(false);
    expect(canAccessRole(s, "zonal")).toBe(false);
    expect(canAccessRole(s, "church")).toBe(true);
  });

  // Tenant-bound users with no role data yet keep the legacy behaviour:
  // treat them as zonal so existing flows don't suddenly hard-fail.
  it("tenant-bound users without role data still reach zonal + church", () => {
    const s = { activeZoneSlug: "z", isSuperAdmin: false };
    expect(canAccessRole(s, "platform")).toBe(false);
    expect(canAccessRole(s, "zonal")).toBe(true);
    expect(canAccessRole(s, "church")).toBe(true);
  });

  // Defensive case: an explicit empty role array ("we asked, they have
  // nothing") must NOT trigger the legacy fallback. Without this an
  // unbound zonal user would still slip into /zone.
  it("explicitly-empty role arrays do not fall back to the legacy path", () => {
    const s = {
      activeZoneSlug: "z",
      isSuperAdmin: false,
      activeZoneRoles: [],
      activeZoneChapterRoles: [],
    };
    expect(canAccessRole(s, "zonal")).toBe(false);
    expect(canAccessRole(s, "church")).toBe(false);
  });

  it("unbound users with no super-admin flag reach nothing", () => {
    const s = { activeZoneSlug: null, isSuperAdmin: false };
    expect(canAccessRole(s, "platform")).toBe(false);
    expect(canAccessRole(s, "zonal")).toBe(false);
    expect(canAccessRole(s, "church")).toBe(false);
  });
});

describe("canAccessRoleAnyZone", () => {
  // SSR variant: no concept of an "active" zone yet, so the gate considers
  // every zone the user belongs to and lets them through if ANY qualifies.
  it("super-admins reach every surface regardless of bindings", () => {
    const s = { isSuperAdmin: true, items: [] };
    expect(canAccessRoleAnyZone(s, "platform")).toBe(true);
    expect(canAccessRoleAnyZone(s, "zonal")).toBe(true);
    expect(canAccessRoleAnyZone(s, "church")).toBe(true);
  });

  it("platform is super-admin-only", () => {
    const s = {
      isSuperAdmin: false,
      items: [{ slug: "z", zoneRoles: ["zone_admin"], chapterRoles: [] }],
    };
    expect(canAccessRoleAnyZone(s, "platform")).toBe(false);
  });

  // A user with a zone role in ANY zone can use the zonal surface. The
  // client refines on switch.
  it("any zone-role binding unlocks zonal + church", () => {
    const s = {
      isSuperAdmin: false,
      items: [
        { slug: "z1", zoneRoles: [], chapterRoles: [] },
        { slug: "z2", zoneRoles: ["zone_finance_admin"], chapterRoles: [] },
      ],
    };
    expect(canAccessRoleAnyZone(s, "zonal")).toBe(true);
    expect(canAccessRoleAnyZone(s, "church")).toBe(true);
  });

  // Chapter-only across all zones — the church gate opens, the zonal gate
  // stays closed.
  it("chapter-only users reach church but not zonal", () => {
    const s = {
      isSuperAdmin: false,
      items: [
        {
          slug: "z",
          zoneRoles: [],
          chapterRoles: [{ chapterId: "c", roleCode: "chapter_treasurer" }],
        },
      ],
    };
    expect(canAccessRoleAnyZone(s, "zonal")).toBe(false);
    expect(canAccessRoleAnyZone(s, "church")).toBe(true);
  });

  it("users with no bindings reach nothing", () => {
    const s = { isSuperAdmin: false, items: [] };
    expect(canAccessRoleAnyZone(s, "platform")).toBe(false);
    expect(canAccessRoleAnyZone(s, "zonal")).toBe(false);
    expect(canAccessRoleAnyZone(s, "church")).toBe(false);
  });
});

describe("landingInputFromServerSession", () => {
  // The SSR adapter picks the zone whose slug matches `?zone=` (if any)
  // and falls back to the first item. That mirrors how the client behaves
  // when ACTIVE_ZONE_KEY is unset.
  it("prefers a matching ?zone= slug", () => {
    const s = {
      isSuperAdmin: false,
      items: [
        { slug: "alpha", zoneRoles: ["zone_admin"], chapterRoles: [] },
        { slug: "beta", zoneRoles: [], chapterRoles: [{ chapterId: "c", roleCode: "chapter_admin" }] },
      ],
    };
    const input = landingInputFromServerSession(s, "beta");
    expect(input.activeZoneSlug).toBe("beta");
    expect(input.activeZoneRoles).toEqual([]);
    expect(input.activeZoneChapterRoles).toEqual([{ chapterId: "c", roleCode: "chapter_admin" }]);
  });

  it("falls back to the first zone when ?zone= doesn't match", () => {
    const s = {
      isSuperAdmin: false,
      items: [{ slug: "alpha", zoneRoles: ["zone_admin"], chapterRoles: [] }],
    };
    const input = landingInputFromServerSession(s, "ghost");
    expect(input.activeZoneSlug).toBe("alpha");
  });

  it("yields null slug when the user has no zones", () => {
    const s = { isSuperAdmin: true, items: [] };
    const input = landingInputFromServerSession(s, null);
    expect(input.activeZoneSlug).toBeNull();
    expect(input.isSuperAdmin).toBe(true);
  });
});

describe("primaryRole", () => {
  it("returns platform for super-admins", () => {
    expect(primaryRole({ activeZoneSlug: null, isSuperAdmin: true })).toBe("platform");
    expect(
      primaryRole({ activeZoneSlug: "z", isSuperAdmin: true, activeZoneRoles: ["zone_admin"] }),
    ).toBe("platform");
  });

  it("returns zonal when any zone-scope role is present", () => {
    expect(
      primaryRole({
        activeZoneSlug: "z",
        isSuperAdmin: false,
        activeZoneRoles: ["zone_finance_admin"],
      }),
    ).toBe("zonal");
  });

  it("returns church when only chapter-scope roles are present", () => {
    expect(
      primaryRole({
        activeZoneSlug: "z",
        isSuperAdmin: false,
        activeZoneRoles: [],
        activeZoneChapterRoles: [{ chapterId: "c1", roleCode: "chapter_admin" }],
      }),
    ).toBe("church");
  });

  it("falls back to zonal for tenant-bound users with no role data yet", () => {
    // Until the API ships role codes everywhere, an active zone slug is
    // enough signal that the user has *some* tenant access; default to the
    // zonal surface to preserve existing behaviour.
    expect(primaryRole({ activeZoneSlug: "z", isSuperAdmin: false })).toBe("zonal");
  });

  it("returns null for users with no zone and no super-admin flag", () => {
    expect(primaryRole({ activeZoneSlug: null, isSuperAdmin: false })).toBeNull();
  });
});

describe("route partitioning", () => {
  // Every top-level entry in src/routes/ must be classified as either
  // protected or public. This catches drift the moment a developer adds a
  // new feature folder without telling the gating layer about it.
  it("classifies every top-level routes/ directory", () => {
    const routesDir = join(__dirname, "..", "routes");
    const entries = readdirSync(routesDir, { withFileTypes: true });

    const known = new Set<string>([
      ...PROTECTED_PREFIXES.map((p) => p.slice(1)),
      ...PUBLIC_PREFIXES.filter((p) => p !== "/").map((p) => p.slice(1)),
    ]);

    const unclassified = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      // SvelteKit conventions: parenthesised groups (e.g. (app)) are layout
      // groupings and don't appear in the URL.
      .filter((name) => !name.startsWith("(") && !name.startsWith("_"))
      .filter((name) => !known.has(name));

    expect(unclassified).toEqual([]);
  });
});

describe("platformInviteLandingPath", () => {
  it("routes super-admin invitees to /admin/zones", () => {
    expect(
      platformInviteLandingPath({ roleCode: "support_admin", superAdmin: true }),
    ).toBe("/admin/zones");
  });
  it("routes support_admin to /admin/zones (read-only surface they can reach)", () => {
    // SSR now carries platformRoles[], so the layout admits
    // support_admin and the deep-link is safe.
    expect(
      platformInviteLandingPath({ roleCode: "support_admin", superAdmin: false }),
    ).toBe("/admin/zones");
  });
  it("routes region_curator to /admin/regions", () => {
    expect(
      platformInviteLandingPath({ roleCode: "region_curator", superAdmin: false }),
    ).toBe("/admin/regions");
  });
  it("routes billing_admin to /account until subscriptions ship", () => {
    expect(
      platformInviteLandingPath({ roleCode: "billing_admin", superAdmin: false }),
    ).toBe("/account");
  });
  it("falls back to /account on an unknown role", () => {
    expect(
      platformInviteLandingPath({ roleCode: "future_role", superAdmin: false }),
    ).toBe("/account");
  });
});

describe("isPlatformAdminPath", () => {
  it("matches anything under /admin/*", () => {
    expect(isPlatformAdminPath("/admin")).toBe(true);
    expect(isPlatformAdminPath("/admin/zones")).toBe(true);
    expect(isPlatformAdminPath("/admin/zones/demo")).toBe(true);
    expect(isPlatformAdminPath("/admin/regions")).toBe(true);
    expect(isPlatformAdminPath("/admin/administrators")).toBe(true);
  });
  it("does not match adjacent paths", () => {
    expect(isPlatformAdminPath("/admins")).toBe(false);
    expect(isPlatformAdminPath("/admincats")).toBe(false);
    expect(isPlatformAdminPath("/zone/chapters")).toBe(false);
  });
});

describe("canAccessRoleAnyZone (platform surface, with platformRoles)", () => {
  it("admits a non-super-admin with a platform-role binding", () => {
    const s = {
      isSuperAdmin: false,
      platformRoles: ["support_admin"],
      items: [],
    };
    expect(canAccessRoleAnyZone(s, "platform")).toBe(true);
  });
  it("denies a non-super-admin with no platform-role binding and no zones", () => {
    const s = { isSuperAdmin: false, platformRoles: [], items: [] };
    expect(canAccessRoleAnyZone(s, "platform")).toBe(false);
  });
  it("denies a non-super-admin when platformRoles is missing (legacy wire shape)", () => {
    const s = { isSuperAdmin: false, items: [] };
    expect(canAccessRoleAnyZone(s, "platform")).toBe(false);
  });
});

describe("primaryRole + authenticatedLandingPath (platform-roles plumbed)", () => {
  it("primaryRole returns 'platform' for a non-super-admin with any platformRoles entry", () => {
    expect(
      primaryRole({
        activeZoneSlug: null,
        isSuperAdmin: false,
        platformRoles: ["support_admin"],
      }),
    ).toBe("platform");
    expect(
      primaryRole({
        activeZoneSlug: null,
        isSuperAdmin: false,
        platformRoles: ["region_curator"],
      }),
    ).toBe("platform");
  });

  it("primaryRole still returns null for a user with neither super-admin, platform role, nor zone binding", () => {
    expect(
      primaryRole({
        activeZoneSlug: null,
        isSuperAdmin: false,
        platformRoles: [],
      }),
    ).toBeNull();
  });

  it("authenticatedLandingPath routes support_admin (platform role only) to /admin/zones", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: null,
        isSuperAdmin: false,
        platformRoles: ["support_admin"],
      }),
    ).toBe("/admin/zones");
  });

  it("authenticatedLandingPath routes region_curator (platform role only) to /admin/regions", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: null,
        isSuperAdmin: false,
        platformRoles: ["region_curator"],
      }),
    ).toBe("/admin/regions");
  });

  it("authenticatedLandingPath routes billing_admin (platform role only) to /account until Phase 10", () => {
    expect(
      authenticatedLandingPath({
        activeZoneSlug: null,
        isSuperAdmin: false,
        platformRoles: ["billing_admin"],
      }),
    ).toBe("/account");
  });
});

describe("canEnterAdminPath", () => {
  const sa = { isSuperAdmin: true, platformRoles: [] as string[], hasZoneBinding: false };
  const supportOnly = { isSuperAdmin: false, platformRoles: ["support_admin"], hasZoneBinding: false };
  const regionOnly = { isSuperAdmin: false, platformRoles: ["region_curator"], hasZoneBinding: false };
  const billingOnly = { isSuperAdmin: false, platformRoles: ["billing_admin"], hasZoneBinding: false };
  const zoneOnly = { isSuperAdmin: false, platformRoles: [] as string[], hasZoneBinding: true };
  const nothing = { isSuperAdmin: false, platformRoles: [] as string[], hasZoneBinding: false };

  it("super-admin can enter everything", () => {
    for (const p of [
      "/admin",
      "/admin/zones",
      "/admin/zones/demo",
      "/admin/regions",
      "/admin/regions/inbox",
      "/admin/administrators",
      "/admin/audit",
    ]) {
      expect(canEnterAdminPath({ pathname: p, ...sa })).toBe(true);
    }
  });

  it("/admin/administrators + /admin/audit are super-admin only", () => {
    for (const u of [supportOnly, regionOnly, billingOnly, zoneOnly, nothing]) {
      expect(canEnterAdminPath({ pathname: "/admin/administrators", ...u })).toBe(false);
      expect(canEnterAdminPath({ pathname: "/admin/audit", ...u })).toBe(false);
    }
  });

  it("/admin/zones admits super_admin + support_admin only", () => {
    expect(canEnterAdminPath({ pathname: "/admin/zones", ...supportOnly })).toBe(true);
    expect(canEnterAdminPath({ pathname: "/admin/zones", ...regionOnly })).toBe(false);
    expect(canEnterAdminPath({ pathname: "/admin/zones", ...billingOnly })).toBe(false);
    expect(canEnterAdminPath({ pathname: "/admin/zones", ...zoneOnly })).toBe(false);
    expect(canEnterAdminPath({ pathname: "/admin/zones", ...nothing })).toBe(false);
  });

  it("/admin/regions admits region_curator + support_admin (read-only) + any zone-bound user", () => {
    expect(canEnterAdminPath({ pathname: "/admin/regions", ...regionOnly })).toBe(true);
    expect(canEnterAdminPath({ pathname: "/admin/regions/inbox", ...zoneOnly })).toBe(true);
    // support_admin is read-only across tenants per PRD §6.1; the
    // mutate endpoints still gate on region_curator at the API.
    expect(canEnterAdminPath({ pathname: "/admin/regions", ...supportOnly })).toBe(true);
    expect(canEnterAdminPath({ pathname: "/admin/regions", ...billingOnly })).toBe(false);
    expect(canEnterAdminPath({ pathname: "/admin/regions", ...nothing })).toBe(false);
  });

  it("/admin index admits anyone with a meaningful platform footprint", () => {
    expect(canEnterAdminPath({ pathname: "/admin", ...supportOnly })).toBe(true);
    expect(canEnterAdminPath({ pathname: "/admin", ...regionOnly })).toBe(true);
    expect(canEnterAdminPath({ pathname: "/admin", ...zoneOnly })).toBe(true);
    expect(canEnterAdminPath({ pathname: "/admin", ...billingOnly })).toBe(false);
    expect(canEnterAdminPath({ pathname: "/admin", ...nothing })).toBe(false);
  });
});

