# Phase 8 — Paying-in books UI

First of three Phase 8 UI PRs (paying-in books → target setup →
partnership-progress dashboard). Starts with paying-in books
because it's the simplest CRUD form: chapter dropdown, two text
inputs for code range, two date inputs. No chart, no
aggregation.

## Scope

One SvelteKit page at `/zone/paying-in-books` with:

- List of books in the zone, ordered by chapter ref then
  dateFrom, with an "Active on date" filter input.
- Inline create form (chapter dropdown, code-range pair, date
  range). Disabled when the caller can't write.
- Per-row "Edit" affordance that flips the row into edit mode,
  hits PATCH on save, returns to read mode.
- Per-row "Delete" with confirm dialog.
- Visibility / write-gating mirrors the API: any zone reader
  can view (chapter readers see their chapters' rows only);
  zone-finance / zone-admin / zone-owner can write any row;
  chapter-admin can write their chapters' rows.

Sidebar entry under "Giving" (between Contributions and
Imports, since paying-in books are the operator's deposit-slip
pads).

## Non-goals (deferred)

- **Target setup UI** — next PR.
- **Partnership-progress dashboard** — PR after that.
- **Overlap warnings between books** — the schema permits
  overlap; the UI could flag overlapping ranges in a future
  iteration, not in this PR.
- **Bulk import of book ranges** — a treasurer enters one pad
  at a time; bulk import via the existing CSV import pipeline
  is out of scope.

## Files

- `packages/web/src/routes/zone/paying-in-books/+page.svelte` —
  new page.
- `packages/web/src/lib/nav.ts` — sidebar entry under "Giving".
- `packages/web/src/routes/zone/paying-in-books/page.test.ts`
  — happy-path component test (form submit, list refresh,
  edit flow, delete confirm). Optional — defer if the existing
  Phase-7 reports surface doesn't have analogous component
  tests.

## Acceptance

- `pnpm lint`, `pnpm check` green.
- `/zone/paying-in-books` lists existing books in scope.
- Create form posts and refreshes the list.
- Sidebar entry present under "Giving".
- ROADMAP.md Phase 8 status block notes the UI side is now
  partial (paying-in books done; target setup + partnership
  dashboard pending).
