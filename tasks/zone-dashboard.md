# Phase 7 — Zone dashboard (REPORTS.md §2.15)

Currently `/zone` redirects to `/zone/chapters` because there's
no zone-level landing surface. This task ships a real zone-wide
dashboard at `/zone/dashboard` with a single server-aggregated
endpoint and a card-based UI that drill-links into the existing
reports.

Chapter dashboard (§2.14) is a sibling task and reuses the same
backend pattern; queued separately so this PR stays small.

## MVP scope

One JSON endpoint, one Svelte page, sidebar entry, vitest
coverage.

### Endpoint

`GET /api/tenant/dashboard/zone` → returns a single payload of
aggregate cards, scoped to the caller's bindings.

Access:

- Any zone reader (owner / admin / finance_admin / auditor /
  pastor_viewer) — same as `canReadReports`.
- Chapter-only callers are denied at the route handler (the
  dashboard is zone-wide by intent; chapter-scoped users get the
  chapter dashboard later).
- No export tier — the dashboard is screen-only. Drill-link CTAs
  hand the user off to the existing report exports when they want
  Excel.

Payload (single response, computed in parallel against `db`):

```
{
  asOf: ISO-datetime,           // when the payload was rendered
  chapters: { total: number, active: number },
  members: { total: number, active: number, inactive: number },
  monthlyGiving: {              // current calendar month, posted only
    periodStart: ISO-date,
    periodEnd: ISO-date,
    perCurrency: [{ currencyCode, total: "decimal-string" }],
  },
  yearToDateGiving: {           // calendar year-to-date, posted only
    periodStart: ISO-date,
    periodEnd: ISO-date,
    perCurrency: [...],
  },
  topChapters: [                // top 5 by current-month giving
    { id, referenceCode, name, currencyCode, total }
  ],
  topPartners: [                // top 5 members by current-month giving
    { id, referenceCode, name, chapterReferenceCode, currencyCode, total }
  ],
  recentImports: [              // 5 most recent import jobs
    { id, fileName, status, committedAt, postedCount, perCurrency: [...] }
  ],
}
```

Notes:

- "Current month" is the calendar month in UTC. v1 doesn't track
  zone timezone for dashboards; consistent with the audit-log
  date semantics.
- All money is per-currency; the dashboard never silently FX-
  converts (DOMAIN-MODEL §6).
- Top-chapters / top-partners reuse the same aggregation shape as
  the standalone reports (rank by total, per currency) but only
  carry the top 5 since this is a glance view.

### UI

`packages/web/src/routes/zone/dashboard/+page.svelte`:

- 4 stat tiles in a 4-column grid: Chapters (total / active),
  Members (total / active), This month (per-currency sums),
  Year-to-date (per-currency sums).
- Two compact tables side-by-side: Top chapters · this month,
  Top partners · this month. Each row links to the relevant
  drilldown (chapter detail page, member detail page).
- Recent imports list with status pills.
- CTA strip at the bottom linking to the full reports surface.

`packages/web/src/lib/nav.ts`:

- Add `{ href: "/zone/dashboard", label: "Dashboard" }` as the
  first item in the "Insight" group.

`packages/web/src/routes/zone/+page.svelte`:

- Update the redirect to land on `/zone/dashboard` instead of
  `/zone/chapters`. Chapters remain reachable via the sidebar.

## Non-goals (deferred)

- **Chapter dashboard** (§2.14) — next PR. Same payload shape,
  scoped to one chapter; the existing `/church/overview` page is
  the launch surface.
- **Target progress / partnership progress cards** — both depend
  on Phase 8 financial targets.
- **Trend sparklines** — defer to a follow-up that adds a single
  `monthlyTrend: { perCurrency: [{ month, total }] }` block.
- **Configurable date range** — the dashboard is "now"; the
  detailed reports already accept ranges.
- **Saved layouts / pinned cards** — out of scope.

## Files

- `packages/api/src/services/dashboards/zone-dashboard.ts` —
  new aggregation service. Splits cleanly from reports/ because
  the output shape isn't a `ReportSpec<F, R>` (no Excel, no
  tabular rows — a single dashboard payload).
- `packages/api/src/services/dashboards/zone-dashboard.test.ts` —
  hand-curated dataset tying out chapters / members / monthly
  giving / top-chapters / top-partners / recent imports.
- `packages/api/src/routes/tenant-dashboard.ts` — new router
  exposing `GET /api/tenant/dashboard/zone`. Mounted from
  `tenant.ts`.
- `packages/api/src/routes/tenant-dashboard.test.ts` — route
  access tests (zone reader allowed, chapter-only denied, cross-
  tenant denied).
- `packages/web/src/routes/zone/dashboard/+page.svelte` — new
  Svelte page.
- `packages/web/src/routes/zone/+page.svelte` — redirect to
  `/zone/dashboard`.
- `packages/web/src/lib/nav.ts` — sidebar entry.
- `docs/ROADMAP.md` — flip "zone dashboard" bullet under
  Phase 7.
- `docs/REPORTS.md` — flip §2.15 status to Done with file path.

## Tests (vitest)

### `describe("zone-dashboard service")`

1. **Empty zone** returns zero counts, empty `topChapters`,
   empty `topPartners`, empty `recentImports`, empty
   per-currency totals.
2. **Seeded zone, mixed currencies** — total posted giving over
   the current month is grouped per currency; top-chapters list
   honours the per-currency aggregation; reversed contributions
   are netted; voided rows excluded.
3. **Top-N truncation** — with 7 chapters all giving, only 5 are
   returned.
4. **Cross-currency isolation** — a member who gave in both GBP
   and USD shows up twice in `topPartners` (per currency rank),
   not summed.
5. **Recent imports** carries the 5 most recent jobs across
   committed / rolled-back / failed states, newest first.

### `describe("tenant dashboard route")`

1. Zone reader (owner) gets 200 + payload shape sanity.
2. Chapter-only treasurer gets 403.
3. Anonymous user gets 403 at requireTenantAuth.
4. Cross-tenant attempt (owner of A hits B) is 403.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- `/zone` lands on `/zone/dashboard`.
- Sidebar "Insight → Dashboard" present.
- Roadmap audited-status block + REPORTS §2.15 marked Done.
