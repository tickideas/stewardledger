# Giving + service settings

## Context

The current backend already has tenant-scoped setup APIs for giving categories,
giving types, accounts, payment methods, service types, and service events:

- `GET/POST/PATCH /api/tenant/giving/types`
- `GET/POST/PATCH /api/tenant/giving/service-types`
- `GET/POST/PATCH /api/tenant/giving/service-events`
- `GET/PUT /api/tenant/giving/service-events/:id/attendance`

The gap is that these setup objects are not surfaced as normal settings
workflows. Treasurers also see unclear copy on the new batch page:
"Open the Sunday close" does not explain that this is the post-counting
offering batch workflow. Service event selection is currently optional on
the batch form, and import uploads do not collect a service event even though
`import_rows.service_event_id` exists and committed contributions can carry it.

## MVP Goal

Create a clear settings workflow for:

- Zonal admins managing giving categories so reporting groups are not hidden
  seed data.
- Zonal admins managing giving types and service types for the zone.
- Church admins creating giving types their chapter needs to record, while
  keeping the resulting giving type zone-scoped for reporting consistency.
- Church admins managing chapter service events used by contribution batches
  and imports.
- Church admins recording attendance against service events as part of the
  same service setup workflow.
- Treasurers creating batches with copy that matches the real workflow:
  counted offerings are being recorded, reviewed, and later posted.
- Church-scoped batch/import flows requiring a service event before posting
  money into the ledger.

## Reasoning

Giving types are zone-owned because they drive reports, import matching,
accounts, partnership targets, and cross-chapter consistency. A church admin
can add the giving types they need through the same tenant API, but the
resulting row still belongs to the zone.

Service types are zone-owned labels such as "Sunday service", "Midweek
service", or "Special programme". Service events are occurrences of a service
type on a date, optionally scoped to a chapter. Church users should manage
their own chapter's service events; zone users can manage all service events.

The least risky MVP is to reuse the existing APIs and add focused UI surfaces,
then tighten the batch/import flows once event creation is available from
the settings page.

## Proposed Surfaces

### Zone: `/zone/giving-settings`

Sidebar: add under `Settings` or under `Giving` as `Giving settings`.

Sections:

- Giving categories table and create form, including parent category selection.
- Giving types table and create form.
- Service types table and create form.
- Optional read-only/service-event overview filtered by chapter and date.

Writes:

- Use existing zone write roles from `GIVING_WRITE_ROLES`.
- Preserve audit events already emitted by the API.
- Extend write policy so chapter admins can create giving types. These rows
  remain zone-scoped and visible to the rest of the zone.

### Church: `/church/settings`

Add sections to the existing chapter settings page:

- Service events: create upcoming/recent events for the active chapter.
- Service attendance: record/update attendance counts on a service event.
- Giving types: show active zone giving types and provide an add form for
  chapter admins.

Writes:

- Service events already support chapter-scoped writes via
  `CHAPTER_GIVING_WRITE_ROLES`.
- Giving types currently use zone-only `GIVING_WRITE_ROLES`; extend this
  deliberately for chapter admins while keeping cross-tenant checks and audit.

## Batch Workflow Changes

Route: `packages/web/src/routes/zone/contributions/batches/new/+page.svelte`

- Rewrite title/body copy from "Open the Sunday close" to language about
  recording counted offerings for a service.
- Rename the action from `Create batch` to something clearer like
  `Start batch`.
- Make `serviceEventId` required for all batch creation, including zone admins.
- Keep a clear empty state when no service event exists: link to
  `/church/settings` for church users and `/zone/giving-settings` for zone
  users.

## Import Workflow Changes

Routes:

- `packages/web/src/routes/zone/imports/+page.svelte`
- `packages/web/src/routes/church/imports/+page.svelte`
- `packages/api/src/routes/tenant-imports.ts`
- `packages/api/src/services/imports/index.ts`
- `packages/api/src/services/imports/match.ts`

MVP:

- Church import page: require a service event selector for the active chapter.
- Zone import page: if a specific chapter is selected, allow selecting one of
  that chapter's service events.
