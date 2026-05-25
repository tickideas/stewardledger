# Phase 9 — GDPR data-subject erase workflow

Closes the last Phase 9 exit criterion: *"An 'erase' request can
be applied with full audit and reversibility window."*

Depends on:

- The retention-policy task (the per-zone `retention_policy.member_soft_deletes`
  window becomes the reversibility window for member-level erases).
- The export-bundle task (a zone-wide erase is implemented as
  *export then destroy*; both flows share infrastructure).

## Two erase flavours

GDPR Article 17 covers two real-world cases for us:

1. **Member-level erase** — a single data subject (a partner /
   member) asks to be forgotten. The contribution ledger stays
   intact (it's immutable financial data with a separate legal
   basis), but every direct PII field on the member row is
   scrubbed. The merge / soft-delete plumbing in Phase 3 is the
   foundation; this task adds the *scrub* on top.

2. **Zone-level erase** — a tenant cancels the contract and
   asks for full deletion. We export-then-scrub: the zone owner
   pulls a bundle (`zone-export-bundle` task), confirms they
   have it, then triggers a zone-erase that soft-deletes the
   zone, schedules a hard-purge for the end of the reversibility
   window, and goes through with it unless the owner cancels.

Both flavours share a single `erasure_requests` table + the
audit pattern; the destination of the scrub is the difference.

## Schema

New migration `0020_erasure_requests.sql`:

```sql
CREATE TABLE erasure_requests (
  id            text PRIMARY KEY,
  zone_id       text NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('member', 'zone')),
  /** For scope='member', the member row to scrub. NULL for 'zone'. */
  member_id     text REFERENCES members(id) ON DELETE SET NULL,
  requested_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  /** "member-supplied written request" / "owner-supplied cancellation". */
  reason        text,
  /**
   * pending  → in the reversibility window; can be cancelled.
   * applied  → window elapsed, scrub executed.
   * cancelled→ owner / admin pulled it back before the window closed.
   * failed   → scrub raised; needs operator attention.
   */
  status        text NOT NULL CHECK (status IN ('pending','applied','cancelled','failed')),
  reversibility_window_days integer NOT NULL,
  applies_at    timestamptz NOT NULL,
  applied_at    timestamptz,
  cancelled_at  timestamptz,
  cancelled_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  error_code    text,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX erasure_requests_zone_status_idx
  ON erasure_requests (zone_id, status, applies_at);
CREATE UNIQUE INDEX erasure_requests_zone_member_pending_uidx
  ON erasure_requests (zone_id, member_id)
  WHERE status = 'pending' AND member_id IS NOT NULL;
```

The partial unique index prevents two parallel pending requests
for the same member. A second request supersedes the first
(cancel first, then create) — explicit in the service layer.

## Reversibility window

- Default: 14 days for both scopes.
- Member-level: pulled from
  `zones.retention_policy.member_soft_deletes.retainDays` when
  >0; if `retainDays === 0` (the v1 default of "never purge"),
  the member-erase flow uses 14 days as the explicit override.
  An admin can set the policy to 7 / 14 / 30 etc. to control
  the default for new requests.
- Zone-level: always 14 days. Zone destruction is one-shot;
  the policy column doesn't move it.

## What gets scrubbed

### Member-level (scope='member')

Targeted PII fields on `members`:

```
first_name → 'erased'
middle_names → null
last_name → null
gender → null
email → null
date_of_birth → null
mobile → null
telephone → null
kingschat_username → null
metadata → '{"erased_at":"<iso>","request_id":"<id>"}'
deleted_at → now()  (if not already soft-deleted)
```

And on `addresses` for the same member: every row hard-deleted.
The `members.reference_code`, `members.chapter_id` and
`members.created_at` stay so the contribution ledger still
joins (the FK is `restrict`).

The `contributions.member_id` link stays — the contribution is
the system of record for the donation, the member row becomes
"Erased member #ref" on the screen. Per ROADMAP §9 we cannot
hard-delete an audit-bearing row, and the financial record is
the legitimate-interest counter-balance to the erase right.

### Zone-level (scope='zone')

- Sets `zones.deleted_at = now()` and `zones.status =
  'suspended'`. The tenancy middleware already refuses
  `suspended` zones from authenticated traffic (Phase 10
  past-due plumbing); this reuses that gate.
- Schedules the hard-purge job (below) for
  `created_at + reversibility_window_days`.
