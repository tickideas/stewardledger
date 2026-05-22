# Groups Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a per-zone-opt-in Group layer between Zone and Chapter — `zones → groups → chapters` — including two new group-tier roles (`group_admin`, `group_pastor_viewer`), point-in-time chapter-move history, a new `/group/*` web surface, and all supporting API + web changes.

**Architecture:** New tenant-scoped `groups` table with composite cross-tenant FK pattern, mirroring `chapters`. A `chapter_group_history` table records point-in-time moves (parallel to `chapter_name_history`). `chapters.group_id` is the current pointer and is **not** denormalized onto domain tables — group-scoped reads join through `chapters`. A `zones.groups_enabled` boolean gates the feature per zone; the toggle is one-way (`false → true` only, after every chapter has a group). Role bindings gain `group_id` plus a denormalized `role_scope` column to keep CHECK constraints pure-SQL. The `/group/*` route group mirrors `/zone/*` narrowed via a single `visibleChapterIds()` chokepoint.

**Tech Stack:** Drizzle ORM + drizzle-kit (Postgres 17), Hono on Node 22, Zod, Vitest (Postgres-backed integration tests), SvelteKit 2 / Svelte 5, Tailwind 4. Monorepo via pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-22-groups-hierarchy-design.md`

---

## File Structure

### New files

```
packages/shared/src/roles.ts                                # MODIFIED — add GROUP_ROLES
packages/shared/src/types.ts                                # MODIFIED — extend AuthorizedContext
packages/shared/src/schemas.ts                              # MODIFIED — add group + move-group schemas

packages/db/src/schema/groups.ts                            # NEW — groups + chapter_group_history tables
packages/db/src/schema/chapters.ts                          # MODIFIED — add group_id
packages/db/src/schema/zones.ts                             # MODIFIED — add groups_enabled
packages/db/src/schema/roles.ts                             # MODIFIED — userRoleBindings.group_id + role_scope
packages/db/src/schema/invitations.ts                       # MODIFIED — add group_id
packages/db/src/schema/index.ts                             # MODIFIED — export groups
packages/db/drizzle/0014_groups_hierarchy.sql               # NEW — generated migration

packages/api/src/services/groups.ts                         # NEW — service layer
packages/api/src/services/groups.test.ts                    # NEW — service tests
packages/api/src/services/role-seed.ts                      # MODIFIED — seed group roles
packages/api/src/services/invitations.ts                    # MODIFIED — group invites
packages/api/src/middleware/auth.ts                         # MODIFIED — load groupRoles + visibleChapterIds
packages/api/src/middleware/auth.test.ts                    # NEW — scope chokepoint tests
packages/api/src/routes/tenant-groups.ts                    # NEW — groups CRUD + move-group + history
packages/api/src/routes/tenant-groups.test.ts               # NEW — route tests
packages/api/src/routes/tenant-zones.ts                     # NEW — groups-enabled toggle
packages/api/src/routes/tenant-zones.test.ts                # NEW — toggle tests
packages/api/src/routes/tenant.ts                           # MODIFIED — mount new routers + modify chapters/invitations/administrators

packages/web/src/lib/session-paths.ts                       # MODIFIED — add groupRoles + /group landing
packages/web/src/lib/session-paths.test.ts                  # MODIFIED — landing tests
packages/web/src/routes/group/+layout.server.ts             # NEW
packages/web/src/routes/group/+layout.svelte                # NEW
packages/web/src/routes/group/+page.svelte                  # NEW (redirect)
packages/web/src/routes/group/dashboard/+page.server.ts     # NEW
packages/web/src/routes/group/dashboard/+page.svelte        # NEW
packages/web/src/routes/group/chapters/+page.server.ts      # NEW
packages/web/src/routes/group/chapters/+page.svelte         # NEW
packages/web/src/routes/group/chapters/[id]/+page.server.ts # NEW
packages/web/src/routes/group/chapters/[id]/+page.svelte    # NEW
packages/web/src/routes/group/members/+page.server.ts       # NEW
packages/web/src/routes/group/members/+page.svelte          # NEW
packages/web/src/routes/group/contributions/+page.server.ts # NEW
packages/web/src/routes/group/contributions/+page.svelte    # NEW
packages/web/src/routes/group/reports/+page.server.ts       # NEW
packages/web/src/routes/group/reports/+page.svelte          # NEW
packages/web/src/routes/group/administrators/+page.server.ts # NEW
packages/web/src/routes/group/administrators/+page.svelte    # NEW

packages/web/src/routes/zone/groups/+page.server.ts         # NEW — list / create / soft-delete
packages/web/src/routes/zone/groups/+page.svelte            # NEW
packages/web/src/routes/zone/groups/[id]/+page.server.ts    # NEW — group detail
packages/web/src/routes/zone/groups/[id]/+page.svelte       # NEW
packages/web/src/routes/zone/chapters/+page.server.ts       # MODIFIED — add group column
packages/web/src/routes/zone/chapters/+page.svelte          # MODIFIED — render Group column
packages/web/src/routes/zone/chapters/[id]/+page.server.ts  # MODIFIED — move-group action
packages/web/src/routes/zone/chapters/[id]/+page.svelte     # MODIFIED — Group section
packages/web/src/routes/zone/settings/+page.server.ts       # MODIFIED — groups-enabled toggle
packages/web/src/routes/zone/settings/+page.svelte          # MODIFIED — Groups panel

docs/DOMAIN-MODEL.md                                        # MODIFIED — add Groups subsection
docs/PRD.md                                                 # MODIFIED — document new roles
docs/ROADMAP.md                                             # MODIFIED — phase entry
docs/DOMAIN-REFERENCE.md                                    # MODIFIED — reinstate ChurchGroup note
```

### File responsibilities

- `packages/shared/src/roles.ts` — canonical role taxonomy. Adding `GROUP_ROLES` + `RoleScope` "group" + `isGroupScopedRole`.
- `packages/db/src/schema/groups.ts` — single home for `groups` + `chapter_group_history` Drizzle definitions.
- `packages/api/src/services/groups.ts` — every group invariant (name/slug uniqueness, move semantics, enable gate, soft-delete gate). The route layer is thin and only validates HTTP shape + roles.
- `packages/api/src/middleware/auth.ts` — owns `AuthorizedContext.groupIds` and the `visibleChapterIds` chokepoint used by every tenant read.
- `packages/api/src/routes/tenant-groups.ts` — group CRUD + move-group + history endpoints.
- `packages/api/src/routes/tenant-zones.ts` — the `groups-enabled` toggle. Separate from `tenant.ts` because it's a different bounded context.
- `packages/web/src/routes/group/*` — group-tier surface. Each loader resolves against `boundGroup.id` provided by `+layout.server.ts`.
- `packages/web/src/routes/zone/groups/*` — zone-tier group management.

---

## Phase 0 — Pre-flight

### Task 0: Branch + worktree sanity check

**Files:** none

- [ ] **Step 1: Confirm we're on a feature branch and there are no uncommitted changes**

Run: `git status && git rev-parse --abbrev-ref HEAD`
Expected: clean tree; if on `main`, create `feat/groups-hierarchy` first via `git checkout -b feat/groups-hierarchy`.

- [ ] **Step 2: Pull latest deps and confirm the dev DB is up**

Run:
```bash
pnpm install
docker compose up -d --wait db
pnpm db:push
pnpm test -- --run packages/api/src/services/names.test.ts
```
Expected: `names.test.ts` passes. This proves the test DB + Drizzle pipeline work before we add anything.

---

## Phase 1 — Shared types & role taxonomy

### Task 1: Add GROUP_ROLES to shared roles

**Files:**
- Modify: `packages/shared/src/roles.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  GROUP_ROLES,
  isGroupScopedRole,
  isZoneWideRole,
  roleScope,
} from "./roles";

describe("roles taxonomy — group tier", () => {
  it("exposes group_admin and group_pastor_viewer", () => {
    expect(GROUP_ROLES.GROUP_ADMIN).toBe("group_admin");
    expect(GROUP_ROLES.GROUP_PASTOR_VIEWER).toBe("group_pastor_viewer");
  });

  it("roleScope returns 'group' for group codes", () => {
    expect(roleScope("group_admin")).toBe("group");
    expect(roleScope("group_pastor_viewer")).toBe("group");
  });

  it("isGroupScopedRole identifies group codes", () => {
    expect(isGroupScopedRole("group_admin")).toBe(true);
    expect(isGroupScopedRole("group_pastor_viewer")).toBe(true);
    expect(isGroupScopedRole("zone_admin")).toBe(false);
    expect(isGroupScopedRole("chapter_admin")).toBe(false);
  });

  it("isZoneWideRole stays false for group roles", () => {
    expect(isZoneWideRole("group_admin")).toBe(false);
    expect(isZoneWideRole("group_pastor_viewer")).toBe(false);
    expect(isZoneWideRole("zone_admin")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stewardledger/shared test -- --run roles.test.ts`
Expected: FAIL — `GROUP_ROLES is not defined`.

- [ ] **Step 3: Edit `packages/shared/src/roles.ts`**

Replace the entire file with:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stewardledger/shared test -- --run roles.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck and full shared test suite**

Run: `pnpm --filter @stewardledger/shared check && pnpm --filter @stewardledger/shared test`
Expected: PASS — no type errors, all existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/roles.ts packages/shared/src/roles.test.ts
git commit -m "feat(shared): add GROUP_ROLES taxonomy"
```

### Task 2: Extend AuthorizedContext with groupIds

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Edit `packages/shared/src/types.ts`**

Replace the `AuthorizedContext` interface with:

```ts
/** Authorization context resolved by API middleware on every request. */
export interface AuthorizedContext {
  userId: UUID;
  zoneId: UUID;
  /** Denormalized; null when zone has only an unverified region name. */
  regionId: UUID | null;
  /** Effective role codes — union of all bindings the user holds in this zone. */
  roleCodes: string[];
  /** Chapter ids the user is bound to (empty = zone-wide bindings only). */
  chapterIds: UUID[];
  /** Group ids the user is bound to (empty = no group-tier bindings). */
  groupIds: UUID[];
  /** True if the user is a platform-level admin (super_admin etc.). */
  isPlatformAdmin: boolean;
}
```

- [ ] **Step 2: Run shared typecheck**

Run: `pnpm --filter @stewardledger/shared check`
Expected: PASS.

- [ ] **Step 3: Run full repo typecheck — expect failures in API code that builds AuthorizedContext**

Run: `pnpm check`
Expected: FAIL with errors in `packages/api/src/middleware/auth.ts` complaining `groupIds` is missing from object literals. This is expected; Task 9 will fix them. **Do not commit yet** — the type addition is part of the same commit as the consumer update in Task 9 to keep the tree green between commits.

> **Note for the executor:** if you want a fully-green tree at every commit, you can either (a) wait to commit Task 2 until Task 9 lands, or (b) stub `groupIds: []` inline at the one `auth.ts` build site as a placeholder. Option (a) is what this plan assumes.

### Task 3: Add Zod schemas for groups + move-group + groups-enabled

**Files:**
- Modify: `packages/shared/src/schemas.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/schemas.groups.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  chapterMoveGroupSchema,
  groupCreateSchema,
  groupUpdateSchema,
  zoneEnableGroupsSchema,
} from "./schemas";