- Zone-wide file-with-chapter-column imports should support row-level service
  event matching through CSV columns so each row can select the relevant
  service event.
- API: accept `serviceEventId` in the upload metadata and validate it belongs
  to the same zone and, when `chapterId` is set, the same chapter.
- Parser/matcher: support service event CSV aliases for row-level event
  matching, resolving by service event id or a stable combination such as
  chapter + service date + service type.
- Matching/persistence: propagate the selected `serviceEventId` to matched
  import rows so committed contributions inherit it.
- Idempotency: include `serviceEventId` in the upload dedupe key only if it
  changes matcher/commit semantics. Because the same bytes for the same chapter
  but a different service event should produce a distinct job, this likely
  requires adding `service_event_id` to `import_files` or otherwise including
  it in the checksum uniqueness context.

## Task List

- [x] Confirm role policy for chapter-admin-created giving types.
- [x] Add route and nav entry for `/zone/giving-settings`.
- [x] Add category management to `/zone/giving-settings`.
- [x] Build zone settings UI for giving types and service types using
  existing `sl-*` primitives.
- [x] Add service-events panel to `/church/settings`.
- [x] Add service attendance panel to `/church/settings`.
- [x] Add giving-types panel to `/church/settings`.
- [x] Extend giving-type API permissions so chapter admins can create giving
  types and test the rejection paths.
- [x] Update new batch copy and require service event for church-scoped flow.
- [x] Add service event selection to church imports and selected-chapter zone
  imports.
- [x] Add row-level service event matching for zone-wide imports.
- [x] Extend import upload API/service layer to accept and validate
  `serviceEventId`.
- [ ] Add tests for happy and rejection paths:
  - chapter admin can create own chapter service event;
  - chapter admin cannot create another chapter's event;
  - chapter admin can create a giving type;
  - unauthorized roles cannot create giving types;
  - batch create rejects missing event for all roles;
  - church import upload rejects missing event;
  - import upload rejects cross-chapter/cross-tenant event id;
  - zone-wide import resolves row-level service events;
  - committed import contribution carries the selected event id.
- [x] Update `docs/ROADMAP.md` and, if role policy changes, `docs/PRD.md` or
  `docs/DOMAIN-MODEL.md`.

## Acceptance Criteria

- A zone admin can create and deactivate giving types and service types from
  a normal settings page.
- A zone admin can create and deactivate giving categories from the same
  settings page, including assigning a parent category.
- A church admin can create giving types from chapter settings, and those
  types are audited and available to the zone.
- A church admin can create service events for their active chapter.
- A church admin can record service attendance for a service event.
- Batch creation copy clearly describes the counted-offering workflow.
- Batch creation cannot proceed without a service event.
- Church-scoped import upload cannot proceed without a service event.
- Import-committed contributions retain the selected service event.
- Cross-tenant and cross-chapter service event ids are rejected server-side.
- Zone-wide imports can resolve service events per row.

## Open Questions

- Resolved: chapter admins can directly create giving types.
- Resolved: zone admins cannot create a contribution batch without a service event.
- Resolved: zone-wide imports should support row-level service event matching.
- Resolved: service event attendance is part of this settings MVP.

## Progress Notes

- Created plan after reviewing existing giving APIs, schema, church settings,
  import commit path, and new batch flow.
- Captured product decisions: chapter-admin giving type creation, service
  event required for all batches, row-level service event matching for
  zone-wide imports, and attendance in MVP.
- Implemented backend enforcement for required batch service events, chapter-admin giving type creation, import-level service events, and row-level service event matching.
- Added `/zone/giving-settings`, service/giving setup panels on `/church/settings`, required service-event selectors for imports, and clearer counted-offering batch copy.
- Added giving category management to `/zone/giving-settings` so admins can
  create reporting groups, assign parent categories, and activate/deactivate
  categories before creating giving types.
- Updated roadmap, PRD, and domain model notes for role policy, import service-event metadata, and attendance.
