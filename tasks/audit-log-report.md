# Phase 7 — Audit log report

Implements REPORTS.md §2.13. Reads the existing `audit_events` table;
no new schema. Surfaces an admin-facing trail of zone-scoped writes
with actor / action / entity / before-after-diff payloads, exported
to Excel.

## MVP scope

One spec, registered, route-exposed, UI-driven, Excel-exportable.

### Filters

- `dateFrom`, `dateTo` (required, ISO yyyy-mm-dd, `dateFrom <= dateTo`)
  — applied against `audit_events.occurred_at` (date semantics: the
  `dateFrom` boundary uses `>= start-of-day`; the `dateTo` boundary
  uses `< next-day` so the full day is inclusive even though the
  column is `timestamptz`).
- `actorUserId` (optional `user.id` — Better Auth uses text ids, so
  no `uuidSchema`; a plain non-empty string filter is enough).
- `entityType` (optional string — free-form because services
  register their own values, e.g. `member`, `member_address`,
  `contribution`, `import_job`).
- `entityId` (optional string — domain ids vary; some are uuids,
  some `text` Better Auth ids).
- `action` (optional string — same reasoning as entity type).

No `chapterId` filter: `audit_events` has no chapter column. Row-
level chapter scoping is intentionally not attempted in v1; the
report is **admin-only** (zone admin / owner / auditor read, zone
admin + owner export, no chapter-tier access). That mirrors the
intent of REPORTS.md §2.13 ("admin-facing").

### Rows / columns

One row per audit event, ordered by `occurred_at desc, id desc`
(stable secondary sort for ties — events written in the same
transaction can share a microsecond). Columns:

- `occurredAt` (datetime)
- `actorEmail` (text — looked up via `user` join; PII)
- `actorRoleCode` (text)
- `action` (text)
- `entityType` (text)
- `entityId` (text)
- `reason` (text)
- `before` (text — JSON-stringified)
- `after` (text — JSON-stringified)

`before` / `after` ship as JSON strings because the on-screen UI
renders them as monospace text and the Excel cell is plain text
too. A full diff renderer is deferred to a later iteration; the
raw JSON is the audit invariant most auditors actually want.

### Access

- READ: admin tier only (owner / admin / finance_admin). The
  report surfaces every actor's edits across the zone, which is
  sensitive even read-only — viewer roles (zone_auditor /
  zone_pastor_viewer) and any chapter-scoped role are denied via
  a spec-level `accessCheck`. This matches REPORTS.md §2.13
  ("admin-facing").
- EXPORT: existing `canExportReports` gate — owner / admin /
  finance_admin. Equivalent to READ here.
- **No row-level chapter clamp.** The events stream is zone-wide
  by design.

### Excel

- Branded header via `addBrandedSheet`.
- Every text cell routed through `escapeExcelText` — actor email
  and reason are user-controlled.
- No money columns; no subtotals; no per-currency footer.

### Subtotals / counts

Surface `meta.eventCount` (a single integer) so the UI can show
"N events" without re-counting on the client. No money totals.

## Non-goals (deferred)

- PDF (Phase 7-wide).
- Structured before/after diff rendering (today: raw JSON string).
- Stream / paginate for >100k rows — the dataset is zone-scoped
  and date-bounded; the filter is the throttle.
- Saved filters.
- Chapter-tier access (the report has no chapter dimension).

## Files

- `packages/api/src/services/reports/audit-log.ts` — new spec
- `packages/api/src/services/reports/registry.ts` — register
- `packages/api/src/services/reports/reports.test.ts` — coverage
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  SHAPES entry (new `actorUserId`, `entityType`, `entityId`,
  `action` text inputs).
- `packages/api/src/routes/tenant-reports.test.ts` — bump the
  registry list assertion to include `audit-log` (now 11
  reports).
- `docs/REPORTS.md` — flip §2.13 status to Done with file path.
- `docs/ROADMAP.md` — bump Phase 7 audited-status block.

## Tests (vitest, inside `describe("audit-log report")`)

1. **Happy path** — seeds 3 audit events via the existing
   `writeAudit` service helper (different actions / entities),
   fetches across a wide date window, expects 3 rows in
   `occurred_at desc` order and `meta.eventCount = 3`. Excel
   renders end-to-end and the branded header lands at A1.
2. **Filters compose** — same dataset, filter by `entityType`
   keeps only matching rows; filter by `action` does the same.
3. **Date window clamps** — events outside the window are
   excluded.
4. **Chapter-scoped caller denied** — a chapter treasurer's
   `accessCheck` returns `"forbidden"` (zone roles required).
5. **Cross-tenant isolation** — events in another zone don't
   leak through.
6. **Formula-injection escape** — write an audit event whose
   `reason` starts with `=HYPERLINK(...)`; the Excel cell
   begins with `'=`, never just `=`.

The route-list assertion in `tenant-reports.test.ts` gets bumped
to 11 ids and includes `"audit-log"` — the canonical "did you
register it" signal.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- `/zone/reports` lists "Audit log".
- Roadmap audited-status block updated.
- REPORTS.md §2.13 status flipped to Done.