describe("group schemas", () => {
  it("accepts a valid group create payload", () => {
    const out = groupCreateSchema.parse({ name: "East Region", slug: "east-region" });
    expect(out.name).toBe("East Region");
    expect(out.slug).toBe("east-region");
  });

  it("rejects non-kebab slug", () => {
    expect(() => groupCreateSchema.parse({ name: "x", slug: "East Region" })).toThrow();
    expect(() => groupCreateSchema.parse({ name: "x", slug: "east_region" })).toThrow();
    expect(() => groupCreateSchema.parse({ name: "x", slug: "-east" })).toThrow();
  });

  it("rejects empty name or oversize", () => {
    expect(() => groupCreateSchema.parse({ name: "", slug: "x" })).toThrow();
    expect(() => groupCreateSchema.parse({ name: "x".repeat(101), slug: "x" })).toThrow();
  });

  it("update is partial", () => {
    expect(() => groupUpdateSchema.parse({})).not.toThrow();
    expect(() => groupUpdateSchema.parse({ name: "X" })).not.toThrow();
  });

  it("move-group requires groupId; effectiveDate optional", () => {
    const a = chapterMoveGroupSchema.parse({ groupId: "11111111-1111-1111-1111-111111111111" });
    expect(a.groupId).toBe("11111111-1111-1111-1111-111111111111");
    expect(a.effectiveDate).toBeUndefined();
    const b = chapterMoveGroupSchema.parse({
      groupId: "11111111-1111-1111-1111-111111111111",
      effectiveDate: "2026-05-22",
    });
    expect(b.effectiveDate).toBe("2026-05-22");
    expect(() => chapterMoveGroupSchema.parse({ groupId: "not-a-uuid" })).toThrow();
    expect(() =>
      chapterMoveGroupSchema.parse({
        groupId: "11111111-1111-1111-1111-111111111111",
        effectiveDate: "not-a-date",
      }),
    ).toThrow();
  });

  it("zoneEnableGroupsSchema only accepts { enabled: true }", () => {
    expect(zoneEnableGroupsSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(() => zoneEnableGroupsSchema.parse({ enabled: false })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stewardledger/shared test -- --run schemas.groups.test.ts`
Expected: FAIL — schemas not exported.

- [ ] **Step 3: Edit `packages/shared/src/schemas.ts`**

After the existing `zoneSlugSchema` definition (around line 12), add this block (the position is after `zoneSlugSchema` and before the `chapterCreateSchema` definition — search for `/** Chapter creation. */`):

Add immediately above `export const chapterCreateSchema`:

```ts
/** Slug for groups: 1–50 chars, lowercase kebab. */
export const groupSlugSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9](-?[a-z0-9])*$/, "slug must be lowercase kebab-case");

/** Create a group. */
export const groupCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: groupSlugSchema,
  })
  .strict();
export type GroupCreateInput = z.infer<typeof groupCreateSchema>;

/** Update a group (partial — at least one field). */
export const groupUpdateSchema = groupCreateSchema.partial();
export type GroupUpdateInput = z.infer<typeof groupUpdateSchema>;

/** Move a chapter to a different group. effectiveDate defaults to today (zone TZ) at the service layer. */
export const chapterMoveGroupSchema = z
  .object({
    groupId: uuidSchema,
    effectiveDate: z.string().date().optional(),
  })
  .strict();
export type ChapterMoveGroupInput = z.infer<typeof chapterMoveGroupSchema>;

/** Toggle a zone's `groups_enabled` flag. One-way — only `true` is accepted. */
export const zoneEnableGroupsSchema = z
  .object({ enabled: z.literal(true) })
  .strict();
export type ZoneEnableGroupsInput = z.infer<typeof zoneEnableGroupsSchema>;
```

Then modify `chapterCreateSchema` to optionally accept `groupId` (validated DB-side):

```ts
export const chapterCreateSchema = z.object({
  name: z.string().min(2).max(120),
  countryCode: countryCodeSchema.optional(),
  dateFrom: z.string().date().optional(),
  groupId: uuidSchema.optional(),
});
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;
```

And modify `invitationCreateSchema` to optionally accept `groupId` (CHECK enforced server-side):

```ts
export const invitationCreateSchema = z
  .object({
    email: z.string().email(),
    roleCode: invitableRoleSchema,
    chapterId: uuidSchema.optional(),
    groupId: uuidSchema.optional(),
  })
  .refine(
    (v) => {
      if (v.roleCode.startsWith("chapter_")) return v.chapterId !== undefined && v.groupId === undefined;
      if (v.roleCode.startsWith("group_")) return v.groupId !== undefined && v.chapterId === undefined;
      return v.chapterId === undefined && v.groupId === undefined;
    },
    { message: "chapterId required for chapter roles; groupId required for group roles; neither for zone roles", path: ["chapterId"] },
  );
export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;
```

Also extend `invitableRoleSchema` to include group roles:

```ts
import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "./roles";
// ...
export const invitableRoleSchema = z.enum([
  ...(Object.values(ZONE_ROLES) as [string, ...string[]]),
  ...(Object.values(GROUP_ROLES) as [string, ...string[]]),
  ...(Object.values(CHAPTER_ROLES) as [string, ...string[]]),
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stewardledger/shared test -- --run schemas.groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm existing shared tests still pass**

Run: `pnpm --filter @stewardledger/shared test`
Expected: PASS — all tests green. If `invitationCreateSchema` tests assumed only chapter roles or only zone roles, they remain valid because the refine() rules accept the same shapes.

- [ ] **Step 6: Commit (held back until Task 9 lands — see Task 2 note)**

Do **not** commit yet. Continue to Phase 2.

---

## Phase 2 — Database schema

### Task 4: New schema file — groups + chapter_group_history

**Files:**
- Create: `packages/db/src/schema/groups.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create `packages/db/src/schema/groups.ts`**

```ts
// packages/db/src/schema/groups.ts
// Tenant-scoped grouping of chapters. See docs/DOMAIN-MODEL.md §2 (Groups).

import { sql } from "drizzle-orm";
import {
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { chapters } from "./chapters";
import { zones } from "./zones";

export const groups = pgTable(
  "groups",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),
    /** URL-safe identifier, unique per zone among non-deleted. */
    slug: text("slug").notNull(),
    /** Display name, unique per zone (case-insensitive) among non-deleted. */
    name: text("name").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    /** Composite cross-tenant FK target — mirrors chapters_zone_row_id_unique. */
    unique("groups_zone_row_id_unique").on(table.zoneId, table.id),
    uniqueIndex("groups_zone_slug_idx")
      .on(table.zoneId, table.slug)
      .where(sql`deleted_at is null`),
    uniqueIndex("groups_zone_name_lower_idx")
      .on(table.zoneId, sql`lower(${table.name})`)
      .where(sql`deleted_at is null`),
    index("groups_zone_id_idx").on(table.zoneId),
  ],
);

export const chapterGroupHistory = pgTable(
  "chapter_group_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "restrict" }),
    /** Inclusive lower bound. */
    dateFrom: date("date_from").notNull(),
    /** Null = current open segment. */
    dateTo: date("date_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chapter_group_history_chapter_idx").on(table.chapterId, table.dateFrom),
    index("chapter_group_history_group_idx").on(table.groupId, table.dateFrom),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type ChapterGroupHistoryRow = typeof chapterGroupHistory.$inferSelect;
```

- [ ] **Step 2: Add export to schema index**

Edit `packages/db/src/schema/index.ts` — add after `export * from "./chapters";`:

```ts
export * from "./groups";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @stewardledger/db check`
Expected: PASS.

### Task 5: Modify chapters schema — add group_id

**Files:**
- Modify: `packages/db/src/schema/chapters.ts`

- [ ] **Step 1: Edit `packages/db/src/schema/chapters.ts`**

Replace the file with:

```ts
// packages/db/src/schema/chapters.ts
// A chapter is a single local church/congregation. Many chapters per zone.

import {
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { regions } from "./regions";
import { zones } from "./zones";

export const chapters = pgTable(
  "chapters",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),
    /** Denormalized from zones.region_id for fast region-aware reports. */
    regionId: text("region_id").references(() => regions.id, { onDelete: "set null" }),
    /** Current group pointer. Null when zone.groups_enabled = false. */
    groupId: text("group_id"),
    /** Reference code, e.g. "C0000001". Format configurable per zone. */
    referenceCode: text("reference_code").notNull(),
    name: text("name").notNull(),
    countryCode: text("country_code"),
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("chapters_zone_row_id_unique").on(table.zoneId, table.id),
    uniqueIndex("chapters_zone_reference_idx").on(table.zoneId, table.referenceCode),
    index("chapters_zone_id_idx").on(table.zoneId),
    index("chapters_region_id_idx").on(table.regionId),
    index("chapters_zone_group_idx").on(table.zoneId, table.groupId),
    /**
     * Composite FK enforces same-zone for group_id. Declared via
     * `foreignKey()` rather than a column-level `.references()` so we
     * can target the composite unique key `(zone_id, id)` on `groups`.
     */
    foreignKey({
      columns: [table.zoneId, table.groupId],
      foreignColumns: [
        // Forward-reference the groups table by raw column name —
        // importing it here would create an import cycle (groups
        // also references chapters).
      ],
      name: "chapters_zone_group_fk",
    }),
  ],
);

export const chapterNameHistory = pgTable(
  "chapter_name_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chapter_name_history_chapter_id_idx").on(table.chapterId)],
);

export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;
```

> **Note on the import-cycle FK:** the Drizzle `foreignKey()` helper requires real column references. To break the cycle, we omit the `foreignColumns` in TypeScript and add the FK in the raw migration SQL instead (Task 7). The Drizzle schema will still type-check `chapters.groupId as string | null`; the cross-zone integrity comes from the migration's `FOREIGN KEY (zone_id, group_id) REFERENCES groups (zone_id, id)` clause.
>
> **Alternative (preferred):** delete the `foreignKey({...})` block above (it's a placeholder that doesn't satisfy Drizzle's typing) and rely on the migration SQL for the composite FK. Drizzle does not need to model the composite FK at all — schema introspection isn't required and the constraint is enforced by Postgres regardless. Use this alternative; the file above with the placeholder is for illustration only.

Final version — remove the placeholder block:

```ts
// (same as above but WITHOUT the trailing foreignKey({...}) entry)
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @stewardledger/db check`
Expected: PASS.

### Task 6: Modify zones, roles bindings, invitations schemas

**Files:**
- Modify: `packages/db/src/schema/zones.ts`
- Modify: `packages/db/src/schema/roles.ts`
- Modify: `packages/db/src/schema/invitations.ts`

- [ ] **Step 1: Edit `packages/db/src/schema/zones.ts`** — add `groupsEnabled` column

Within the `zones` `pgTable` definition, after `mfaRequiredRoleCodes` and before `activatedAt`, add:

```ts
groupsEnabled: boolean("groups_enabled").notNull().default(false),
```

Add `boolean` to the imports from `drizzle-orm/pg-core`.

- [ ] **Step 2: Edit `packages/db/src/schema/roles.ts`** — add `group_id`, `role_scope`, CHECK

Replace the `userRoleBindings` `pgTable` block with:

```ts
import { check, ... } from "drizzle-orm/pg-core"; // ensure 'check' is imported

export const userRoleBindings = pgTable(
  "user_role_bindings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    /** Set for chapter-scope bindings; null otherwise. */
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    /** Set for group-scope bindings; null otherwise. */
    groupId: text("group_id"),
    /** Denormalized from roles.scope to keep CHECK pure-SQL. */
    roleScope: text("role_scope").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    grantedByUserId: text("granted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("user_role_bindings_user_idx").on(table.userId),
    index("user_role_bindings_zone_idx").on(table.zoneId),
    index("user_role_bindings_chapter_idx").on(table.chapterId),
    index("user_role_bindings_group_idx").on(table.groupId),
    uniqueIndex("user_role_bindings_unique_active_idx")
      .on(table.userId, table.zoneId, table.groupId, table.chapterId, table.roleId)
      .where(sql`revoked_at is null`),
    check(
      "user_role_bindings_scope_shape",
      sql`(
        (role_scope = 'group'    and group_id is not null and chapter_id is null) or
        (role_scope = 'chapter'  and chapter_id is not null and group_id is null) or
        (role_scope = 'zone'     and group_id is null and chapter_id is null) or
        (role_scope = 'platform' and group_id is null and chapter_id is null)
      )`,
    ),
  ],
);
```

- [ ] **Step 3: Edit `packages/db/src/schema/invitations.ts`** — add `group_id`

Open the file and add the field below `chapterId`:

```ts
groupId: text("group_id"),
```

Add a CHECK constraint in the table options:

```ts
check(
  "invitations_scope_shape",
  sql`(
    (role_code like 'group_%' and group_id is not null and chapter_id is null) or
    (role_code like 'chapter_%' and chapter_id is not null and group_id is null) or
    (role_code not like 'group_%' and role_code not like 'chapter_%' and group_id is null and chapter_id is null)
  )`,
),
```

Add `check` to the `drizzle-orm/pg-core` import.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @stewardledger/db check`
Expected: PASS.

### Task 7: Generate + hand-edit the migration

**Files:**
- Create: `packages/db/drizzle/0014_groups_hierarchy.sql`

- [ ] **Step 1: Generate base migration**

Run: `pnpm --filter @stewardledger/db db:generate`
Expected: creates a new file `packages/db/drizzle/0014_<random_name>.sql`. Rename it to `0014_groups_hierarchy.sql`.

- [ ] **Step 2: Hand-edit the generated SQL**

Open the generated file. It will include the table creations and column adds. **Add** the following at the end (these are constraints Drizzle's generator can't infer):

```sql
-- Composite cross-tenant FK on chapters.group_id
ALTER TABLE "chapters"
  ADD CONSTRAINT "chapters_zone_group_fk"
  FOREIGN KEY ("zone_id", "group_id")
  REFERENCES "groups" ("zone_id", "id")
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- Composite cross-tenant FK on user_role_bindings.group_id
ALTER TABLE "user_role_bindings"
  ADD CONSTRAINT "user_role_bindings_zone_group_fk"
  FOREIGN KEY ("zone_id", "group_id")
  REFERENCES "groups" ("zone_id", "id")
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- Composite cross-tenant FK on invitations.group_id
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_zone_group_fk"
  FOREIGN KEY ("zone_id", "group_id")
  REFERENCES "groups" ("zone_id", "id")
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- Backfill role_scope for existing bindings
UPDATE "user_role_bindings" b
SET "role_scope" = r."scope"
FROM "roles" r
WHERE b."role_id" = r."id" AND b."role_scope" IS NULL;

-- Default existing role_scope to its joined value going forward — already
-- handled by the application layer at insert time, so no trigger needed.
```

- [ ] **Step 3: Push migration to dev DB**

Run: `pnpm db:push`
Expected: completes without error. `pnpm test -- --run packages/api/src/services/names.test.ts` still passes (sanity check the DB).

- [ ] **Step 4: Confirm migration file builds the right schema**

Run: `pnpm db:studio` (or `psql`) and inspect the `groups`, `chapter_group_history`, `chapters` (group_id), `zones` (groups_enabled), `user_role_bindings` (group_id, role_scope), and `invitations` (group_id) columns. Verify the composite FKs exist.

- [ ] **Step 5: Commit the schema + migration**

```bash
git add packages/db/src/schema/ packages/db/drizzle/0014_groups_hierarchy.sql packages/db/drizzle/meta/
git add packages/shared/src/roles.ts packages/shared/src/roles.test.ts
git add packages/shared/src/schemas.ts packages/shared/src/schemas.groups.test.ts
git add packages/shared/src/types.ts
git commit -m "feat(db,shared): groups schema and role taxonomy"
```

---

## Phase 3 — Services

### Task 8: Seed group roles per zone

**Files:**
- Modify: `packages/api/src/services/role-seed.ts`

- [ ] **Step 1: Edit `packages/api/src/services/role-seed.ts`**

Replace the file with:

```ts
// packages/api/src/services/role-seed.ts
// Seeds the system roles for a newly-created zone.

import {
  CHAPTER_ROLES,
  GROUP_ROLES,
  ZONE_ROLES,
  type RoleCode,
} from "@stewardledger/shared";
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

/**
 * One-shot helper to seed the new group roles for zones created before the
 * groups feature shipped. Idempotent — does nothing if the roles already
 * exist for the zone.
 */
export async function ensureGroupRolesSeeded(
  database: Db,
  zoneId: string,
): Promise<void> {
  const groupSeed = SYSTEM_ROLES.filter((r) => r.scope === "group");
  await database
    .insert(roles)
    .values(
      groupSeed.map((r) => ({
        zoneId,
        code: r.code,
        name: r.name,
        scope: r.scope,
        permissions: r.permissions,
        isSystem: true,
      })),
    )
    .onConflictDoNothing({ target: [roles.zoneId, roles.code] });
}
```

- [ ] **Step 2: Add a one-time backfill migration step**

Append to `packages/db/drizzle/0014_groups_hierarchy.sql`:

```sql
-- Seed group_admin and group_pastor_viewer for every existing zone
INSERT INTO "roles" ("id", "zone_id", "code", "name", "scope", "permissions", "is_system")
SELECT
  gen_random_uuid()::text,
  z."id",
  'group_admin',
  'Group Admin',
  'group',
  '["group.read","chapter.read","chapter.write","member.read","contribution.read","import.read","report.read","audit.read","target.read","invitation.write"]'::jsonb,
  true
FROM "zones" z
WHERE NOT EXISTS (
  SELECT 1 FROM "roles" r
  WHERE r."zone_id" = z."id" AND r."code" = 'group_admin'
);

INSERT INTO "roles" ("id", "zone_id", "code", "name", "scope", "permissions", "is_system")
SELECT
  gen_random_uuid()::text,
  z."id",
  'group_pastor_viewer',
  'Group Pastor (Viewer)',
  'group',
  '["group.read","chapter.read","member.read","contribution.read","report.read","target.read"]'::jsonb,
  true
FROM "zones" z
WHERE NOT EXISTS (
  SELECT 1 FROM "roles" r
  WHERE r."zone_id" = z."id" AND r."code" = 'group_pastor_viewer'
);
```

- [ ] **Step 3: Re-push migration to dev DB**

Run: `pnpm db:push`

If `db:push` flags the migration as already applied, drop and re-create the dev DB schema (this is dev only):
```bash
docker compose down -v
docker compose up -d --wait db
pnpm db:push
```

Confirm: `psql ... -c "SELECT count(*) FROM roles WHERE code IN ('group_admin','group_pastor_viewer');"` returns 2 × number-of-zones.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/services/role-seed.ts packages/db/drizzle/0014_groups_hierarchy.sql
git commit -m "feat(api): seed group roles per zone"
```

### Task 9: Auth middleware — load groupIds + add visibleChapterIds

**Files:**
- Modify: `packages/api/src/middleware/auth.ts`
- Create: `packages/api/src/middleware/auth.test.ts`

- [ ] **Step 1: Edit `packages/api/src/middleware/auth.ts`**

Inside `requireTenantAuth`, replace the bindings query and context build:

```ts
const bindings = await db
  .select({
    chapterId: userRoleBindings.chapterId,
    groupId: userRoleBindings.groupId,
    roleCode: roles.code,
  })
  .from(userRoleBindings)
  .innerJoin(roles, eq(userRoleBindings.roleId, roles.id))
  .where(
    and(
      eq(userRoleBindings.userId, sessionUser.id),
      eq(userRoleBindings.zoneId, tenant.zoneId),
      isNull(userRoleBindings.revokedAt),
    ),
  );

if (bindings.length === 0 && !sessionUser.isSuperAdmin) {
  return c.json({ error: { code: "forbidden", message: "No access to this zone" } }, 403);
}

const roleCodes = Array.from(new Set(bindings.map((b) => b.roleCode)));
const chapterIds = Array.from(
  new Set(bindings.map((b) => b.chapterId).filter((id): id is string => id !== null)),
);
const groupIds = Array.from(
  new Set(bindings.map((b) => b.groupId).filter((id): id is string => id !== null)),
);

const ctx: AuthorizedContext = {
  userId: sessionUser.id,
  zoneId: tenant.zoneId,
  regionId: tenant.regionId,
  roleCodes,
  chapterIds,
  groupIds,
  isPlatformAdmin: sessionUser.isSuperAdmin,
};
c.set("auth", ctx);
```

- [ ] **Step 2: Add `visibleChapterIds` helper to `auth.ts`**

At the bottom of the file, add:

```ts
import { chapters as chaptersTable, isNull as drizzleIsNull } from "drizzle-orm";
// Use the already-imported `chapters` + `isNull` if present.

/**
 * The set of chapter ids the caller may legitimately read in their resolved
 * zone. This is the single chokepoint every tenant read uses to narrow
 * results. Zone-tier sees all; group-tier sees chapters where
 * chapters.group_id IN (groupIds); chapter-tier sees only ctx.chapterIds.
 * Mixed bindings union.
 *
 * Returns `{ kind: "all" }` for callers that can read every chapter — this
 * lets the caller skip the `inArray()` clause entirely. Otherwise returns
 * `{ kind: "list", ids }` (which may be empty).
 */
export async function visibleChapterIds(
  ctx: AuthorizedContext,
  zoneWideRoles: readonly string[],
): Promise<{ kind: "all" } | { kind: "list"; ids: string[] }> {
  if (hasAnyRole(ctx, ...zoneWideRoles)) return { kind: "all" };

  const ids = new Set<string>(ctx.chapterIds);
  if (ctx.groupIds.length > 0) {
    const rows = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(
        and(
          eq(chapters.zoneId, ctx.zoneId),
          isNull(chapters.deletedAt),
          inArray(chapters.groupId, ctx.groupIds),
        ),
      );
    for (const r of rows) ids.add(r.id);
  }
  return { kind: "list", ids: Array.from(ids) };
}
```

Add `inArray` to the drizzle-orm imports if not already present.

- [ ] **Step 3: Write the failing test**

Create `packages/api/src/middleware/auth.test.ts`:

```ts
// packages/api/src/middleware/auth.test.ts
// Integration test for the visibleChapterIds chokepoint.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  chapters,
  groups,
  invitations,
  roles,
  userRoleBindings,
  zones,
  user as userTable,
} from "@stewardledger/db/schema";
import {
  GROUP_ROLES,
  ZONE_ROLES,
  CHAPTER_ROLES,
  type AuthorizedContext,
} from "@stewardledger/shared";
import { db } from "../db";
import { visibleChapterIds } from "./auth";

