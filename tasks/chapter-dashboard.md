# Phase 7 — Chapter dashboard (REPORTS.md §2.14)

Server-aggregated dashboard payload for one chapter, consumed by
the existing `/church/overview` landing surface. Mirrors the zone
dashboard's shape and reuses `calendar.ts` + `ranking.ts`.

## Why now

`/church/overview` currently runs 3 parallel client-side API
calls (members, batches, contributions) and aggregates in the
browser. That:

- doesn't handle reversals correctly (the current `postedThisMonth`
  derivation sums `totalAmount` of posted contributions only — the
  reversal nets are missed)
- can't show "top giving types" or "top partners" without pulling
  every contribution line into the browser
- needs three separate cache invalidations
- doesn't share grammar with the zone dashboard

A single server endpoint computes everything once with proper
sign-convention math, with per-currency subtotals, and matches the
zone dashboard's shape so a future "trend" / "saved layout"
feature lands in both places.

## MVP scope

One JSON endpoint, one updated Svelte page, vitest coverage.

### Endpoint

`GET /api/tenant/dashboard/chapter/:chapterId` → returns the
payload below for that chapter, scoped to the caller's bindings.

Access:

- Any **zone reader** can read any chapter's dashboard (drilldown
  from `/zone/dashboard`).
- Any **chapter reader** can read their bound chapters'
  dashboards.
- An out-of-scope `:chapterId` for a chapter-only caller → 403.
- A chapter id that doesn't exist or belongs to another zone → 404
  via the existing tenant scoping (cross-tenant attempts get 403
  at `requireTenantAuth`).

Payload (single response, all in parallel against `db`):

```
{
  asOf: ISO-datetime,
  timeZone: string,
  chapter: { id, referenceCode, name },
  members: { total: number, active: number, inactive: number },
  weeklyGiving: {              // current ISO week
    periodStart: ISO-date,
    periodEnd: ISO-date,
    perCurrency: CurrencyTotal[],
  },
  monthlyGiving: { periodStart, periodEnd, perCurrency },
  yearToDateGiving: { periodStart, periodEnd, perCurrency },
  pendingBatches: { count: number, perCurrency: CurrencyTotal[] },
  topGivingTypes: [           // top 5 by current-month total
    { id, name, shortCode, currencyCode, total }
  ],
  topPartners: [              // top 5 chapter members by month
    { id, referenceCode, name, currencyCode, total }
  ],
  recentContributions: [       // 5 most recent posted contributions
    { id, contributionDate, memberName, currencyCode, amount, sourceType }
  ],
  partnershipProgress: { available: false, reason },
}
```

### UI

Update `packages/web/src/routes/church/overview/+page.svelte` to
fetch from the new endpoint and render the additional cards.
Keep the existing 4-tile grid layout; add side-by-side "Top
giving types" + "Top partners" tables, and a "Recent
contributions" panel. The 3 legacy client-side fetches are
removed.

### Sidebar

The `/church` shell already has "Overview" as the chapter
landing. No nav change required.

## Files

- `packages/api/src/services/dashboards/chapter-dashboard.ts` —
  new aggregation service.
- `packages/api/src/services/dashboards/chapter-dashboard.test.ts`
  — hand-curated chapter dataset tying out counts, monthly /
  weekly / YTD per-currency, top-giving-types, top-partners,
  pending-batches, recent-contributions.
- `packages/api/src/routes/tenant-dashboard.ts` — add the
  `GET /dashboard/chapter/:chapterId` handler with access gating.
- `packages/api/src/routes/tenant-dashboard.test.ts` — extend
  with chapter-dashboard cases (zone reader OK, in-scope chapter
  reader OK, out-of-scope chapter reader 403, cross-tenant 403,
  unknown chapter 404 / forbidden — match the existing pattern).
- `packages/web/src/routes/church/overview/+page.svelte` —
  switch to the new endpoint, render the extra cards, drop the
  legacy client-side aggregation.
- `docs/REPORTS.md` §2.14 — flip status to Done.
- `docs/ROADMAP.md` — bump Phase 7 audited-status block.

## Non-goals (deferred)

- **Target progress card** — depends on Phase 8 financial
  targets.
- **Trend sparklines** — defer to a follow-up.
- **Weekly breakdown of monthly giving** — REPORTS spec mentions
  "weekly giving"; v1 ships a single "this week" number rather
  than a stacked weekly chart.
- **Chapter switcher inline on the dashboard** — the existing
  `useActiveChapter()` already drives the active chapter from
  the sidebar; we keep that contract.

## Tests (vitest)

### `describe("chapter-dashboard service")`

1. **Empty chapter** returns zero counts and empty per-currency
   lists.
2. **Curated dataset** ties out members / weekly / monthly / YTD
   totals; reversed contributions net to zero.
3. **topGivingTypes** ranks by total within the month, per
   currency, truncated to 5.
4. **Cross-chapter isolation**: contributions in another
   chapter in the same zone don't leak into the dashboard for
   the requested chapter.
5. **Pending batches** counts draft / submitted / approved only;
   posted / voided are excluded.
6. **Recent contributions** carries the 5 most recent posted
   contributions newest-first.

### `describe("tenant dashboard chapter route")`

1. Zone owner can read any chapter (200).
2. Chapter treasurer can read their bound chapter (200).
3. Chapter treasurer 403 on a chapter they don't own.
4. Cross-tenant 403 at requireTenantAuth.
5. Unknown chapter id → 404.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- `/church/overview` renders the new payload end-to-end.
- ROADMAP audited-status block + REPORTS §2.14 marked Done.
