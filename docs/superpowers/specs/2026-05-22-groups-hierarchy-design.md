# Groups: a new hierarchy layer between Zone and Chapter

**Status:** design approved, awaiting user spec-review

**Date:** 2026-05-22

## 1. Purpose

Introduce a `Group` layer between a zone and its chapters so that a zone can be organised into named sub-collections of chapters (e.g. regional clusters within a zone, ministry groupings). Group-tier roles let a "group pastor" or "group admin" see and administer the records of every chapter in their group — narrower than zone-tier, broader than chapter-tier.

Concretely, the target hierarchy after this spec ships:

```
Region (curated reference data, global)
  └── Zone (the tenant)
        └── Group  ← THIS SPEC
              └── Chapter (the local church)
                    └── Member
                    └── (future: Cell — see §10)
```

This reintroduces the legacy `ChurchGroup` concept (intentionally dropped at v1; see `docs/DOMAIN-REFERENCE.md` line 189 and `docs/DOMAIN-MODEL.md` line 811) as a first-class layer, with crisper semantics than the legacy model.

## 2. Decisions

These are the binding decisions from the brainstorm. Each is the answer to one clarifying question and cannot be silently reversed during implementation.

| # | Decision |
|---|---|
| D1 | Groups are **per-zone opt-in** via a `zones.groups_enabled` boolean. When enabled, every chapter must belong to exactly one group. When disabled, group_id is ignored. |
| D2 | Two new group-tier roles: `group_admin` (manage + read group's chapters) and `group_pastor_viewer` (read-only across group's chapters). |
| D3 | Chapter→group moves are **point-in-time** and recorded in a `chapter_group_history` table mirroring the existing `chapter_name_history` pattern. |
| D4 | Only `zone_owner` and `zone_admin` can create groups or move chapters between groups. `group_admin` cannot create new groups or reassign chapters out of their group. |
| D5 | Group identity = `name` + `slug` (both unique per zone, slug URL-safe). No reference_code. |
| D6 | Groups soft-delete only when they have **zero active chapters**. Zone admins must move chapters out first. |
| D7 | `group_admin` is **read-only** for contributions. Posting/voiding stays with `chapter_treasurer` / `zone_finance_admin`. |
| D8 | When `groups_enabled = true`, `groupId` is **required** at chapter create. No "Unassigned" holding group. |
| D9 | The `groups_enabled` toggle is **one-way**. Enabling requires every chapter in the zone to have a group first; disabling is not supported. |
| D10 | `group_id` is **not denormalized** onto members / contributions / batches / etc. Reports join through `chapters` (current) or `chapter_group_history` (date-bounded). |
| D11 | A `group_admin` may invite chapter-scoped admins for chapters in their own group. They cannot invite group-tier or zone-tier roles. |
| D12 | Group admins on multiple groups within the same zone get a group switcher in `/group/*` header. |
| D13 | `group_admin` has chapter_admin-equivalent edit rights on chapters within their group (name, banking refs, batch templates). |
| D14 | `chapter_group_history` move semantics: backdating allowed within the current open segment only. `effectiveDate` defaults to today in the zone's time zone. |
| D15 | At opt-in, each chapter's initial `chapter_group_history` segment has `date_from = chapter.date_from` so historical reports work back to chapter inception. |

## 3. Schema

New tenant-scoped `groups` table, a `chapter_group_history` table for point-in-time moves, one new column on `zones`, one new column on `chapters`, and additions to `user_role_bindings` and `invitations`.

