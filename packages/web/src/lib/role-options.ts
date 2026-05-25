// packages/web/src/lib/role-options.ts
// Shared display metadata for tenant roles.
//
// `INVITABLE_*` drives invitation forms; `ALL_TENANT_ROLE_OPTIONS`
// drives surfaces that need every code (e.g. the platform-admin
// MFA enforcement form). `roleLabel(code)` resolves either set.
//
// RELEVANT FILES: packages/shared/src/roles.ts, packages/web/src/routes/zone/administrators/+page.svelte, packages/web/src/routes/admin/zones/[slug]/+page.svelte

import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "@stewardledger/shared";

export type RoleOption = {
  value: string;
  label: string;
};

export const INVITABLE_ZONE_ROLE_OPTIONS: RoleOption[] = [
  { value: ZONE_ROLES.ZONE_ADMIN, label: "Zone admin" },
  { value: ZONE_ROLES.ZONE_FINANCE_ADMIN, label: "Zone finance admin" },
  { value: ZONE_ROLES.ZONE_AUDITOR, label: "Zone auditor" },
  { value: ZONE_ROLES.ZONE_PASTOR_VIEWER, label: "Zone pastor viewer" },
];

export const INVITABLE_CHAPTER_ROLE_OPTIONS: RoleOption[] = [
  { value: CHAPTER_ROLES.CHAPTER_ADMIN, label: "Chapter admin" },
  { value: CHAPTER_ROLES.CHAPTER_TREASURER, label: "Chapter treasurer" },
  { value: CHAPTER_ROLES.CHAPTER_BOOKKEEPER, label: "Chapter bookkeeper" },
  { value: CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER, label: "Chapter pastor viewer" },
];

/**
 * Every tenant role grouped by scope. Used by the platform-admin MFA
 * enforcement surface so an operator can flip enforcement on any
 * tenant role (including `zone_owner`, which we never expose in the
 * invitation form).
 */
export const ALL_TENANT_ROLE_OPTIONS_BY_SCOPE: {
  scope: "zone" | "group" | "chapter";
  label: string;
  options: RoleOption[];
}[] = [
  {
    scope: "zone",
    label: "Zone roles",
    options: [
      { value: ZONE_ROLES.ZONE_OWNER, label: "Zone owner" },
      { value: ZONE_ROLES.ZONE_ADMIN, label: "Zone admin" },
      { value: ZONE_ROLES.ZONE_FINANCE_ADMIN, label: "Zone finance admin" },
      { value: ZONE_ROLES.ZONE_AUDITOR, label: "Zone auditor" },
      { value: ZONE_ROLES.ZONE_PASTOR_VIEWER, label: "Zone pastor viewer" },
    ],
  },
  {
    scope: "group",
    label: "Group roles",
    options: [
      { value: GROUP_ROLES.GROUP_ADMIN, label: "Group admin" },
      { value: GROUP_ROLES.GROUP_PASTOR_VIEWER, label: "Group pastor viewer" },
    ],
  },
  {
    scope: "chapter",
    label: "Chapter roles",
    options: [
      { value: CHAPTER_ROLES.CHAPTER_ADMIN, label: "Chapter admin" },
      { value: CHAPTER_ROLES.CHAPTER_TREASURER, label: "Chapter treasurer" },
      { value: CHAPTER_ROLES.CHAPTER_BOOKKEEPER, label: "Chapter bookkeeper" },
      {
        value: CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER,
        label: "Chapter pastor viewer",
      },
    ],
  },
];

const roleLabels = new Map(
  [
    ...INVITABLE_ZONE_ROLE_OPTIONS,
    ...INVITABLE_CHAPTER_ROLE_OPTIONS,
    ...ALL_TENANT_ROLE_OPTIONS_BY_SCOPE.flatMap((g) => g.options),
  ].map((role) => [role.value, role.label]),
);

export function roleLabel(code: string): string {
  return roleLabels.get(code) ?? code;
}