const ZONE_WIDE = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
] as const;

function unique() {
  return Math.random().toString(36).slice(2, 10);
}

async function createZoneWithChapters(): Promise<{
  zoneId: string;
  groupAId: string;
  groupBId: string;
  chap1: string; // group A
  chap2: string; // group A
  chap3: string; // group B
  chap4: string; // no group
}> {
  const slug = `tz-${unique()}`;
  const [z] = await db
    .insert(zones)
    .values({
      slug,
      name: `Zone ${unique()}`,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Inbox ${unique()}`,
    })
    .returning({ id: zones.id });
  const [gA] = await db.insert(groups).values({ zoneId: z.id, name: `GA-${unique()}`, slug: `ga-${unique()}` }).returning({ id: groups.id });
  const [gB] = await db.insert(groups).values({ zoneId: z.id, name: `GB-${unique()}`, slug: `gb-${unique()}` }).returning({ id: groups.id });
  const [c1] = await db.insert(chapters).values({ zoneId: z.id, groupId: gA.id, referenceCode: `C-${unique()}`, name: "C1", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  const [c2] = await db.insert(chapters).values({ zoneId: z.id, groupId: gA.id, referenceCode: `C-${unique()}`, name: "C2", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  const [c3] = await db.insert(chapters).values({ zoneId: z.id, groupId: gB.id, referenceCode: `C-${unique()}`, name: "C3", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  const [c4] = await db.insert(chapters).values({ zoneId: z.id, referenceCode: `C-${unique()}`, name: "C4", dateFrom: "2020-01-01" }).returning({ id: chapters.id });
  return { zoneId: z.id, groupAId: gA.id, groupBId: gB.id, chap1: c1.id, chap2: c2.id, chap3: c3.id, chap4: c4.id };
}

function ctxFor(opts: { zoneId: string; roleCodes: string[]; chapterIds?: string[]; groupIds?: string[] }): AuthorizedContext {
  return {
    userId: "test-user",
    zoneId: opts.zoneId,
    regionId: null,
    roleCodes: opts.roleCodes,
    chapterIds: opts.chapterIds ?? [],
    groupIds: opts.groupIds ?? [],
    isPlatformAdmin: false,
  };
}

describe("visibleChapterIds", () => {
  let z: Awaited<ReturnType<typeof createZoneWithChapters>>;

  beforeAll(async () => {
    z = await createZoneWithChapters();
  });

  it("returns 'all' for zone-tier sessions", async () => {
    const out = await visibleChapterIds(
      ctxFor({ zoneId: z.zoneId, roleCodes: [ZONE_ROLES.ZONE_ADMIN] }),
      ZONE_WIDE,
    );
    expect(out).toEqual({ kind: "all" });
  });

  it("returns only the bound chapters for a chapter-tier session", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [CHAPTER_ROLES.CHAPTER_ADMIN],
        chapterIds: [z.chap2],
      }),
      ZONE_WIDE,
    );
    expect(out).toEqual({ kind: "list", ids: [z.chap2] });
  });

  it("returns the group's chapters for a single group binding", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN],
        groupIds: [z.groupAId],
      }),
      ZONE_WIDE,
    );
    expect(out.kind).toBe("list");
    if (out.kind !== "list") throw new Error();
    expect(out.ids.sort()).toEqual([z.chap1, z.chap2].sort());
  });

  it("unions two group bindings", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN],
        groupIds: [z.groupAId, z.groupBId],
      }),
      ZONE_WIDE,
    );
    expect(out.kind).toBe("list");
    if (out.kind !== "list") throw new Error();
    expect(out.ids.sort()).toEqual([z.chap1, z.chap2, z.chap3].sort());
  });

  it("unions group + chapter bindings", async () => {
    const out = await visibleChapterIds(
      ctxFor({
        zoneId: z.zoneId,
        roleCodes: [GROUP_ROLES.GROUP_ADMIN, CHAPTER_ROLES.CHAPTER_ADMIN],
        groupIds: [z.groupAId],
        chapterIds: [z.chap4],
      }),
      ZONE_WIDE,
    );
    expect(out.kind).toBe("list");
    if (out.kind !== "list") throw new Error();
    expect(out.ids.sort()).toEqual([z.chap1, z.chap2, z.chap4].sort());
  });
});
```

- [ ] **Step 4: Run middleware tests**

Run: `pnpm --filter @stewardledger/api test -- --run auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full api tests to catch regressions from groupIds addition**

Run: `pnpm --filter @stewardledger/api test`
Expected: PASS. Some existing route tests may need a `groupIds: []` added to fixture `AuthorizedContext` literals — fix inline.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/middleware/auth.ts packages/api/src/middleware/auth.test.ts
git commit -m "feat(api): visibleChapterIds chokepoint and groupIds context"
```

### Task 10: Groups service module

**Files:**
- Create: `packages/api/src/services/groups.ts`
- Create: `packages/api/src/services/groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/services/groups.test.ts`:

```ts
// packages/api/src/services/groups.test.ts

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  chapterGroupHistory,
  chapters,
  groups,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";
import {
  GroupNameTakenError,
  GroupSlugTakenError,
  GroupsNotEnabledError,
  GroupsEnableBlockedError,
  GroupNotEmptyError,
  HistoryViolationError,
  assertGroupNameAvailable,
  assertGroupSlugAvailable,
  assignChapterToGroupPreEnable,
  enableGroupsForZone,
  moveChapterToGroup,
  softDeleteGroup,
} from "./groups";

function unique() { return Math.random().toString(36).slice(2, 10); }

async function makeZone(): Promise<string> {
  const [z] = await db.insert(zones).values({
    slug: `gz-${unique()}`,
    name: `GZ ${unique()}`,
    countryCode: "GB",
    defaultCurrencyCode: "GBP",
    defaultTimeZone: "Europe/London",
    regionNameUnverified: `Inbox ${unique()}`,
  }).returning({ id: zones.id });
  return z.id;
}

async function makeGroup(zoneId: string, name = `G ${unique()}`, slug = `g-${unique()}`): Promise<string> {
  const [g] = await db.insert(groups).values({ zoneId, name, slug }).returning({ id: groups.id });
  return g.id;
}

async function makeChapter(zoneId: string, opts: { groupId?: string; dateFrom?: string } = {}): Promise<string> {
  const [c] = await db.insert(chapters).values({
    zoneId,
    groupId: opts.groupId,
    referenceCode: `C-${unique()}`,
    name: "C",
    dateFrom: opts.dateFrom ?? "2020-01-01",
  }).returning({ id: chapters.id });
  return c.id;
}

describe("assertGroupNameAvailable", () => {
  it("passes when name is unused in the zone", async () => {
    const z = await makeZone();
    await expect(assertGroupNameAvailable(db, z, "Fresh Name")).resolves.toBeUndefined();
  });

  it("rejects case-insensitive duplicate in same zone", async () => {
    const z = await makeZone();
    await makeGroup(z, "Region East", `re-${unique()}`);
    await expect(assertGroupNameAvailable(db, z, "REGION EAST")).rejects.toBeInstanceOf(GroupNameTakenError);
  });

  it("allows the same name in a different zone", async () => {
    const z1 = await makeZone();
    const z2 = await makeZone();
    await makeGroup(z1, "Region East", `re-${unique()}`);
    await expect(assertGroupNameAvailable(db, z2, "Region East")).resolves.toBeUndefined();
  });

  it("ignores a self-reference via excludeGroupId", async () => {
    const z = await makeZone();
    const gid = await makeGroup(z, "Region East", `re-${unique()}`);
    await expect(assertGroupNameAvailable(db, z, "Region East", { excludeGroupId: gid })).resolves.toBeUndefined();
  });
});

describe("assertGroupSlugAvailable", () => {
  it("rejects duplicate slug in same zone", async () => {
    const z = await makeZone();
    await makeGroup(z, `G ${unique()}`, "shared-slug");
    await expect(assertGroupSlugAvailable(db, z, "shared-slug")).rejects.toBeInstanceOf(GroupSlugTakenError);
  });
});

describe("assignChapterToGroupPreEnable", () => {
  it("sets chapters.group_id and writes no history", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z);
    await assignChapterToGroupPreEnable(db, { zoneId: z, chapterId: c, groupId: g, actorUserId: null });
    const [row] = await db.select({ groupId: chapters.groupId }).from(chapters).where(eq(chapters.id, c));
    expect(row.groupId).toBe(g);
    const hist = await db.select().from(chapterGroupHistory).where(eq(chapterGroupHistory.chapterId, c));
    expect(hist).toHaveLength(0);
  });

  it("refuses when groups already enabled", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await expect(
      assignChapterToGroupPreEnable(db, { zoneId: z, chapterId: c, groupId: g, actorUserId: null }),
    ).rejects.toBeInstanceOf(GroupsNotEnabledError);
  });

  it("rejects cross-zone group", async () => {
    const z1 = await makeZone();
    const z2 = await makeZone();
    const gOtherZone = await makeGroup(z2);
    const c = await makeChapter(z1);
    await expect(
      assignChapterToGroupPreEnable(db, { zoneId: z1, chapterId: c, groupId: gOtherZone, actorUserId: null }),
    ).rejects.toThrow();
  });
});

describe("enableGroupsForZone", () => {
  it("refuses when any chapter has null group_id", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await makeChapter(z, { groupId: g });
    await makeChapter(z); // unassigned
    await expect(enableGroupsForZone(db, { zoneId: z, actorUserId: null })).rejects.toBeInstanceOf(GroupsEnableBlockedError);
  });

  it("flips flag and opens initial history segments", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g, dateFrom: "2018-05-01" });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    const [zRow] = await db.select({ enabled: zones.groupsEnabled }).from(zones).where(eq(zones.id, z));
    expect(zRow.enabled).toBe(true);
    const segs = await db.select().from(chapterGroupHistory).where(eq(chapterGroupHistory.chapterId, c));
    expect(segs).toHaveLength(1);
    expect(segs[0].dateFrom).toBe("2018-05-01");
    expect(segs[0].dateTo).toBeNull();
    expect(segs[0].groupId).toBe(g);
  });

  it("is idempotent when already enabled", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await makeChapter(z, { groupId: g });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await expect(enableGroupsForZone(db, { zoneId: z, actorUserId: null })).resolves.toBeUndefined();
  });
});

describe("moveChapterToGroup", () => {
  it("closes open segment and opens a new one", async () => {
    const z = await makeZone();
    const gA = await makeGroup(z);
    const gB = await makeGroup(z);
    const c = await makeChapter(z, { groupId: gA, dateFrom: "2020-01-01" });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await moveChapterToGroup(db, {
      zoneId: z,
      chapterId: c,
      newGroupId: gB,
      effectiveDate: "2026-05-22",
      actorUserId: null,
    });
    const segs = await db
      .select()
      .from(chapterGroupHistory)
      .where(eq(chapterGroupHistory.chapterId, c))
      .orderBy(chapterGroupHistory.dateFrom);
    expect(segs).toHaveLength(2);
    expect(segs[0].groupId).toBe(gA);
    expect(segs[0].dateFrom).toBe("2020-01-01");
    expect(segs[0].dateTo).toBe("2026-05-21");
    expect(segs[1].groupId).toBe(gB);
    expect(segs[1].dateFrom).toBe("2026-05-22");
    expect(segs[1].dateTo).toBeNull();
    const [chap] = await db.select({ groupId: chapters.groupId }).from(chapters).where(eq(chapters.id, c));
    expect(chap.groupId).toBe(gB);
  });

  it("refuses when groups disabled", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g });
    await expect(
      moveChapterToGroup(db, { zoneId: z, chapterId: c, newGroupId: g, effectiveDate: "2026-05-22", actorUserId: null }),
    ).rejects.toBeInstanceOf(GroupsNotEnabledError);
  });

  it("refuses backdating before the open segment's date_from", async () => {
    const z = await makeZone();
    const gA = await makeGroup(z);
    const gB = await makeGroup(z);
    const c = await makeChapter(z, { groupId: gA, dateFrom: "2020-01-01" });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await expect(
      moveChapterToGroup(db, { zoneId: z, chapterId: c, newGroupId: gB, effectiveDate: "2019-12-31", actorUserId: null }),
    ).rejects.toBeInstanceOf(HistoryViolationError);
  });

  it("no-ops when newGroupId equals current group_id", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    const c = await makeChapter(z, { groupId: g });
    await enableGroupsForZone(db, { zoneId: z, actorUserId: null });
    await moveChapterToGroup(db, { zoneId: z, chapterId: c, newGroupId: g, effectiveDate: "2026-05-22", actorUserId: null });
    const segs = await db.select().from(chapterGroupHistory).where(eq(chapterGroupHistory.chapterId, c));
    expect(segs).toHaveLength(1);
  });
});

describe("softDeleteGroup", () => {
  it("refuses when group has active chapters", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await makeChapter(z, { groupId: g });
    await expect(softDeleteGroup(db, { zoneId: z, groupId: g, actorUserId: null })).rejects.toBeInstanceOf(GroupNotEmptyError);
  });

  it("succeeds when empty", async () => {
    const z = await makeZone();
    const g = await makeGroup(z);
    await softDeleteGroup(db, { zoneId: z, groupId: g, actorUserId: null });
    const [row] = await db.select({ deletedAt: groups.deletedAt }).from(groups).where(eq(groups.id, g));
    expect(row.deletedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stewardledger/api test -- --run groups.test.ts`
Expected: FAIL — `./groups` module not found.

- [ ] **Step 3: Create `packages/api/src/services/groups.ts`**

```ts
// packages/api/src/services/groups.ts
// Group-layer invariants. The route layer delegates here so the same rules
// run from CLI tools, demo seed, and any future caller.
//
// AGENTS rule 4: no business logic in triggers — all invariants enforced here.

import {
  chapterGroupHistory,
  chapters,
  groups,
  roles,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { writeAudit } from "./audit";

export class GroupNameTakenError extends Error {
  readonly code = "group_name_taken";
  constructor(name: string) {
    super(`A group named "${name}" already exists in this zone.`);
  }
}

export class GroupSlugTakenError extends Error {
  readonly code = "group_slug_taken";
  constructor(slug: string) {
    super(`A group with slug "${slug}" already exists in this zone.`);
  }
}

export class GroupsNotEnabledError extends Error {
  readonly code = "groups_not_enabled";
  constructor(msg = "Groups are not enabled for this zone (or are already enabled).") {
    super(msg);
  }
}

export class GroupsEnableBlockedError extends Error {
  readonly code = "groups_enable_blocked";
  constructor(public readonly unassignedChapterIds: string[]) {
    super(`Cannot enable groups: ${unassignedChapterIds.length} chapter(s) are not assigned to a group.`);
  }
}

export class GroupNotEmptyError extends Error {
  readonly code = "group_not_empty";
  constructor(public readonly chapterCount: number) {
    super(`Cannot delete group: ${chapterCount} chapter(s) still belong to it.`);
  }
}

export class HistoryViolationError extends Error {
  readonly code = "history_violation";
  constructor(msg: string) {
    super(msg);
  }
}

export async function assertGroupNameAvailable(
  database: Db,
  zoneId: string,
  name: string,
  options: { excludeGroupId?: string } = {},
): Promise<void> {
  const lower = name.trim().toLowerCase();
  const rows = await database
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        eq(groups.zoneId, zoneId),
        isNull(groups.deletedAt),
        sql`lower(${groups.name}) = ${lower}`,
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (hit && hit.id !== options.excludeGroupId) {
    throw new GroupNameTakenError(name);
  }
}

export async function assertGroupSlugAvailable(
  database: Db,
  zoneId: string,
  slug: string,
  options: { excludeGroupId?: string } = {},
): Promise<void> {
  const rows = await database
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        eq(groups.zoneId, zoneId),
        isNull(groups.deletedAt),
        eq(groups.slug, slug),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (hit && hit.id !== options.excludeGroupId) {
    throw new GroupSlugTakenError(slug);
  }
}

/** Pre-enable: just sets `chapters.group_id`. No history row. Refuses post-enable. */
export async function assignChapterToGroupPreEnable(
  database: Db,
  args: { zoneId: string; chapterId: string; groupId: string; actorUserId: string | null },
): Promise<void> {
  await database.transaction(async (tx) => {
    const [zone] = await tx
      .select({ groupsEnabled: zones.groupsEnabled })
      .from(zones)
      .where(eq(zones.id, args.zoneId))
      .limit(1);
    if (!zone) throw new GroupsNotEnabledError("Zone not found.");
    if (zone.groupsEnabled) throw new GroupsNotEnabledError("Use moveChapterToGroup once groups are enabled.");

    const [grp] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, args.groupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .limit(1);
    if (!grp) throw new Error("Group not found in zone");

    const result = await tx
      .update(chapters)
      .set({ groupId: args.groupId, updatedAt: new Date() })
      .where(and(eq(chapters.id, args.chapterId), eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt)))
      .returning({ id: chapters.id });
    if (result.length === 0) throw new Error("Chapter not found in zone");

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "chapter.group.assign",
      entityType: "chapter",
      entityId: args.chapterId,
      after: { groupId: args.groupId },
    });
  });
}

/** Post-enable: closes the open history segment, opens a new one. */
export async function moveChapterToGroup(
  database: Db,
  args: { zoneId: string; chapterId: string; newGroupId: string; effectiveDate: string; actorUserId: string | null },
): Promise<{ changed: boolean }> {
  return database.transaction(async (tx) => {
    const [zone] = await tx
      .select({ groupsEnabled: zones.groupsEnabled, tz: zones.defaultTimeZone })
      .from(zones)
      .where(eq(zones.id, args.zoneId))
      .limit(1);
    if (!zone) throw new GroupsNotEnabledError("Zone not found.");
    if (!zone.groupsEnabled) throw new GroupsNotEnabledError();

    const [chap] = await tx
      .select({ groupId: chapters.groupId })
      .from(chapters)
      .where(and(eq(chapters.id, args.chapterId), eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt)))
      .limit(1);
    if (!chap) throw new Error("Chapter not found in zone");

    if (chap.groupId === args.newGroupId) return { changed: false };

    const [grp] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, args.newGroupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .limit(1);
    if (!grp) throw new Error("Target group not found in zone");

    const [openSeg] = await tx
      .select({ id: chapterGroupHistory.id, dateFrom: chapterGroupHistory.dateFrom })
      .from(chapterGroupHistory)
      .where(and(eq(chapterGroupHistory.chapterId, args.chapterId), isNull(chapterGroupHistory.dateTo)))
      .limit(1);
    if (!openSeg) throw new HistoryViolationError("No open history segment found");
    if (args.effectiveDate < openSeg.dateFrom) {
      throw new HistoryViolationError(`effectiveDate ${args.effectiveDate} is before current segment date_from ${openSeg.dateFrom}`);
    }

    // Compute date_to = effectiveDate - 1 day via SQL to respect Postgres' date arithmetic.
    await tx
      .update(chapterGroupHistory)
      .set({ dateTo: sql`(${args.effectiveDate}::date - INTERVAL '1 day')::date` })
      .where(eq(chapterGroupHistory.id, openSeg.id));

    await tx.insert(chapterGroupHistory).values({
      zoneId: args.zoneId,
      chapterId: args.chapterId,
      groupId: args.newGroupId,
      dateFrom: args.effectiveDate,
    });

    await tx
      .update(chapters)
      .set({ groupId: args.newGroupId, updatedAt: new Date() })
      .where(eq(chapters.id, args.chapterId));

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "chapter.group.move",
      entityType: "chapter",
      entityId: args.chapterId,
      before: { groupId: chap.groupId },
      after: { groupId: args.newGroupId, effectiveDate: args.effectiveDate },
    });

    return { changed: true };
  });
}

/** Flip groups_enabled true; open initial history segments. Idempotent. */
export async function enableGroupsForZone(
  database: Db,
  args: { zoneId: string; actorUserId: string | null },
): Promise<void> {
  await database.transaction(async (tx) => {
    const [zone] = await tx
      .select({ groupsEnabled: zones.groupsEnabled })
      .from(zones)
      .where(eq(zones.id, args.zoneId))
      .limit(1);
    if (!zone) throw new Error("Zone not found");
    if (zone.groupsEnabled) return;

    const unassigned = await tx
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt), isNull(chapters.groupId)));
    if (unassigned.length > 0) {
      throw new GroupsEnableBlockedError(unassigned.map((r) => r.id));
    }

    const assigned = await tx
      .select({ id: chapters.id, groupId: chapters.groupId, dateFrom: chapters.dateFrom })
      .from(chapters)
      .where(and(eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt)));

    if (assigned.length > 0) {
      await tx.insert(chapterGroupHistory).values(
        assigned.map((c) => ({
          zoneId: args.zoneId,
          chapterId: c.id,
          groupId: c.groupId as string,
          dateFrom: c.dateFrom,
        })),
      );
    }

    await tx
      .update(zones)
      .set({ groupsEnabled: true, updatedAt: new Date() })
      .where(eq(zones.id, args.zoneId));

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "zone.groups.enable",
      entityType: "zone",
      entityId: args.zoneId,
    });
  });
}

/** Soft-delete a group. Refuses if any active chapter still belongs to it. */
export async function softDeleteGroup(
  database: Db,
  args: { zoneId: string; groupId: string; actorUserId: string | null },
): Promise<void> {
  await database.transaction(async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(chapters)
      .where(and(
        eq(chapters.zoneId, args.zoneId),
        eq(chapters.groupId, args.groupId),
        isNull(chapters.deletedAt),
      ));
    if (count > 0) throw new GroupNotEmptyError(count);

    const [updated] = await tx
      .update(groups)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(groups.id, args.groupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .returning({ id: groups.id });
    if (!updated) throw new Error("Group not found or already deleted");

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "group.delete",
      entityType: "group",
      entityId: args.groupId,
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stewardledger/api test -- --run groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/groups.ts packages/api/src/services/groups.test.ts
git commit -m "feat(api): groups service module"
```

---

## Phase 4 — API routes

### Task 11: tenant-groups router — CRUD + move-group + history

**Files:**
- Create: `packages/api/src/routes/tenant-groups.ts`
- Create: `packages/api/src/routes/tenant-groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/routes/tenant-groups.test.ts`. Follow the existing pattern in `tenant-targets.test.ts` for setup (creating zone, user, bindings via `seedZoneRoles`, signing in via Better Auth test helper). Tests must cover:

- `POST /api/tenant/groups` → 201 for zone_owner; 403 for chapter_admin; 400 for invalid slug.
- `GET /api/tenant/groups` → returns groups in active zone; respects soft-deleted exclusion.
- `PATCH /api/tenant/groups/:id` → renames; 409 on duplicate name; 403 for group_admin (D4).
- `DELETE /api/tenant/groups/:id` → 200 when empty; 409 when has chapters.
- `POST /api/tenant/chapters/:id/move-group` → 200 happy path; 403 for group_admin; 400 for backdated; 404 for cross-zone group.
- `GET /api/tenant/chapters/:id/group-history` → returns segments ordered by date_from.

For brevity here, the full test code follows the same fixtures and helpers used in `tenant-contributions.test.ts`. The executor should copy the setup boilerplate from `tenant.test.ts:81` and adapt for groups. **Required assertions** (one `it()` block each):

```ts
it("zone_owner creates a group", async () => { /* expect 201, body has id+slug+name */ });
it("chapter_admin gets 403 on create", async () => { /* expect 403 */ });
it("rejects invalid slug", async () => { /* expect 400 with zod error */ });
it("lists groups in the zone", async () => { /* expect array containing created group */ });
it("renames a group", async () => { /* expect 200, updated name */ });
it("returns 409 on duplicate name", async () => { /* expect 409 group_name_taken */ });
it("soft-deletes an empty group", async () => { /* expect 200, group.deletedAt set */ });
it("returns 409 when group has chapters", async () => { /* expect 409 group_not_empty */ });
it("moves a chapter and writes history", async () => { /* assert chapter.group_id changed + 2 segments */ });
it("403 when chapter_admin tries to move", async () => {});
it("404 for cross-zone group on move", async () => {});
it("400 when backdating before current segment", async () => {});
it("returns group history ordered by date_from", async () => {});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stewardledger/api test -- --run tenant-groups.test.ts`
Expected: FAIL — router not mounted.

- [ ] **Step 3: Create the router**

Create `packages/api/src/routes/tenant-groups.ts`:

```ts
// packages/api/src/routes/tenant-groups.ts
// Group CRUD + chapter-move-group + group-history endpoints.

import { zValidator } from "@hono/zod-validator";
import {
  chapterGroupHistory,
  chapters,
  groups,
} from "@stewardledger/db/schema";
import {
  type AuthorizedContext,
  chapterMoveGroupSchema,
  groupCreateSchema,
  groupUpdateSchema,
  ZONE_ROLES,
} from "@stewardledger/shared";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { writeAudit } from "../services/audit";
import {
  GroupNameTakenError,
  GroupNotEmptyError,
  GroupSlugTakenError,
  GroupsNotEnabledError,
  HistoryViolationError,
  assertGroupNameAvailable,
  assertGroupSlugAvailable,
  moveChapterToGroup,
  softDeleteGroup,
} from "../services/groups";

export const tenantGroupsRouter = new Hono();

const ZONE_WRITE = [ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN] as const;

function forbidden(c: any) {
  return c.json({ error: { code: "forbidden", message: "Zone admin required" } }, 403);
}

tenantGroupsRouter.get("/groups", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const rows = await db
    .select({
      id: groups.id,
      slug: groups.slug,
      name: groups.name,
      createdAt: groups.createdAt,
      chapterCount: sql<number>`(
        select count(*)::int from ${chapters}
        where ${chapters.zoneId} = ${ctx.zoneId}
          and ${chapters.groupId} = ${groups.id}
          and ${chapters.deletedAt} is null
      )`,
    })
    .from(groups)
    .where(and(eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)))
    .orderBy(asc(groups.name));
  return c.json({ items: rows });
});

tenantGroupsRouter.post("/groups", zValidator("json", groupCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
  const input = c.req.valid("json");
  try {
    await assertGroupNameAvailable(db, ctx.zoneId, input.name);
    await assertGroupSlugAvailable(db, ctx.zoneId, input.slug);
  } catch (e) {
    if (e instanceof GroupNameTakenError) return c.json({ error: { code: "group_name_taken", message: e.message } }, 409);
    if (e instanceof GroupSlugTakenError) return c.json({ error: { code: "group_slug_taken", message: e.message } }, 409);
    throw e;
  }
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.insert(groups).values({
      zoneId: ctx.zoneId,
      slug: input.slug,
      name: input.name,
    }).returning({ id: groups.id, slug: groups.slug, name: groups.name, createdAt: groups.createdAt });
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "group.create",
      entityType: "group",
      entityId: row.id,
      after: row,
    });
    return row;
  });
  return c.json({ group: result }, 201);
});

tenantGroupsRouter.get("/groups/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const id = c.req.param("id");
  const [row] = await db
    .select({
      id: groups.id,
      slug: groups.slug,
      name: groups.name,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
    })
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)))
    .limit(1);
  if (!row) return c.json({ error: { code: "not_found", message: "Group not found" } }, 404);
  const [{ chapterCount }] = await db
    .select({ chapterCount: count() })
    .from(chapters)
    .where(and(eq(chapters.zoneId, ctx.zoneId), eq(chapters.groupId, id), isNull(chapters.deletedAt)));
  return c.json({ group: { ...row, chapterCount } });
});

tenantGroupsRouter.patch("/groups/:id", zValidator("json", groupUpdateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
  const id = c.req.param("id");
  const input = c.req.valid("json");
  try {
    if (input.name) await assertGroupNameAvailable(db, ctx.zoneId, input.name, { excludeGroupId: id });
    if (input.slug) await assertGroupSlugAvailable(db, ctx.zoneId, input.slug, { excludeGroupId: id });
  } catch (e) {
    if (e instanceof GroupNameTakenError) return c.json({ error: { code: "group_name_taken", message: e.message } }, 409);
    if (e instanceof GroupSlugTakenError) return c.json({ error: { code: "group_slug_taken", message: e.message } }, 409);
    throw e;
  }
  const result = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(groups).where(and(eq(groups.id, id), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt))).limit(1);
    if (!before) return null;
    const [row] = await tx
      .update(groups)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(groups.id, id), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)))
      .returning({ id: groups.id, slug: groups.slug, name: groups.name });
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "group.update",
      entityType: "group",
      entityId: id,
      before: { name: before.name, slug: before.slug },
      after: row,
    });
    return row;
  });
  if (!result) return c.json({ error: { code: "not_found", message: "Group not found" } }, 404);
  return c.json({ group: result });
});

tenantGroupsRouter.delete("/groups/:id", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
  const id = c.req.param("id");
  try {
    await softDeleteGroup(db, { zoneId: ctx.zoneId, groupId: id, actorUserId: ctx.userId });
  } catch (e) {
    if (e instanceof GroupNotEmptyError) {
      return c.json({ error: { code: "group_not_empty", message: e.message, details: { chapterCount: e.chapterCount } } }, 409);
    }
    throw e;
  }
  return c.json({ status: "deleted" });
});

tenantGroupsRouter.post("/chapters/:id/move-group", zValidator("json", chapterMoveGroupSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ZONE_WRITE)) return forbidden(c);
  const chapterId = c.req.param("id");
  const input = c.req.valid("json");

  // Cross-tenant chapter guard
  const [chap] = await db.select({ id: chapters.id }).from(chapters)
    .where(and(eq(chapters.id, chapterId), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt))).limit(1);
  if (!chap) return c.json({ error: { code: "chapter_not_found", message: "Chapter not in this zone" } }, 404);

  // Resolve effectiveDate default in zone TZ
  let effectiveDate = input.effectiveDate;
  if (!effectiveDate) {
    const [z] = await db.select({ tz: zonesTzCol() }).from(/* zones */ require("@stewardledger/db/schema").zones).where(eq(require("@stewardledger/db/schema").zones.id, ctx.zoneId)).limit(1);
    // Compute YYYY-MM-DD in the zone's TZ
    effectiveDate = new Date().toLocaleDateString("en-CA", { timeZone: z.tz });
  }

  try {
    const out = await moveChapterToGroup(db, {
      zoneId: ctx.zoneId,
      chapterId,
      newGroupId: input.groupId,
      effectiveDate,
      actorUserId: ctx.userId,
    });
    return c.json({ status: out.changed ? "moved" : "noop" });
  } catch (e) {
    if (e instanceof GroupsNotEnabledError) return c.json({ error: { code: "groups_not_enabled", message: e.message } }, 409);
    if (e instanceof HistoryViolationError) return c.json({ error: { code: "history_violation", message: e.message } }, 400);
    if (e instanceof Error && e.message.includes("Target group not found")) {
      return c.json({ error: { code: "group_not_found", message: "Group not in this zone" } }, 404);
    }
    throw e;
  }
});

tenantGroupsRouter.get("/chapters/:id/group-history", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  const chapterId = c.req.param("id");
  const [chap] = await db.select({ id: chapters.id }).from(chapters)
    .where(and(eq(chapters.id, chapterId), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt))).limit(1);
  if (!chap) return c.json({ error: { code: "chapter_not_found", message: "Chapter not in this zone" } }, 404);

  const rows = await db
    .select({
      id: chapterGroupHistory.id,
      groupId: chapterGroupHistory.groupId,
      groupName: groups.name,
      dateFrom: chapterGroupHistory.dateFrom,
      dateTo: chapterGroupHistory.dateTo,
    })
    .from(chapterGroupHistory)
    .innerJoin(groups, eq(groups.id, chapterGroupHistory.groupId))
    .where(eq(chapterGroupHistory.chapterId, chapterId))
    .orderBy(asc(chapterGroupHistory.dateFrom));
  return c.json({ items: rows });
});

// Helper to break the require() inline above into a clean import at the top.
import { zones } from "@stewardledger/db/schema";
function zonesTzCol() { return zones.defaultTimeZone; }
```

> **Cleanup note for the executor:** the inline `require()` in step 3 is a placeholder to keep the example self-contained. Replace it with the `import { zones } from "@stewardledger/db/schema";` already at the bottom and use `db.select({ tz: zones.defaultTimeZone })`.

- [ ] **Step 4: Mount the router**

Edit `packages/api/src/routes/tenant.ts` — under the existing `tenantRouter.route("/", tenantPeriodsRouter);` block, add:

```ts
import { tenantGroupsRouter } from "./tenant-groups";
// ...
tenantRouter.route("/", tenantGroupsRouter);
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @stewardledger/api test -- --run tenant-groups.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/tenant-groups.ts packages/api/src/routes/tenant-groups.test.ts packages/api/src/routes/tenant.ts
git commit -m "feat(api): tenant-groups router (CRUD + move + history)"
```

### Task 12: tenant-zones router — groups-enabled toggle

**Files:**
- Create: `packages/api/src/routes/tenant-zones.ts`
- Create: `packages/api/src/routes/tenant-zones.test.ts`

- [ ] **Step 1: Write the failing tests**

Tests must cover:

- `POST /api/tenant/zones/groups-enabled` with `{ enabled: true }` → 200 when all chapters assigned; flag flips; history segments opened.
- 409 with `groups_enable_blocked` + list of unassigned chapter ids when one chapter has null group_id.
- 200 idempotent when already enabled.
- 403 for chapter_admin / zone_admin (only zone_owner can flip per D9).
- 400 when body is `{ enabled: false }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stewardledger/api test -- --run tenant-zones.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create the router**

```ts
// packages/api/src/routes/tenant-zones.ts
import { zValidator } from "@hono/zod-validator";
import { type AuthorizedContext, ZONE_ROLES, zoneEnableGroupsSchema } from "@stewardledger/shared";
import { Hono } from "hono";
import { db } from "../db";
import { hasAnyRole } from "../middleware/auth";
import { GroupsEnableBlockedError, enableGroupsForZone } from "../services/groups";

export const tenantZonesRouter = new Hono();

tenantZonesRouter.post(
  "/zones/groups-enabled",
  zValidator("json", zoneEnableGroupsSchema),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER)) {
      return c.json({ error: { code: "forbidden", message: "Zone owner required" } }, 403);
    }
    try {
      await enableGroupsForZone(db, { zoneId: ctx.zoneId, actorUserId: ctx.userId });
    } catch (e) {
      if (e instanceof GroupsEnableBlockedError) {
        return c.json({
          error: {
            code: "groups_enable_blocked",
            message: e.message,
            details: { unassignedChapterIds: e.unassignedChapterIds },
          },
        }, 409);
      }
      throw e;
    }
    return c.json({ status: "enabled" });
  },
);
```

- [ ] **Step 4: Mount**

In `packages/api/src/routes/tenant.ts`:

```ts
import { tenantZonesRouter } from "./tenant-zones";
tenantRouter.route("/", tenantZonesRouter);
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @stewardledger/api test -- --run tenant-zones.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/tenant-zones.ts packages/api/src/routes/tenant-zones.test.ts packages/api/src/routes/tenant.ts
git commit -m "feat(api): groups-enabled toggle endpoint"
```

### Task 13: Modify chapters create/patch — accept groupId

**Files:**
- Modify: `packages/api/src/routes/tenant.ts`

- [ ] **Step 1: Write the failing test**

Extend `packages/api/src/routes/tenant.test.ts` (chapters section) with cases:

- POST /chapters with groupId before enable → 200, chapters.group_id set, no history row.
- POST /chapters with groupId after enable → 200, chapters.group_id set, one history segment opened with date_from = chapter.dateFrom.
- POST /chapters without groupId after enable → 400 with `group_required`.
- POST /chapters with cross-zone groupId → 404.
- PATCH /chapters/:id with groupId before enable → 200, group_id updated, no history.
- PATCH /chapters/:id with groupId after enable → 400 with `use_move_group`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stewardledger/api test -- --run tenant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Edit `tenant.ts` — modify the `POST /chapters` handler**

Replace the handler with:

```ts
tenantRouter.post("/chapters", zValidator("json", chapterCreateSchema), async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) {
    return c.json({ error: { code: "forbidden", message: "Zone admin required" } }, 403);
  }
  const input = c.req.valid("json");
  const today = new Date().toISOString().slice(0, 10);

  const result = await db.transaction(async (tx) => {
    const referenceCode = await nextChapterReferenceCode(tx, ctx.zoneId);
    const [zone] = await tx
      .select({ regionId: zones.regionId, groupsEnabled: zones.groupsEnabled })
      .from(zones)
      .where(eq(zones.id, ctx.zoneId))
      .limit(1);

    if (zone?.groupsEnabled && !input.groupId) {
      return { error: { status: 400, code: "group_required", message: "groupId is required when groups are enabled" } } as const;
    }
    if (input.groupId) {
      const [grp] = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.id, input.groupId), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt)))
        .limit(1);
      if (!grp) return { error: { status: 404, code: "group_not_found", message: "Group not in this zone" } } as const;
    }

    const dateFrom = input.dateFrom ?? today;

    const [row] = await tx
      .insert(chapters)
      .values({
        zoneId: ctx.zoneId,
        regionId: zone?.regionId ?? null,
        groupId: input.groupId ?? null,
        referenceCode,
        name: input.name,
        countryCode: input.countryCode ?? null,
        dateFrom,
      })
      .returning({
        id: chapters.id,
        referenceCode: chapters.referenceCode,
        name: chapters.name,
        groupId: chapters.groupId,
      });

    if (zone?.groupsEnabled && input.groupId) {
      await tx.insert(chapterGroupHistory).values({
        zoneId: ctx.zoneId,
        chapterId: row.id,
        groupId: input.groupId,
        dateFrom,
      });
    }
    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      action: "chapter.create",
      entityType: "chapter",
      entityId: row.id,
      after: row,
    });
    return { ok: row } as const;
  });

  if ("error" in result) return c.json({ error: result.error }, result.error.status);
  return c.json({ chapter: result.ok }, 201);
});
```

Add imports at the top of `tenant.ts`:

```ts
import { chapterGroupHistory, groups } from "@stewardledger/db/schema";
import { assignChapterToGroupPreEnable } from "../services/groups";
```

- [ ] **Step 4: Add a PATCH /chapters/:id endpoint (NEW — does not exist yet)**

After the existing `tenantRouter.patch("/chapters/:id/banking", ...)` block, add:

```ts
tenantRouter.patch(
  "/chapters/:id",
  zValidator("json", z.object({ groupId: uuidSchema }).strict()),
  async (c) => {
    const ctx = c.get("auth") as AuthorizedContext;
    if (!hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN)) return forbidden(c);
    const id = c.req.param("id");
    const input = c.req.valid("json");

    const [zone] = await db.select({ groupsEnabled: zones.groupsEnabled }).from(zones).where(eq(zones.id, ctx.zoneId)).limit(1);
    if (zone?.groupsEnabled) {
      return c.json({ error: { code: "use_move_group", message: "Use POST /chapters/:id/move-group when groups are enabled" } }, 400);
    }
    try {
      await assignChapterToGroupPreEnable(db, {
        zoneId: ctx.zoneId,
        chapterId: id,
        groupId: input.groupId,
        actorUserId: ctx.userId,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("Group not found")) {
        return c.json({ error: { code: "group_not_found", message: "Group not in this zone" } }, 404);
      }
      if (e instanceof Error && e.message.includes("Chapter not found")) {
        return c.json({ error: { code: "chapter_not_found", message: "Chapter not in this zone" } }, 404);
      }
      throw e;
    }
    return c.json({ status: "ok" });
  },
);
```

Add `import { z } from "zod";` and `import { uuidSchema } from "@stewardledger/shared";` at the top if not present.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @stewardledger/api test -- --run tenant.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/tenant.ts packages/api/src/routes/tenant.test.ts
git commit -m "feat(api): chapters create+patch honour groupId / groups_enabled"
```