```sql
-- New
groups
  id uuid pk
  zone_id uuid not null references zones(id) on delete restrict
  slug text not null                       -- URL-safe, unique per zone among non-deleted
  name text not null                       -- display name, unique per zone (case-insensitive) among non-deleted
  metadata jsonb not null default '{}'::jsonb
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()
  deleted_at timestamptz null
  unique (zone_id, id)                                  -- composite cross-tenant FK target
  unique index groups_zone_slug_idx (zone_id, slug) where deleted_at is null
  unique index groups_zone_name_idx (zone_id, lower(name)) where deleted_at is null

-- New (mirrors chapter_name_history)
chapter_group_history
  id uuid pk
  zone_id uuid not null references zones(id) on delete cascade
  chapter_id uuid not null references chapters(id) on delete cascade
  group_id uuid not null references groups(id) on delete restrict
  date_from date not null                  -- inclusive
  date_to date null                        -- null = current open segment
  created_at timestamptz not null default now()
  index (chapter_id, date_from)
  index (group_id, date_from)

-- Modified
chapters
  ...
  group_id uuid null                       -- current group pointer
  foreign key (zone_id, group_id) references groups(zone_id, id)
                                           -- composite FK enforces same-zone
  index chapters_zone_group_idx (zone_id, group_id)

zones
  ...
  groups_enabled boolean not null default false   -- one-way switch (D9)

user_role_bindings
  ...
  group_id uuid null
  role_scope text not null                 -- denormalized from roles.scope at insert
  foreign key (zone_id, group_id) references groups(zone_id, id)
  unique (user_id, zone_id, group_id, chapter_id, role_id) where revoked_at is null
  check (
    (role_scope = 'group'    and group_id is not null and chapter_id is null) or
    (role_scope = 'chapter'  and chapter_id is not null) or
    (role_scope = 'zone'     and group_id is null and chapter_id is null) or
    (role_scope = 'platform' and group_id is null and chapter_id is null)
  )

invitations
  ...
  group_id uuid null
  foreign key (zone_id, group_id) references groups(zone_id, id)
  -- same check as user_role_bindings, applied via role_code's derived scope
```

### Invariants

- **When `groups_enabled = true`:** every non-deleted chapter row has `group_id is not null` and exactly one open `chapter_group_history` segment (`date_to is null`).
- **When `groups_enabled = false`:** `chapters.group_id` may be null. Toggle from `false → true` is blocked at the service layer until every chapter has been assigned.
- **`chapters.group_id` is the "current pointer"** and always equals the `group_id` of the open history segment. Maintained transactionally by `moveChapterToGroup`.
- **Per AGENTS rule 4 ("no business logic in triggers"):** all of the above are enforced in the service layer, not via DB triggers. Per-column CHECKs and FKs catch typo-class bugs; the toggle invariant and segment invariants live in `packages/api/src/services/groups.ts`.

## 4. Roles & bindings

### 4.1 New role codes

In `packages/shared/src/roles.ts`:

```ts
export const GROUP_ROLES = {
  GROUP_ADMIN: "group_admin",
  GROUP_PASTOR_VIEWER: "group_pastor_viewer",
} as const;
export type GroupRoleCode = (typeof GROUP_ROLES)[keyof typeof GROUP_ROLES];

export type RoleCode = PlatformRoleCode | ZoneRoleCode | GroupRoleCode | ChapterRoleCode;
export type RoleScope = "platform" | "zone" | "group" | "chapter";

export function isGroupScopedRole(code: string): boolean {
  return roleScope(code) === "group";
}
```

`roleScope()` gains a `"group"` branch. `isZoneWideRole()` is unchanged (group is **not** zone-wide).

### 4.2 Seeded roles

The zone-create service seeds two new rows into `roles` for every existing and future zone:

| code | scope | name | permissions (advisory) |
|---|---|---|---|
| `group_admin` | group | Group admin | `group.read`, `chapter.read`, `chapter.write`, `member.read`, `contribution.read`, `import.read`, `report.read`, `audit.read`, `target.read`, `invitation.write` |
| `group_pastor_viewer` | group | Group pastor (viewer) | `group.read`, `chapter.read`, `member.read`, `contribution.read`, `report.read`, `target.read` |

The `chapter.write` and `invitation.write` permissions on `group_admin` are scoped to chapters in the bound group only — enforced in the API service layer, as per existing taxonomy conventions.

### 4.3 Session-context

`packages/web/src/lib/session-paths.ts` and friends gain a `groupRoles` axis:

```ts
type ZoneSession = {
  ...
  zoneRoles: ZoneRoleCode[];
  groupRoles: { groupId: string; roleCode: GroupRoleCode }[];   // NEW
  chapterRoles: { chapterId: string; roleCode: ChapterRoleCode }[];
};
```

