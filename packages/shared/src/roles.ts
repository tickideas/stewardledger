// packages/shared/src/roles.ts
// Role taxonomy. See docs/PRD.md §6.

/** Platform roles — not bound to any tenant. */
export const PLATFORM_ROLES = {
  SUPER_ADMIN: "super_admin",
  SUPPORT_ADMIN: "support_admin",
  BILLING_ADMIN: "billing_admin",
  REGION_CURATOR: "region_curator",
} as const;
export type PlatformRoleCode = (typeof PLATFORM_ROLES)[keyof typeof PLATFORM_ROLES];

/** Zone-level roles — apply across the whole tenant. */
export const ZONE_ROLES = {
  ZONE_OWNER: "zone_owner",
  ZONE_ADMIN: "zone_admin",
  ZONE_FINANCE_ADMIN: "zone_finance_admin",
  ZONE_AUDITOR: "zone_auditor",
  ZONE_PASTOR_VIEWER: "zone_pastor_viewer",
} as const;
export type ZoneRoleCode = (typeof ZONE_ROLES)[keyof typeof ZONE_ROLES];

/** Group-level roles — apply to all chapters within a single group. */
export const GROUP_ROLES = {
  GROUP_ADMIN: "group_admin",
  GROUP_PASTOR_VIEWER: "group_pastor_viewer",
} as const;
export type GroupRoleCode = (typeof GROUP_ROLES)[keyof typeof GROUP_ROLES];

/** Chapter-level roles — apply to a single chapter only. */
export const CHAPTER_ROLES = {
  CHAPTER_ADMIN: "chapter_admin",
  CHAPTER_TREASURER: "chapter_treasurer",
  CHAPTER_BOOKKEEPER: "chapter_bookkeeper",
  CHAPTER_PASTOR_VIEWER: "chapter_pastor_viewer",
} as const;
export type ChapterRoleCode = (typeof CHAPTER_ROLES)[keyof typeof CHAPTER_ROLES];

export type RoleCode = PlatformRoleCode | ZoneRoleCode | GroupRoleCode | ChapterRoleCode;

/** Role scope — determines where a binding is valid. */
export type RoleScope = "platform" | "zone" | "group" | "chapter";

/** Lookup the scope of a role code. */
export function roleScope(code: string): RoleScope | null {
  if ((Object.values(PLATFORM_ROLES) as string[]).includes(code)) return "platform";
  if ((Object.values(ZONE_ROLES) as string[]).includes(code)) return "zone";
  if ((Object.values(GROUP_ROLES) as string[]).includes(code)) return "group";
  if ((Object.values(CHAPTER_ROLES) as string[]).includes(code)) return "chapter";
  return null;
}

/** True if the role can read all chapters in a zone (zone-level or above). */
export function isZoneWideRole(code: string): boolean {
  const scope = roleScope(code);
  return scope === "platform" || scope === "zone";
}

/** True if the role can read across multiple chapters but not the whole zone. */
export function isGroupScopedRole(code: string): boolean {
  return roleScope(code) === "group";
}