- Hard-purge runs: `DELETE FROM zones WHERE id = $1` (every
  zone-scoped table is `ON DELETE CASCADE`; the immutable
  ledger goes with it because the zone owns it). Storage
  cleanup: list every blob under `{zoneId}/` and delete.

## Audit

Every state transition writes an audit row. Member-scoped
events carry `zone_id`; zone-scoped events are platform-scope
(`zone.erase.scheduled` becomes `platform.zone.erase.scheduled`
for the `zone.deleted_at = now()` write because by the time
the hard-purge fires the zone is already terminal).

Actions:

- `member.erase.scheduled` (tenant-scope; member_id in entityId)
- `member.erase.cancelled` (tenant-scope)
- `member.erase.applied` (tenant-scope; before = full row
  pre-scrub for the audit-truth requirement)
- `platform.zone.erase.scheduled` (platform-scope; entityType
  = 'zone', entityId = zoneId)
- `platform.zone.erase.cancelled`
- `platform.zone.erase.applied` (last write *to* `audit_events`
  for this zone — the row itself is then deleted by the
  CASCADE; the audit log of the erase lives outside the zone
  because the platform-scope rows have `zone_id IS NULL` and
  are exempt from the CASCADE).

## Service layer

New module `packages/api/src/services/erasure/`:

- `requests.ts` — `createErasureRequest({db, zoneId,
  actorUserId, scope, memberId?, reason?, windowDays?})`,
  `cancelErasureRequest`, `applyErasureRequest`, `listErasureRequests`.
  Each writes its audit row.
- `scrub-member.ts` — pure function that takes a member row and
  returns the scrubbed shape. Used by the apply path and by
  unit tests.
- `scrub-zone.ts` — orchestrates the zone-level hard-purge.
- `cron.ts` — pg-boss daily schedule `erasure.apply.sweep` at
  `0 5 * * *` (one hour after retention sweep). Selects every
  `pending` row with `applies_at < now()` and applies them.
  Per-row exceptions land the row in `failed` and write the
  audit row; the loop continues.
- `*.test.ts` — every flow covered.

## Routes

New endpoints:

- `POST /api/tenant/members/:id/erasure-requests` — schedule a
  member-level erase. Body `{ reason?: string, windowDays?:
  number }`. Owner / admin / finance_admin only (PII control).
- `DELETE /api/tenant/erasure-requests/:id` — cancel a pending
  request. Same roles.
- `GET /api/tenant/erasure-requests` — list (paginated) all
  requests for the zone with filters (`status`, `scope`).
- `POST /api/tenant/zones/erasure-requests` — schedule a
  zone-level erase. Body `{ confirmExportId: string }` —
  required, must reference a `completed` `zone_exports` row
  owned by the same zone created within the last 7 days. We
  refuse to schedule a zone-erase without a recent export
  (acceptance criterion: the owner cannot hose the zone
  without a take-with-them artefact). `zone_owner` only.

A platform-admin parallel exists at
`/api/admin/zones/:slug/erasure-requests` so a `super_admin`
can act on behalf of an owner who has lost access (e.g. an
abandoned tenant). Same body + confirm-export gate. Default
window unchanged.

## UI

### Member-level

On `/zone/members/[id]/+page.svelte`, add a "Privacy" panel:

- Read-only summary of any open erasure request (status,
  applies_at, "Cancel request" button gated on role).
- "Request erasure" button — opens a modal that captures the
  reason and the window (default 14, capped at the zone's
  policy if higher).
- After scrubbing applies, the page renders an "Erased member
  — record #ref" banner with no PII visible.

### Zone-level

New panel on `/zone/settings/+page.svelte` (the page from the
retention-policy + export-bundle tasks), titled "Decommission
this zone":

- Red-bordered card. Subtitle: "Permanently delete this zone
  and every record it contains. Requires a recent export."
- The button is disabled until the loader confirms a
  `zone_exports` row with `status='completed'` created within
  the last 7 days.