A new derived helper centralises chapter visibility for every tenant read:

```ts
/** All chapter IDs visible to the user in this zone, regardless of source. */
function visibleChapterIds(session): string[] {
  if (session.zoneRoles.length > 0) return ALL_CHAPTERS_IN_ZONE;
  const fromGroups = chaptersInGroups(session.groupRoles.map(g => g.groupId));
  const fromChapters = session.chapterRoles.map(c => c.chapterId);
  return unique([...fromGroups, ...fromChapters]);
}
```

This helper joins through `chapters.group_id` (no denormalization, per D10) and is the single chokepoint every `/api/tenant/*` read query funnels through.

### 4.4 Invitation flow

`POST /api/tenant/invitations` accepts an optional `groupId` and enforces:

- `zone_owner` / `zone_admin` may invite any role at any scope in the zone, including `group_admin` / `group_pastor_viewer` for any group.
- `group_admin` may invite **chapter-scope roles only**, and only for chapters in their own bound group.
- `chapter_admin` is unchanged (chapter-scope only, own chapter).

The CHECK on `invitations` matches the binding CHECK in §3: group-role invites require `group_id`, chapter-role invites require `chapter_id`, others forbid both.

## 5. API surface

All `/api/tenant/*` routes already enforce zone scoping via session middleware. The changes layer on group-scope narrowing via `visibleChapterIds()`.

### 5.1 New endpoints

```
GET    /api/tenant/groups                       list groups in active zone
POST   /api/tenant/groups                       create group                       (zone_owner/admin)
GET    /api/tenant/groups/:id                   group detail + chapter count
PATCH  /api/tenant/groups/:id                   rename / slug change               (zone_owner/admin)
DELETE /api/tenant/groups/:id                   soft-delete; requires 0 chapters    (zone_owner/admin)

POST   /api/tenant/chapters/:id/move-group      body: { groupId, effectiveDate? }   (zone_owner/admin)
GET    /api/tenant/chapters/:id/group-history   list of {groupId, dateFrom, dateTo}

POST   /api/tenant/zones/groups-enabled         body: { enabled: true }             (zone_owner only)
                                                # one-way; refuses false→? and true→false
                                                # blocks if any chapter has group_id is null
```

### 5.2 Modified endpoints

| Endpoint | Change |
|---|---|
| `POST /api/tenant/chapters` | When `groups_enabled`, `groupId` is required; validated same-zone; opens initial history segment with `date_from = chapter.dateFrom` |
| `PATCH /api/tenant/chapters/:id` | Accepts `groupId` **only when `zones.groups_enabled = false`** (pre-enable assignment, see §5.3 *Pre-enable vs. post-enable*). When `groups_enabled = true`, `groupId` is rejected here — moves go through `/move-group` |
| `GET /api/tenant/chapters` | Accepts optional `?groupId=` filter |
| `POST /api/tenant/invitations` | Accepts `groupId` (required for `group_*` roles, forbidden otherwise); group_admin caller restricted as per §4.4 |
| `GET /api/tenant/administrators` | Group-tier bindings appear with `{ groupId, groupName }` |
| All read endpoints (`/members`, `/contributions`, `/imports`, `/reports`, `/targets`, `/paying-in-books`, `/audit`, `/giving-events`) | Funnel through `visibleChapterIds()`; group-tier sessions see only their group's chapters; behaviour unchanged for zone-tier and chapter-tier sessions |

### 5.3 Service-layer rules

A new service module `packages/api/src/services/groups.ts`:

- `assertGroupNameAvailable(zoneId, name, excludeGroupId?)` — case-insensitive uniqueness within zone among non-deleted groups. Mirrors `assertNameAvailable` in `services/names.ts`.
- `assertSlugAvailable(zoneId, slug, excludeGroupId?)` — same shape.
- `moveChapterToGroup({ chapterId, newGroupId, effectiveDate })` — **post-enable only**; refuses if `zones.groups_enabled = false`. Single transaction:
  1. Validate the chapter and target group belong to the same zone.
  2. Validate `effectiveDate >= currentSegment.date_from` (no rewriting earlier history; D14).
  3. If `newGroupId === chapters.group_id`, return early (no-op, no audit).
  4. Close open history segment with `date_to = effectiveDate - INTERVAL '1 day'`.
  5. Insert new segment `(chapter_id, group_id = newGroupId, date_from = effectiveDate, date_to = null)`.
  6. Update `chapters.group_id = newGroupId`.
  7. Write audit entry `chapter.group.move` carrying `{ fromGroupId, toGroupId, effectiveDate }`.
  8. Default `effectiveDate` resolves to "today" in the zone's `default_time_zone`.
- `assignChapterToGroupPreEnable({ chapterId, groupId })` — **pre-enable only**; refuses if `zones.groups_enabled = true`. Just sets `chapters.group_id = groupId` after validating same-zone. Writes audit `chapter.group.assign`. Does **not** write to `chapter_group_history` — history segments are opened in a single batch by `enableGroupsForZone`. This is the endpoint backing the pre-enable assignment affordances on `/zone/chapters` and `/zone/chapters/[id]`, and also what `PATCH /api/tenant/chapters/:id` delegates to when `groupId` is supplied.
- `enableGroupsForZone(zoneId)`:
  - Refuses if any non-deleted chapter has `group_id is null` (returns 409 with a list of unassigned chapter ids).
  - Sets `zones.groups_enabled = true`.
  - Opens an initial `chapter_group_history` segment for each chapter with `(date_from = chapter.date_from, date_to = null, group_id = chapter.group_id)` (D15).
  - Writes audit `zone.groups.enable`.
  - No "disable" function exists by design (D9).
- `softDeleteGroup(groupId)`:
  - Refuses if any non-deleted chapter has `group_id = groupId` (returns 409 with chapter count).
  - Sets `groups.deleted_at`.
  - Writes audit `group.delete`.

**Pre-enable vs. post-enable assignment.** The two write paths exist because the history table only makes sense once groups are real:

| `groups_enabled` | Write path | History? | Endpoint |
|---|---|---|---|
| `false` | `assignChapterToGroupPreEnable` | No — history segments are opened in one batch at enable time | `PATCH /api/tenant/chapters/:id` (groupId field) |
| `true` | `moveChapterToGroup` | Yes — closes open segment, opens new one | `POST /api/tenant/chapters/:id/move-group` |

Neither endpoint accepts the other's request. The `POST /api/tenant/chapters` create endpoint uses the same split: when `groups_enabled = false`, `groupId` is optional and goes straight onto `chapters.group_id` with no history row; when `groups_enabled = true`, `groupId` is required and the create transaction opens the initial history segment.

### 5.4 Audit events

```
group.create
group.update                # rename / slug change
group.delete
chapter.group.assign        # pre-enable assignment; { groupId }
chapter.group.move          # post-enable move; { fromGroupId, toGroupId, effectiveDate }
zone.groups.enable
```

All carry `actor_user_id`, `zone_id`, and relevant entity ids per existing audit conventions.

### 5.5 Validation (Zod, in `@stewardledger/shared`)

```ts
groupCreateSchema      = { name: z.string().min(1).max(100), slug: z.string().regex(SLUG_PATTERN).min(1).max(50) }
groupUpdateSchema      = { name?: ..., slug?: ... }
chapterMoveGroupSchema = { groupId: z.string().uuid(), effectiveDate?: z.string().date() }
zoneEnableGroupsSchema = { enabled: z.literal(true) }
```

`chapterCreateSchema` and `invitationCreateSchema` gain a conditional `groupId` field. Cross-checking against `zones.groups_enabled` happens in the service layer (Zod cannot read DB state).

## 6. Web UI

A new `/group/*` route group mirroring `/zone/*` narrowed to the bound group, plus changes to `/zone/*` for group management and chapter moves.

### 6.1 New `/group/*` routes

