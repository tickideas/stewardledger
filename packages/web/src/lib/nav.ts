// packages/web/src/lib/nav.ts
// Role-scoped navigation config. Each dashboard (platform / zonal / church)
// has its own shell layout and its own NavGroup list. The root layout uses
// `roleForPath` to know which surface a URL belongs to.

export type NavItem = {
  href: string;
  label: string;
  /** Optional eyebrow shown above the label in the sidebar. */
  hint?: string;
  /** Prefix match for `aria-current`. Defaults to `href`. */
  match?: string;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export type Role = "platform" | "zonal" | "church" | "public";

/**
 * Classify a pathname into the role whose dashboard it belongs to. The root
 * layout uses this to decide whether to render its own chrome (we suppress
 * the root header on any role with its own shell).
 *
 * Onboarding is deliberately *not* classified — it runs before the user has
 * a chapter / batch / report context, so it renders under the public chrome.
 * `/account` is shared across all three roles and renders under whichever
 * shell wraps it via SvelteKit's nested-layout resolution.
 */
export function roleForPath(pathname: string): Role {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "platform";
  if (pathname === "/zone" || pathname.startsWith("/zone/")) return "zonal";
  if (pathname === "/church" || pathname.startsWith("/church/")) return "church";
  return "public";
}

/** Platform-admin sidebar — what the platform admin needs and only that. */
export const PLATFORM_NAV: NavGroup[] = [
  {
    label: "Tenants",
    items: [
      { href: "/admin/zones", label: "Zones" },
      { href: "/admin/regions", label: "Regions", match: "/admin/regions" },
      { href: "/admin/regions/inbox", label: "Inbox" },
    ],
  },
];

/**
 * Zonal sidebar. The zonal admin reads across every chapter in their zone,
 * so the navigation is the zone's editorial structure: people, giving,
 * insight.
 */
export const ZONAL_NAV: NavGroup[] = [
  {
    label: "People",
    items: [
      { href: "/zone/chapters", label: "Chapters" },
      { href: "/zone/members", label: "Members" },
      { href: "/zone/lookups", label: "Lookups" },
      { href: "/zone/merge", label: "Merge proposals" },
    ],
  },
  {
    label: "Giving",
    items: [
      { href: "/zone/contributions", label: "Contributions" },
      { href: "/zone/imports", label: "Imports" },
    ],
  },
  {
    label: "Insight",
    items: [{ href: "/zone/reports", label: "Reports" }],
  },
];

/**
 * Church-admin (chapter-scoped) sidebar. One chapter at a time. The user
 * may belong to several chapters; a chapter switcher in the sidebar lets
 * them swap the active chapter without leaving the page they're on.
 */
export const CHURCH_NAV: NavGroup[] = [
  {
    label: "Chapter",
    items: [
      { href: "/church/overview", label: "Overview" },
      { href: "/church/members", label: "Members" },
    ],
  },
  {
    label: "Giving",
    items: [
      { href: "/church/contributions", label: "Contributions" },
      { href: "/church/imports", label: "Imports" },
    ],
  },
  {
    label: "Insight",
    items: [{ href: "/church/reports", label: "Reports" }],
  },
  {
    label: "Admin",
    items: [{ href: "/church/settings", label: "Settings" }],
  },
];

/** True iff `pathname` is the active route for a NavItem. */
export function isNavActive(item: NavItem, pathname: string): boolean {
  const prefix = item.match ?? item.href;
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