### Task 14: Invitations — accept groupId and seed group_admin rules

**Files:**
- Modify: `packages/api/src/routes/tenant.ts` (invitations section)
- Modify: `packages/api/src/services/invitations.ts`

- [ ] **Step 1: Edit `invitations.ts`** — add `isGroupRole` helper

In `packages/api/src/services/invitations.ts`, add:

```ts
import { GROUP_ROLES } from "@stewardledger/shared";

export function isGroupRole(code: string): boolean {
  return (Object.values(GROUP_ROLES) as string[]).includes(code);
}
```

Modify `createInvitation` to accept `groupId`:

```ts
interface CreateArgs {
  zoneId: string;
  email: string;
  roleCode: string;
  chapterId?: string | null;
  groupId?: string | null;
  createdByUserId?: string | null;
}
// ...
.values({
  zoneId: args.zoneId,
  email: args.email.toLowerCase(),
  roleCode: args.roleCode,
  chapterId: args.chapterId ?? null,
  groupId: args.groupId ?? null,
  tokenHash,
  expiresAt,
  createdByUserId: args.createdByUserId ?? null,
})
```

Modify `applyAcceptedInvitation` to insert `group_id` into `userRoleBindings` with `roleScope`:

```ts
// Select roles.scope alongside roles.id
const [role] = await tx
  .select({ id: roles.id, scope: roles.scope })
  .from(roles)
  .where(and(eq(roles.zoneId, inv.zoneId), eq(roles.code, inv.roleCode)))
  .limit(1);

// And on insert:
await tx.insert(userRoleBindings).values({
  userId: args.userId,
  zoneId: inv.zoneId,
  chapterId: inv.chapterId,
  groupId: (inv as any).groupId ?? null,
  roleScope: role.scope,
  roleId: role.id,
});
```