```
/group                          → redirect to /group/dashboard
/group/dashboard                aggregates for chapters in the bound group
/group/chapters                 list (read-only; no create button)
/group/chapters/[id]            chapter detail; chapter_admin-equivalent edit rights (D13)
/group/members                  members across group's chapters
/group/contributions            contributions, read-only (D7)
/group/contributions/[id]       read-only detail
/group/imports                  list + run new import (scoped to group's chapters)
/group/imports/[id]             import detail
/group/reports                  zone reports with implicit groupId filter
/group/reports/[id]             report detail
/group/audit                    audit entries for group's chapters (group_admin only)
/group/administrators           list group/chapter admins for the group; invite chapter-scope (group_admin only)
/group/targets                  read-only target list
/group/paying-in-books          scoped to group's chapters
/group/partnership-progress     scoped to group's chapters
```

**Out of `/group/*` by design:**

- `/zone/lookups` — zone-wide reference data.
- `/zone/merge` — zone-wide member-merge tool.
- Group creation / chapter-move / chapter create — those stay on `/zone/*`.

### 6.2 Modified `/zone/*`

- **`/zone/groups`** (new) — list, create, rename, soft-delete groups; per-row counts (chapters, members, admins).
- **`/zone/groups/[id]`** (new) — group detail: chapters currently in the group, group admins, recent activity.
- **`/zone/chapters`** — adds `Group` column when `groups_enabled`. Filter dropdown by group.
- **`/zone/chapters/[id]`** — adds a "Group" section showing current group and a *Move chapter to another group* action (zone_owner/admin only). History modal lists previous segments.
- **`/zone/chapters/new`** — when `groups_enabled`, the form has a required `Group` select.
- **`/zone/administrators`** — extends to group-tier bindings; invite form gains a `Group` selector when role is `group_*`.
- **`/zone/settings`** — adds a `Groups` panel:
  - If `groups_enabled = false`: shows a checklist of unassigned chapters and an "Enable groups" button, disabled until 0 unassigned. Confirmation modal warns "this cannot be undone".
  - If `groups_enabled = true`: shows the toggle as on, disabled, with a tooltip "Groups are enabled for this zone. Disabling is not supported."

### 6.3 Session routing

`resolveLandingPath()` in `packages/web/src/lib/session-paths.ts` gains a `group` tier between `zone` and `chapter`. Priority on login:

1. Has any zone-tier role → `/zone/dashboard` (unchanged).
2. **Has any group-tier role → `/group/dashboard`** (new).
3. Has any chapter-tier role → `/church/overview` (unchanged).
4. Platform admin with no tenant bindings → `/admin/zones` (unchanged).

If a user has both group-tier and chapter-tier roles in the same zone, they land on `/group/dashboard` (the broader of the two).

### 6.4 Layouts & components

- A new `+layout.server.ts` for `/group/*` loads `boundGroup` and `visibleChapterIds`. All loaders in `/group/*` resolve against `boundGroup.id`.
- A group switcher renders in the `/group/*` header when `session.groupRoles.length > 1` (D12).
- Shared chapter / member / contribution list components from `/zone/*` are factored to accept a `chapterIds` filter (most already do). Group routes pass `visibleChapterIds`; zone routes pass `null` (= all).

### 6.5 Empty / disabled states

- Zone with `groups_enabled = false`: `/zone/groups` link is hidden from nav. Direct visits show "Groups aren't enabled for this zone. Enable them in zone settings." with a button.
- Zone with `groups_enabled = true` but zero groups: `/zone/groups` shows an empty state with a "Create your first group" CTA.
- Zone with `groups_enabled = true` and ≥1 group: normal list.

## 7. Migration plan

Five sequential migrations. Migrations 1 and 3 ship together as one release (the database changes are dark — no behaviour change until §7.4).

### 7.1 Migration 1 — Schema additions (zero behaviour change)

- Create `groups` table.
- Create `chapter_group_history` table.
- Add `chapters.group_id` (nullable, with composite FK to `groups(zone_id, id)`).
- Add `zones.groups_enabled boolean not null default false`.
- Add `user_role_bindings.group_id uuid null` and `user_role_bindings.role_scope text` (denormalized scope column).
- Add `invitations.group_id uuid null`.
- Backfill `user_role_bindings.role_scope` from `roles.scope` (one-time UPDATE per existing binding).
- Add CHECK constraints to `user_role_bindings` and `invitations` (the role_scope ↔ group_id ↔ chapter_id rules from §3).

