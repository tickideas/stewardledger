// packages/web/src/lib/role-options.ts
// Shared display metadata for tenant-invitable roles.
// Keeps invitation forms consistent as zone and chapter role labels evolve.
// RELEVANT FILES: packages/shared/src/roles.ts, packages/web/src/routes/zone/administrators/+page.svelte, packages/web/src/routes/onboarding/invites/+page.svelte

import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";

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

const roleLabels = new Map(
  [...INVITABLE_ZONE_ROLE_OPTIONS, ...INVITABLE_CHAPTER_ROLE_OPTIONS].map((role) => [
    role.value,
    role.label,
  ]),
);

export function roleLabel(code: string): string {
  return roleLabels.get(code) ?? code;
}