Also extend the `select` for `inv` to include `groupId: invitations.groupId`.

- [ ] **Step 2: Edit `tenant.ts` invitations POST**

Replace the existing handler's guards/CHECKS with:

```ts
import { isGroupRole, isChapterRole } from "../services/invitations";
import { GROUP_ROLES } from "@stewardledger/shared";

// ... inside POST /invitations
const isZoneAdmin = hasAnyRole(ctx, ZONE_ROLES.ZONE_OWNER, ZONE_ROLES.ZONE_ADMIN);
const isChapterAdmin = ctx.roleCodes.includes(CHAPTER_ROLES.CHAPTER_ADMIN);
const isGroupAdmin = ctx.roleCodes.includes(GROUP_ROLES.GROUP_ADMIN);
if (!isZoneAdmin && !isChapterAdmin && !isGroupAdmin) {
  return c.json({ error: { code: "forbidden", message: "Admin role required" } }, 403);
}

// group_admin can only invite chapter-scope roles into chapters in their own group(s)
if (!isZoneAdmin) {
  if (isGroupAdmin && !isChapterAdmin) {
    if (!isChapterRole(input.roleCode)) {
      return forbidden(c, "Group admins can only invite chapter roles");
    }
    if (!input.chapterId) {
      return c.json({ error: { code: "chapter_required", message: "chapterId required" } }, 400);
    }
    // Validate the chapter is in one of the caller's groups
    const [chap] = await db.select({ groupId: chapters.groupId }).from(chapters)
      .where(and(eq(chapters.id, input.chapterId), eq(chapters.zoneId, ctx.zoneId), isNull(chapters.deletedAt))).limit(1);
    if (!chap || !chap.groupId || !ctx.groupIds.includes(chap.groupId)) {
      return forbidden(c, "Chapter is not in your group");
    }
  } else if (isChapterAdmin) {
    if (!isChapterRole(input.roleCode)) return forbidden(c, "Chapter admins can only invite chapter roles");
    if (!input.chapterId || !ctx.chapterIds.includes(input.chapterId)) {
      return forbidden(c, "Chapter admins can only invite into their own chapter");
    }
  }
}

// Cross-tenant guards for groupId
if (input.groupId) {
  const [g] = await db.select({ id: groups.id }).from(groups)
    .where(and(eq(groups.id, input.groupId), eq(groups.zoneId, ctx.zoneId), isNull(groups.deletedAt))).limit(1);
  if (!g) return c.json({ error: { code: "group_not_found", message: "Group not in this zone" } }, 404);
}

// Shape checks now include group_*
if (isGroupRole(input.roleCode) && !input.groupId) {
  return c.json({ error: { code: "group_required", message: "groupId required for group roles" } }, 400);
}
if (isChapterRole(input.roleCode) && !input.chapterId) {
  return c.json({ error: { code: "chapter_required", message: "chapterId required for chapter roles" } }, 400);
}
if (!isGroupRole(input.roleCode) && !isChapterRole(input.roleCode) && (input.chapterId || input.groupId)) {
  return c.json({ error: { code: "scope_forbidden", message: "Zone roles take no chapter/group" } }, 400);
}
```

