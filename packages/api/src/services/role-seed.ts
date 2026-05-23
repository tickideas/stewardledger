// packages/api/src/services/role-seed.ts
// Seeds the system roles for a newly-created zone. Roles are zone-scoped rows
// in `roles`; the canonical taxonomy lives in @stewardledger/shared/roles.

import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES, type RoleCode } from "@stewardledger/shared";
import { roles } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

interface SeedRow {
  code: RoleCode;
  name: string;
  scope: "zone" | "group" | "chapter";
  permissions: string[];
}

const SYSTEM_ROLES: SeedRow[] = [
  // Zone-level
  { code: ZONE_ROLES.ZONE_OWNER, name: "Zone Owner", scope: "zone", permissions: ["zone.*"] },
  { code: ZONE_ROLES.ZONE_ADMIN, name: "Zone Admin", scope: "zone", permissions: ["zone.admin"] },
  {
    code: ZONE_ROLES.ZONE_FINANCE_ADMIN,
    name: "Zone Finance Admin",
    scope: "zone",
    permissions: ["finance.*"],
  },
  {
    code: ZONE_ROLES.ZONE_AUDITOR,
    name: "Zone Auditor",
    scope: "zone",
    permissions: ["audit.read", "report.read"],
  },
  {
    code: ZONE_ROLES.ZONE_PASTOR_VIEWER,
    name: "Zone Pastor (Viewer)",
    scope: "zone",
    permissions: ["report.read"],
  },
  // Group-level
  {
    code: GROUP_ROLES.GROUP_ADMIN,
    name: "Group Admin",
    scope: "group",
    permissions: [
      "group.read",
      "chapter.read",
      "chapter.write",
      "member.read",
      "contribution.read",
      "import.read",
      "report.read",
      "audit.read",
      "target.read",
      "invitation.write",
    ],
  },
  {
    code: GROUP_ROLES.GROUP_PASTOR_VIEWER,
    name: "Group Pastor (Viewer)",
    scope: "group",
    permissions: [
      "group.read",
      "chapter.read",
      "member.read",
      "contribution.read",
      "report.read",
      "target.read",
    ],
  },
  // Chapter-level
  {
    code: CHAPTER_ROLES.CHAPTER_ADMIN,
    name: "Chapter Admin",
    scope: "chapter",
    permissions: ["chapter.admin"],
  },
  {
    code: CHAPTER_ROLES.CHAPTER_TREASURER,
    name: "Chapter Treasurer",
    scope: "chapter",
    permissions: ["contribution.write", "contribution.read", "report.read"],
  },
  {
    code: CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
    name: "Chapter Bookkeeper",
    scope: "chapter",
    permissions: ["contribution.read", "report.read"],
  },
  {
    code: CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER,
    name: "Chapter Pastor (Viewer)",
    scope: "chapter",
    permissions: ["report.read"],
  },
];

/** Insert the system roles for a zone. Returns a map of role code → role id. */
export async function seedZoneRoles(
  database: Db,
  zoneId: string,
): Promise<Map<string, string>> {
  const inserted = await database
    .insert(roles)
    .values(
      SYSTEM_ROLES.map((r) => ({
        zoneId,
        code: r.code,
        name: r.name,
        scope: r.scope,
        permissions: r.permissions,
        isSystem: true,
      })),
    )
    .returning({ id: roles.id, code: roles.code });
  return new Map(inserted.map((r) => [r.code, r.id]));
}