After this migration: data unchanged, `groups_enabled = false` everywhere, no group rows exist.

### 7.2 Migration 2 — Seed group roles per zone

- Insert two new rows into `roles` for every existing zone: `group_admin` and `group_pastor_viewer` (`scope = 'group'`, `is_system = true`, permissions per §4.2).
- Extend the zone-create service to insert these for new zones going forward.

After this migration: the role taxonomy is complete; no bindings yet.

### 7.3 Migration 3 — Ship the feature, dark (shipped with Migration 1)

- All new API endpoints (§5.1) live and reachable.
- `/zone/settings` Groups panel renders the "Enable groups" flow.
- `/group/*` routes exist but no session holds a group-tier binding yet, so they're effectively unreachable.
- `POST /api/tenant/chapters` still accepts requests without `groupId` (only required when `groups_enabled = true`, which is false everywhere).
- Modified read endpoints funnel through `visibleChapterIds()`, but with no group-tier bindings the behaviour is identical to today.

After this migration: zones can opt in. No existing zone is affected.

### 7.4 Migration 4 — Per-zone opt-in (operational, not a DB migration)

For each zone whose admin chooses to use groups:

1. Zone admin visits `/zone/settings` → "Groups" panel.
2. Creates one or more groups in `/zone/groups`.
3. Assigns every existing chapter to a group (the Enable button stays disabled until 0 unassigned).
4. Clicks "Enable groups" — `enableGroupsForZone` runs, validates, sets `groups_enabled = true`, writes the `zone.groups.enable` audit entry.
5. For each chapter, opens an initial `chapter_group_history` segment with `date_from = chapter.date_from` (D15) so historical reports work back to chapter inception.

After step 5 for a given zone: `groups_enabled = true`, every chapter has non-null `group_id`, every chapter has exactly one open history segment dated to inception.

### 7.5 Migration 5 — Documentation & cleanup

- Update `docs/DOMAIN-MODEL.md`: insert a new "Groups" subsection in §2 (between Chapters and Roles), renumber as needed.
- Update `docs/PRD.md` §6 (roles): document `group_admin` and `group_pastor_viewer`.
- Update `docs/ROADMAP.md` with the phase entry.
- Update `docs/DOMAIN-REFERENCE.md` line 189 to note `ChurchGroup` has been reintroduced as a first-class layer.
- Update `docs/DOMAIN-MODEL.md` §15 (line 811): remove the "ChurchGroup dropped" note; replace with a one-line "Groups are now a first-class layer; see §2.x".

### 7.6 Backward compatibility

- **Zones not opting in:** zero observable change. `groups_enabled = false`, no group roles assigned, no UI affordances in nav, all existing endpoints identical.
- **Zones opting in:** all historical contributions / members / imports are accessible via group filters from the chapter's inception date onwards (because §7.4 step 5 creates a history segment dated to `chapter.date_from`).

## 8. Testing

Tests live alongside their nearest neighbours per existing conventions. `pnpm test` already pushes the test schema and runs against Postgres.

### 8.1 Service tests — `packages/api/src/services/groups.test.ts`

- `assertGroupNameAvailable` — duplicate detection is case-insensitive; excludes soft-deleted; respects `excludeGroupId`.
- `assertSlugAvailable` — same shape.
- `assignChapterToGroupPreEnable`:
  - Refuses when `groups_enabled = true`.
  - Validates target group is same-zone (cross-zone groupId returns 400).
  - Sets `chapters.group_id`, writes audit `chapter.group.assign`, does NOT touch `chapter_group_history`.
- `moveChapterToGroup`:
  - Refuses when `groups_enabled = false`.
  - Happy path closes open segment with `date_to = effectiveDate - 1`, opens new segment, updates `chapters.group_id`, writes audit.
  - Refuses if `effectiveDate < currentSegment.date_from`.
  - Refuses if `newGroupId` belongs to a different zone (FK violation surfaced as a clean 400).
  - No-op (no audit, no history row) if `newGroupId === chapters.group_id`.
  - Default `effectiveDate` resolves to today in the zone's time zone.