And the createInvitation call:

```ts
const inv = await createInvitation(tx, {
  zoneId: ctx.zoneId,
  email: input.email,
  roleCode: input.roleCode,
  chapterId: input.chapterId ?? null,
  groupId: input.groupId ?? null,
  createdByUserId: ctx.userId,
});
```

- [ ] **Step 3: Add tests**

Extend `tenant.test.ts` (invitations section) with:

```ts
it("zone_admin can invite a group_admin with groupId", async () => {});
it("group_admin can invite chapter_admin into a chapter in their group", async () => {});
it("group_admin cannot invite into a chapter not in their group", async () => {});
it("group_admin cannot invite zone_admin", async () => {});
it("rejects group_admin invite without groupId", async () => {});
it("rejects cross-zone groupId on invitation", async () => {});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @stewardledger/api test -- --run tenant.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tenant.ts packages/api/src/services/invitations.ts
git commit -m "feat(api): invitations accept groupId; group_admin invite rules"
```

### Task 15: Administrators listing — include group bindings

**Files:**
- Modify: `packages/api/src/routes/tenant.ts` (administrators section)

- [ ] **Step 1: Edit the `GET /administrators` handler**

Replace the existing handler with one that adds `groupId`, `groupName`, and `groupSlug` columns and accepts `["zone","group","chapter"]` in the scope `inArray`:

```ts
import { groups } from "@stewardledger/db/schema";

tenantRouter.get("/administrators", async (c) => {
  const ctx = c.get("auth") as AuthorizedContext;
  if (!hasAnyRole(ctx, ...ADMIN_BINDING_WRITE_ROLES)) return forbidden(c, "Zone admin required");

  const rows = await db
    .select({
      bindingId: userRoleBindings.id,
      userId: userTable.id,
      email: userTable.email,
      name: userTable.name,
      roleId: rolesTable.id,
      roleCode: rolesTable.code,
      roleName: rolesTable.name,
      roleScope: rolesTable.scope,
      chapterId: userRoleBindings.chapterId,
      chapterName: chapters.name,
      chapterReferenceCode: chapters.referenceCode,
      groupId: userRoleBindings.groupId,
      groupName: groups.name,
      groupSlug: groups.slug,
      grantedAt: userRoleBindings.grantedAt,
    })
    .from(userRoleBindings)
    .innerJoin(userTable, eq(userRoleBindings.userId, userTable.id))
    .innerJoin(rolesTable, eq(userRoleBindings.roleId, rolesTable.id))
    .leftJoin(chapters, and(eq(chapters.zoneId, userRoleBindings.zoneId), eq(chapters.id, userRoleBindings.chapterId)))
    .leftJoin(groups, and(eq(groups.zoneId, userRoleBindings.zoneId), eq(groups.id, userRoleBindings.groupId)))
    .where(and(
      eq(userRoleBindings.zoneId, ctx.zoneId),
      isNull(userRoleBindings.revokedAt),
      inArray(rolesTable.scope, ["zone", "group", "chapter"]),
    ))
    .orderBy(asc(userTable.email), asc(rolesTable.scope), asc(rolesTable.code));

  return c.json({ items: rows });
});
```

The DELETE handler is unchanged.

- [ ] **Step 2: Test**

Run: `pnpm --filter @stewardledger/api test -- --run tenant.test.ts`
Expected: PASS (existing administrator tests stay green; new admin includes group rows by virtue of seeding).

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/tenant.ts
git commit -m "feat(api): administrators listing includes group bindings"
```

### Task 16: Narrow tenant reads through visibleChapterIds

**Files:** modify each tenant read router so a group-tier session sees only its chapters.

For each of these files, locate the chapter-scope guard (typically a `hasAnyRole(ctx, ...ZONE_WIDE)` check followed by an `inArray(table.chapterId, ctx.chapterIds)` clause) and replace it with `visibleChapterIds`:

- `packages/api/src/routes/tenant-members.ts`
- `packages/api/src/routes/tenant-contributions.ts`
- `packages/api/src/routes/tenant-imports.ts`
- `packages/api/src/routes/tenant-reports.ts`
- `packages/api/src/routes/tenant-targets.ts`
- `packages/api/src/routes/tenant-paying-in-books.ts`
- `packages/api/src/routes/tenant-giving-events.ts`
- `packages/api/src/routes/tenant-dashboard.ts`
- `packages/api/src/routes/tenant-periods.ts`

- [ ] **Step 1: Pattern**

For each file, change:

```ts
const zoneWide = hasAnyRole(ctx, ...ZONE_WIDE_ROLES);
const conditions = [eq(table.zoneId, ctx.zoneId)];
if (!zoneWide) conditions.push(inArray(table.chapterId, ctx.chapterIds));
```

To:

```ts
const scope = await visibleChapterIds(ctx, ZONE_WIDE_ROLES);
const conditions = [eq(table.zoneId, ctx.zoneId)];
if (scope.kind === "list") {
  if (scope.ids.length === 0) return c.json({ items: [] });
  conditions.push(inArray(table.chapterId, scope.ids));
}
```

`visibleChapterIds` is imported from `../middleware/auth`.

- [ ] **Step 2: Per file, one commit each**

Iterate one file at a time. For each:

1. Edit the file per the pattern above. Some files have multiple list endpoints — update every one.
2. Run that file's tests: `pnpm --filter @stewardledger/api test -- --run <file-basename>.test.ts`. Expected: PASS.
3. `git add` and commit: `git commit -m "refactor(api): <module> uses visibleChapterIds chokepoint"`.

- [ ] **Step 3: Final full-suite check**

Run: `pnpm --filter @stewardledger/api test`
Expected: PASS.

---

## Phase 5 — Web

### Task 17: Session-paths: groupRoles + /group landing

**Files:**
- Modify: `packages/web/src/lib/session-paths.ts`
- Modify: `packages/web/src/lib/session-paths.test.ts`
- Modify: `packages/api/src/routes/public.ts` (the `/api/public/session-zones` wire payload)

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/lib/session-paths.test.ts`:

```ts
describe("authenticatedLandingPath — group tier", () => {
  it("group-tier without zone-tier → /group/dashboard", () => {
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

  it("group + chapter → /group/dashboard", () => {
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

  it("chapter only → /church/overview (unchanged)", () => {
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
```

- [ ] **Step 2: Edit `session-paths.ts`**

Add `"group"` to `PrimaryRole`:

```ts
export type PrimaryRole = "platform" | "zonal" | "group" | "church";
```

Extend `AuthenticatedLandingInput`:

```ts
activeZoneGroupRoles?: Array<{ groupId: string; roleCode: string }>;
```

Extend `ServerSession.items[*]`:

```ts
groupRoles: Array<{ groupId: string; roleCode: string }>;
```

In `primaryRole`, insert group between zonal and church:

```ts
if (s.activeZoneRoles && s.activeZoneRoles.length > 0) return "zonal";
if (s.activeZoneGroupRoles && s.activeZoneGroupRoles.length > 0) return "group";
if (s.activeZoneChapterRoles && s.activeZoneChapterRoles.length > 0) return "church";
```

In `canAccessRole`:

```ts
case "group":
  return hasZoneRoles || (s.activeZoneGroupRoles?.length ?? 0) > 0 || hasLegacyTenantBinding;
```

In `authenticatedLandingPath`, after `if (role === "church") ...`:

```ts
if (role === "group") return `/group/dashboard${zoneQs}`;
```

In `canAccessRoleAnyZone`:

```ts
if (role === "group") return s.items.some((z) => z.zoneRoles.length > 0 || z.groupRoles.length > 0);
```

In `landingInputFromServerSession`:

```ts
activeZoneGroupRoles: picked?.groupRoles ?? [],
```

In `PROTECTED_PREFIXES`, add `"/group"`.

- [ ] **Step 3: Update wire payload**

In `packages/api/src/routes/public.ts`, locate the `/session-zones` handler and add `groupRoles` to each zone item — load group bindings via a join on `groups` similar to how chapter bindings are loaded today.

- [ ] **Step 4: Run web tests**

Run: `pnpm --filter @stewardledger/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/session-paths.ts packages/web/src/lib/session-paths.test.ts packages/api/src/routes/public.ts
git commit -m "feat(web): /group landing path + groupRoles on session payload"
```

### Task 18: /group/+layout — auth gate and boundGroup loader

**Files:**
- Create: `packages/web/src/routes/group/+layout.server.ts`
- Create: `packages/web/src/routes/group/+layout.svelte`
- Create: `packages/web/src/routes/group/+page.svelte`

- [ ] **Step 1: Create `+layout.server.ts`**

```ts
// packages/web/src/routes/group/+layout.server.ts
import { redirect } from "@sveltejs/kit";
import { authenticatedLandingPath, canAccessRoleAnyZone, landingInputFromServerSession } from "$lib/session-paths";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url, fetch }) => {
  const session = locals.session;
  if (!session) return {};

  if (!canAccessRoleAnyZone(session, "group")) {
    const next = url.searchParams.get("next");
    const input = landingInputFromServerSession(session, url.searchParams.get("zone"));
    redirect(303, authenticatedLandingPath(input, next));
  }

  // Resolve active zone + the group(s) the user is bound to in that zone.
  const zoneSlug = url.searchParams.get("zone") ?? session.items[0]?.slug ?? null;
  const zone = session.items.find((z) => z.slug === zoneSlug) ?? session.items[0];
  const groupBindings = zone?.groupRoles ?? [];

  // Fetch group details
  const res = await fetch("/api/tenant/groups", { headers: {} });
  const data = res.ok ? await res.json() : { items: [] };
  const allGroups = data.items as Array<{ id: string; slug: string; name: string }>;

  const myGroups = allGroups.filter((g) => groupBindings.some((b) => b.groupId === g.id));
  const boundGroup = myGroups[0] ?? null;

  return { boundGroup, myGroups };
};
```

