# Partnership progress — dashboard

## What

A bespoke dashboard at `/zone/partnership-progress` that reads the
existing `partnership-progress` report and renders it as a card-based
target-vs-achieved view rather than a tabular row dump. Each card
covers one chapter (or "Zone-wide targets" for chapter_id-null rows);
inside the card, each (giving-type, currency) target gets a progress
bar plus achieved / target / weekly-average / projected-EOY figures.

Ministry-year picker defaults to the year whose [start, end] window
contains today; a chapter filter and a giving-type filter narrow the
view further. The card layout falls back to the standard reports
surface for export (`Download .xlsx` button hits the same
`/api/tenant/reports/partnership-progress/export.xlsx` endpoint).

## Why

Partnership progress is the marquee Phase 8 surface — chapters set
ambitious targets at the start of the ministry year and want a
glanceable "where are we?" view. The tabular report is faithful to
the spec but doesn't tell the visual story. A bespoke dashboard adds
zero new server endpoints; it just composes the existing report data
into a more digestible layout.

## Files

- `packages/web/src/lib/partnership-progress/url.ts` — query-string
  builder (empty filters dropped so `chapterId=` doesn't 400 the
  server).
- `packages/web/src/lib/partnership-progress/url.test.ts` — happy +
  rejection-path coverage.
- `packages/web/src/routes/zone/partnership-progress/+page.svelte` —
  the dashboard page.
- `packages/web/src/lib/nav.ts` — adds the sidebar entry under
  "Insight".

## Out of scope

- Multi-year comparison (Phase 9 / Phase 10).
- Per-partner drill-down (the top-partners report covers that).
- A "trend over time" chart — needs a separate aggregation route
  per week / month; deferred.

## Visual contract

- Progress bar width caps at 100% visually; the textual `% progress`
  carries the true value (which the report already caps at 999.9%).
- Bar color: `var(--bad)` < 33% < `var(--ink-mute)` < 66% <
  `var(--brass)` < 100% ≤ `var(--brass-deep)`.
- Currency is rendered with `Intl.NumberFormat('currency', code)`
  per row, so a target denominated in NGN doesn't get rounded
  through a GBP locale default.