- Pressing the button opens a confirm modal that:
  - Re-types-the-zone-slug to confirm.
  - Shows the `applies_at` calculation ("This will permanently
    delete every record on Apr 28, 2026 at 14:32 UTC unless
    cancelled before then.").
  - Captures an optional reason.
- After scheduling, the panel renders the open request with a
  prominent "Cancel deletion" button.

## Files

New:

- `packages/db/drizzle/0020_erasure_requests.sql`
- `packages/db/src/schema/erasure-requests.ts`
- `packages/api/src/services/erasure/{requests,requests.test,
  scrub-member,scrub-member.test,scrub-zone,scrub-zone.test,
  cron,cron.test}.ts`
- `packages/api/src/routes/tenant-erasure.ts`
- `packages/api/src/routes/tenant-erasure.test.ts`
- `packages/api/src/routes/admin-erasure.ts`
- `packages/api/src/routes/admin-erasure.test.ts`
- `packages/web/src/lib/erasure/access.ts` + `access.test.ts`
- `packages/web/src/routes/zone/members/[id]/erasure-modal.svelte`
- `packages/web/src/routes/zone/settings/decommission-card.svelte`

Modified:

- `packages/api/src/routes/tenant.ts` — mount the new router.
- `packages/api/src/server.ts` — boot the erasure schedule.
- `packages/web/src/routes/zone/members/[id]/+page.svelte` —
  Privacy panel.
- `packages/web/src/routes/zone/settings/+page.svelte` —
  Decommission card (alongside retention + export panels).
- `packages/web/src/routes/admin/zones/[slug]/+page.svelte` —
  super-admin parallel of the decommission flow.
- `docs/ROADMAP.md` — flip the Phase 9 GDPR deliverable + exit
  criterion to done.
- `docs/DOMAIN-MODEL.md` — append §16 "Erasure" subsection
  documenting the scrub fields, the reversibility window, and
  the zone-level CASCADE behaviour.
- `docs/PRD.md` §7.x — drop the "(later)" qualifier from the
  GDPR-aware export / deletion line.

## Tests

API:

- `requests.test.ts` — create, cancel, list, status
  transitions, role gates, double-pending rejection.
- `scrub-member.test.ts` — pure function: every PII field
  asserted scrubbed; non-PII fields untouched; address rows
  deleted; the metadata erasure marker written.
- `scrub-zone.test.ts` — seeded zone fixture: schedule →
  applies_at elapses → cron runs → every zone-scoped table
  empty for that zone, every blob under `{zoneId}/` gone, the
  platform-scope audit rows still present.
- `cron.test.ts` — multi-zone fixture: one pending row past
  due, one not; cron applies only the first.
- `tenant-erasure.test.ts` — zone-erase requires a recent
  export; without one, 422 `recent_export_required`.

Web:

- `erasure/access.test.ts` — predicate matrix.

End-to-end:

- Round-trip: schedule member erase → cancel → schedule again
  → run cron → assert scrubbed shape + ledger integrity (the
  contribution still totals the same per-currency amount, just
  attributed to "Erased member #ref").
- Zone erase + restore-bundle: schedule, run cron, restore the
  pre-erase export into an empty schema, every row recovered.
  This is the *reversibility* test for the zone scope and the
  capstone for the exit criterion.

## Non-goals (deferred)

- Per-field selective erasure (v1 is all-or-nothing PII scrub
  for the member scope).
- Encrypted "tombstone" of the pre-scrub member row for
  short-window investigative use (the platform audit `before`
  payload is the surrogate).
- A self-service member portal where the member can request
  their own erasure (Phase 14 — the v1 path is the zone owner
  / admin actioning a written request).
- Cascading erasure across multiple zones for the same email
  identity — out of scope; each zone is its own legal basis.
- Automatic erasure proposals from the GDPR-request inbox
  (the inbox doesn't exist yet; the v1 path is API + UI
  trigger).
- Right-to-rectification and right-to-restriction workflows
  (the member-edit + soft-delete primitives cover both
  today).

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- A `zone_owner` can schedule, see, and cancel a member-level
  erase from `/zone/members/[id]`.
- A `zone_owner` cannot schedule a zone-level erase without a
  `completed` `zone_exports` row from the last 7 days.
- After the reversibility window elapses + the cron fires, the
  member row is PII-scrubbed but contributions still total the
  same per-currency figure.
- After a zone-level erase fires, the zone is gone from
  `/admin/zones`, every blob under `{zoneId}/` is gone, and
  the audit log on `/admin/audit` shows the full lifecycle.
- The pre-erase export can be restored into a clean schema and
  reproduces the pre-erase state byte-for-byte.
- ROADMAP Phase 9 *"GDPR data subject request workflow (export
  and erase)"* deliverable and its exit criterion both ticked
  → Phase 9 closed.