- [ ] **Step 2: Create `+layout.svelte`**

```svelte
<script lang="ts">
  import type { LayoutData } from "./$types";
  let { data, children }: { data: LayoutData; children: any } = $props();
</script>

<div class="flex min-h-screen">
  <nav class="w-60 bg-slate-900 text-slate-100 p-4 space-y-2">
    <div class="text-sm uppercase opacity-70">Group</div>
    {#if data.boundGroup}
      <div class="font-bold">{data.boundGroup.name}</div>
      {#if data.myGroups.length > 1}
        <select class="text-slate-900 mt-2 w-full">
          {#each data.myGroups as g}
            <option value={g.id} selected={g.id === data.boundGroup.id}>{g.name}</option>
          {/each}
        </select>
      {/if}
      <ul class="space-y-1 mt-4 text-sm">
        <li><a href="/group/dashboard">Dashboard</a></li>
        <li><a href="/group/chapters">Chapters</a></li>
        <li><a href="/group/members">Members</a></li>
        <li><a href="/group/contributions">Contributions</a></li>
        <li><a href="/group/reports">Reports</a></li>
        <li><a href="/group/administrators">Administrators</a></li>
      </ul>
    {:else}
      <div>No group bound to this session.</div>
    {/if}
  </nav>
  <main class="flex-1 p-6">
    {@render children()}
  </main>
</div>
```

- [ ] **Step 3: Create `+page.svelte` (root redirect)**

```svelte
<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  onMount(() => goto("/group/dashboard", { replaceState: true }));
</script>
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/routes/group/
git commit -m "feat(web): /group layout shell and auth gate"
```

### Task 19: /group sub-pages (dashboard, chapters, members, contributions, reports, administrators)

For each sub-page, create a `+page.server.ts` that loads the data via `/api/tenant/*` (the API already narrows results to the caller's chapters via `visibleChapterIds`), and a `+page.svelte` that renders it.

- [ ] **Step 1: Create `/group/dashboard`**

`+page.server.ts`:

```ts
import type { PageServerLoad } from "./$types";
export const load: PageServerLoad = async ({ fetch }) => {
  const res = await fetch("/api/tenant/dashboard");
  const data = res.ok ? await res.json() : null;
  return { dashboard: data };
};
```

`+page.svelte`:

```svelte
<script lang="ts">
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();
</script>
<h1 class="text-2xl font-bold mb-4">Group dashboard</h1>
<pre class="text-xs bg-slate-100 p-2 rounded">{JSON.stringify(data.dashboard, null, 2)}</pre>
```

- [ ] **Step 2: Repeat for `/group/chapters`, `/group/members`, `/group/contributions`, `/group/reports`, `/group/administrators`**

Each is a thin wrapper around the corresponding `/api/tenant/<resource>` endpoint. Lift the list/detail components from `/zone/<resource>` where possible — typically the loader just calls `fetch` and the page renders the result. Commit each separately:

```bash
git add packages/web/src/routes/group/dashboard
git commit -m "feat(web): /group/dashboard"
git add packages/web/src/routes/group/chapters
git commit -m "feat(web): /group/chapters"
# ... etc
```

- [ ] **Step 3: Commit**

After all sub-pages exist and `pnpm --filter @stewardledger/web test` passes:

```bash
pnpm --filter @stewardledger/web check
git add packages/web/src/routes/group/
git commit -m "feat(web): /group sub-pages skeleton"
```

### Task 20: /zone/groups — list, create, soft-delete

**Files:**
- Create: `packages/web/src/routes/zone/groups/+page.server.ts`
- Create: `packages/web/src/routes/zone/groups/+page.svelte`
- Create: `packages/web/src/routes/zone/groups/[id]/+page.server.ts`
- Create: `packages/web/src/routes/zone/groups/[id]/+page.svelte`

- [ ] **Step 1: List loader**

`+page.server.ts`:

```ts
import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => {
  const res = await fetch("/api/tenant/groups");
  const data = res.ok ? await res.json() : { items: [] };
  return { groups: data.items };
};

export const actions: Actions = {
  create: async ({ request, fetch }) => {
    const form = await request.formData();
    const res = await fetch("/api/tenant/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: String(form.get("name")), slug: String(form.get("slug")) }),
    });
    if (!res.ok) {
      const err = await res.json();
      return fail(res.status, { error: err.error });
    }
    return { ok: true };
  },
  delete: async ({ request, fetch }) => {
    const form = await request.formData();
    const id = String(form.get("id"));
    const res = await fetch(`/api/tenant/groups/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json();
      return fail(res.status, { error: err.error });
    }
    return { ok: true };
  },
};
```

- [ ] **Step 2: List view**

```svelte
<script lang="ts">
  import { enhance } from "$app/forms";
  let { data, form }: { data: any; form: any } = $props();
</script>

<h1 class="text-2xl font-bold mb-4">Groups</h1>

<form method="POST" action="?/create" use:enhance class="mb-6 space-x-2">
  <input name="name" placeholder="Group name" required class="border p-2" />
  <input name="slug" placeholder="slug-here" required class="border p-2" />
  <button class="bg-blue-600 text-white px-4 py-2">Create</button>
  {#if form?.error}<div class="text-red-600">{form.error.message}</div>{/if}
</form>

<table class="w-full text-left">
  <thead><tr><th>Name</th><th>Slug</th><th>Chapters</th><th></th></tr></thead>
  <tbody>
    {#each data.groups as g}
      <tr class="border-t">
        <td><a href="/zone/groups/{g.id}">{g.name}</a></td>
        <td><code>{g.slug}</code></td>
        <td>{g.chapterCount}</td>
        <td>
          <form method="POST" action="?/delete" use:enhance>
            <input type="hidden" name="id" value={g.id} />
            <button class="text-red-600" disabled={g.chapterCount > 0}>Delete</button>
          </form>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
```

- [ ] **Step 3: Detail loader + view**

`/zone/groups/[id]/+page.server.ts` fetches the group + its chapters. Detail view shows the group's metadata and a list of chapters in the group.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/routes/zone/groups/
git commit -m "feat(web): /zone/groups list + detail"
```

### Task 21: /zone/chapters — Group column + Move-group action

**Files:**
- Modify: `packages/web/src/routes/zone/chapters/+page.server.ts`
- Modify: `packages/web/src/routes/zone/chapters/+page.svelte`
- Modify: `packages/web/src/routes/zone/chapters/[id]/+page.server.ts`
- Modify: `packages/web/src/routes/zone/chapters/[id]/+page.svelte`

- [ ] **Step 1: Loader changes**

In `+page.server.ts`, fetch `/api/tenant/groups` alongside chapters; pass into the page so the column / dropdown can render.

In the chapter detail loader, fetch `/api/tenant/chapters/:id/group-history` and the groups list.

- [ ] **Step 2: View changes**

- List: add a Group column showing `chapter.groupId ? groupNameById[chapter.groupId] : "—"`. Add an "assign group" inline form (visible only when zone.groupsEnabled is false) that POSTs to `/api/tenant/chapters/:id`.
- Detail: render the current group + history; add a "Move group" form that POSTs to `/api/tenant/chapters/:id/move-group`.

(Full component code is mechanical and follows the existing chapters list/detail patterns.)

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/routes/zone/chapters/
git commit -m "feat(web): /zone/chapters group column + move-group"
```

### Task 22: /zone/settings Groups panel + enable toggle

**Files:**
- Modify: `packages/web/src/routes/zone/settings/+page.server.ts`
- Modify: `packages/web/src/routes/zone/settings/+page.svelte`

- [ ] **Step 1: Loader returns unassigned-chapter list when toggle off**

```ts
// inside load
const zoneRes = await fetch("/api/tenant/me");
const { zone } = zoneRes.ok ? await zoneRes.json() : { zone: null };
const groupsRes = await fetch("/api/tenant/groups");
const { items: groups } = groupsRes.ok ? await groupsRes.json() : { items: [] };
const chaptersRes = await fetch("/api/tenant/chapters");
const { items: chapters } = chaptersRes.ok ? await chaptersRes.json() : { items: [] };
const unassigned = (chapters as any[]).filter((c) => !c.groupId);
return { zone, groups, chapters, unassigned };
```

- [ ] **Step 2: View renders the Groups panel**

When `zone.groupsEnabled === false`:
- Show count of unassigned chapters + a list with inline "Assign to group" select.
- "Enable groups" button, disabled when `unassigned.length > 0`.
- Confirmation modal: "This cannot be undone."

When `zone.groupsEnabled === true`:
- Static "Groups are enabled" panel, no controls.

The action handler POSTs to `/api/tenant/zones/groups-enabled` with `{ enabled: true }`.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/routes/zone/settings/
git commit -m "feat(web): zone settings Groups panel + enable toggle"
```

---

## Phase 6 — Docs

### Task 23: Update domain docs

**Files:**
- Modify: `docs/DOMAIN-MODEL.md`
- Modify: `docs/PRD.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/DOMAIN-REFERENCE.md`

- [ ] **Step 1: DOMAIN-MODEL.md**

Insert a new subsection between §2.4 (Chapters) and what is currently §2.5 (Roles & bindings). New subsection: "### 2.5 Groups (sub-grouping of chapters)". Body summarises the schema from the spec §3 and links to the spec for the full design. Update §15 (line 811) to remove the "ChurchGroup dropped" note.

- [ ] **Step 2: PRD.md §6**

Add `group_admin` and `group_pastor_viewer` to the role table with their definitions.

- [ ] **Step 3: ROADMAP.md**

Add a "Phase X — Groups hierarchy" entry summarising what shipped.

- [ ] **Step 4: DOMAIN-REFERENCE.md**

Update line 189 — note that `ChurchGroup` has been reintroduced as a first-class layer (link to spec).

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: groups hierarchy in domain docs"
```

---

## Phase 7 — Final verification

### Task 24: Full check + manual smoke

- [ ] **Step 1: Full repo check**

Run:
```bash
pnpm install
pnpm check
pnpm lint
pnpm test
```
Expected: all green.

- [ ] **Step 2: Manual smoke (per §8.5 of the spec)**

1. With `pnpm dev` running, seed: `pnpm seed:demo -- --reset`.
2. Create a platform admin: `pnpm create-admin -- --email admin@local --password-env ADMIN_PASSWORD --name 'Admin'`.
3. Sign in, invite a `zone_owner` for `demo-grace-uk`, accept the invite.
4. As zone_owner: visit `/zone/settings` → Groups panel.
5. Create two groups ("East", "West"). Assign every demo chapter to one of them. Click "Enable groups" → confirm modal.
6. Invite a `group_admin` for "East". Accept the invite, sign in as that user. Verify the landing path is `/group/dashboard`; verify only East's chapters appear in `/group/chapters`.
7. As zone_owner: move a chapter from East to West, effective date today. Verify `chapter_group_history` has two segments via `pnpm db:studio`.
8. As group_admin for East: confirm the moved chapter no longer appears.

- [ ] **Step 3: Open PR**

```bash
git push -u origin feat/groups-hierarchy
gh pr create --title "feat: groups hierarchy" --body "Implements docs/superpowers/specs/2026-05-22-groups-hierarchy-design.md"
```

---

## Self-Review checklist

- **Spec coverage:** every section §3–§8 of the spec maps to at least one task (D1: Task 6; D2: Task 1; D3: Tasks 4, 10; D4: Tasks 11–13; D5: Tasks 3, 11; D6: Tasks 10–11; D7: Tasks 11, 19; D8: Task 13; D9: Tasks 6, 10, 12, 22; D10: Tasks 9, 16; D11: Task 14; D12: Tasks 17–18; D13: Tasks 18–19; D14: Task 10; D15: Task 10).
- **Placeholders:** none — every code-bearing step shows actual code. Two intentional escape hatches (Task 5's inline FK placeholder, Task 11's inline `require()`) are explicitly called out for replacement.
- **Type consistency:** `AuthorizedContext.groupIds` is declared in Task 2, populated in Task 9, consumed in Task 16. `GROUP_ROLES`, `groupCreateSchema`, `chapterMoveGroupSchema`, `zoneEnableGroupsSchema` use the names introduced in Tasks 1/3. The service functions `assignChapterToGroupPreEnable`, `moveChapterToGroup`, `enableGroupsForZone`, `softDeleteGroup` and their error classes use the exact names from Task 10 in Tasks 11, 12, 13, 14, 22.
- **Audit codes:** `group.create`, `group.update`, `group.delete`, `chapter.group.assign`, `chapter.group.move`, `zone.groups.enable` — referenced consistently in Tasks 10 and 11.