- `enableGroupsForZone`:
  - Refuses if any non-deleted chapter has `group_id is null` (returns the list of offending chapter ids).
  - Idempotent: already-enabled zone returns 200 without writing a duplicate audit entry.
  - Writes audit, flips flag.
  - Opens initial `chapter_group_history` segments dated to each chapter's `date_from`, with `group_id` taken from `chapters.group_id` set during pre-enable assignment.
- `softDeleteGroup`:
  - Refuses if any non-deleted chapter has this `group_id`.
  - Sets `deleted_at`, writes audit.

### 8.2 Route tests — `packages/api/src/routes/tenant-groups.test.ts`

For each of `POST /groups`, `PATCH /groups/:id`, `DELETE /groups/:id`, `POST /chapters/:id/move-group`, `POST /zones/groups-enabled`:

- 200 for `zone_owner` / `zone_admin`.
- 403 for `group_admin`, `chapter_admin`, `zone_pastor_viewer`.
- Cross-tenant attempt (group/chapter from another zone) → 404, not 403, to avoid leaking existence.
- Validation errors return 400 with Zod issue payload.

### 8.3 Scope tests — `packages/api/src/middleware/tenant-scope.test.ts`

The `visibleChapterIds()` helper is the security chokepoint:

- Zone-tier session → returns all non-deleted chapter ids in the zone.
- Group-tier session (one binding) → returns only chapters where `chapters.group_id = boundGroupId`.
- Group-tier session (two bindings) → returns the union.
- Chapter-tier session → returns only the bound chapter id.
- Mixed group + chapter bindings → union of both.
- Session in zone A querying zone B → empty.

### 8.4 Web tests

Extend `packages/web/src/lib/session-paths.test.ts` to cover:

- Group-tier without zone-tier → landing path `/group/dashboard`.
- Group-tier + chapter-tier → `/group/dashboard`.
- Chapter-tier only → `/church/overview` (unchanged).

### 8.5 Manual E2E smoke

1. Zone admin enables groups, creates two groups, assigns chapters, invites a `group_admin`. The group_admin logs in and sees only their group's chapters across `/group/members`, `/group/contributions`, `/group/reports`.
2. Zone admin moves a chapter from group A to group B. Group A's dashboard no longer counts that chapter's giving from the move date onward; group B's does.

## 9. Out of scope

- **Cells layer.** See §10.
- **`group_finance_admin` role.** A future addition if a clear case appears for cross-chapter posting authority at group scope. The role-taxonomy slot is reserved by virtue of the schema's `group_id` axis on bindings.
- **Disabling groups for a zone.** Not supported (D9). A zone that wants to "undo groups" can soft-delete every group after moving chapters out, achieving the same end state without schema fragility.
- **Bulk chapter-move UI.** v1 ships a per-chapter move action. Bulk is a future ergonomic improvement on top of the same `moveChapterToGroup` primitive.

## 10. Future: cells (extension-point note)

A subsequent spec will add a fourth layer below chapters: a chapter contains many cells, a cell contains many members. The pattern from this spec will repeat one level down:

- `cells` table tenant-scoped via `(zone_id, chapter_id, id)` composite key.
- `member_cell_history` table mirrors `chapter_group_history` for point-in-time membership.
- Two new roles (`cell_leader`, `cell_pastor_viewer`); `cell_leader` is a chapter-tier role with a `cell_id` discriminator on the binding, analogous to how this spec adds `group_id` to bindings.
- Cell UI surfaces inside `/church/*` rather than a top-level `/cell/*` route, because a cell is part of a chapter's day-to-day operation, not a separate admin tier.

Decisions in *this* spec that preserve the cell extension point:

- We did **not** denormalize `group_id` onto `members` / `contributions` (D10). Adding `cell_id` later won't compound a fan-out problem.
- `user_role_bindings` carries `(group_id, chapter_id)` slots independently. A future `cell_id` slot is additive; no remodelling required.
- `chapter_group_history` is named for the relationship it tracks, not for either parent table — `member_cell_history` will sit cleanly alongside it.
