# Financial targets — UI

## What

A zone-side UI at `/zone/targets` that lists, creates, edits, and
deletes financial targets (a per-(chapter | zone-wide, ministry-year,
giving-type, currency) goal). Wires the existing `/api/tenant/targets`
endpoints to a screen that follows the same pattern as the
paying-in-books UI:

- Filter bar (chapter / ministry year / giving type / zone-wide only).
- `PAGE_SIZE + 1` probe pagination so an exact-multiple total doesn't
  surface a phantom Next button.
- Race-safe `refreshToken` guard so an aborted fetch can't flip
  `loading` off while a newer fetch is in flight.
- Role-aware writes via an extracted predicate in
  `lib/targets/access.ts` (zone-write roles can write any chapter +
  zone-wide; chapter-admin can write only their bound chapters and
  cannot write zone-wide rows; treasurer is never a writer).

A small read-only periods endpoint
`/api/tenant/periods/ministry-years` powers the ministry-year
dropdown; the partnership-years sibling endpoint comes along for
free for the partnership-progress dashboard's year filter.

## Why

Targets are the input side of the partnership-progress report. Before
this UI shipped, the only way to populate `financial_targets` was a
direct DB insert or the API endpoint. A zone owner / finance admin
needs a normal CRUD screen to maintain a year's targets.

## Files

- `packages/api/src/routes/tenant-periods.ts` — read-only periods
  router (ministry years + partnership years) mounted under
  `/api/tenant`.
- `packages/api/src/routes/tenant-periods.test.ts` — happy + rejection
  + cross-tenant fuzz for both endpoints.
- `packages/api/src/routes/tenant.ts` — mounts the new router.
- `packages/web/src/lib/targets/access.ts` — extracted role-aware write
  predicate.
- `packages/web/src/lib/targets/access.test.ts` — happy + rejection-path
  vitest cases (zone-write writes any; chapter-admin writes own
  chapters only; chapter-admin can't write zone-wide; treasurer
  never; null rejects).
- `packages/web/src/routes/zone/targets/+page.svelte` — the CRUD page.
- `packages/web/src/lib/nav.ts` — adds the sidebar entry under
  "Giving".

## Out of scope

- Partnership-progress dashboard surface — separate PR. The
  partnership-progress report already exists in the registry; this
  PR just unblocks data entry.
- Bulk import of targets from CSV. Targets are low-volume (handful
  per chapter per year) so a row-at-a-time UI is enough for now.
