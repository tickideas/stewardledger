# Phase 7 — PDF export infrastructure

Closes the universal "Excel ✓, PDF ✗" gap left on every Phase 7
report. Each shipped report gets a `pdf()` renderer alongside its
existing `excel()` renderer, and the tenant routes gain
`GET /api/tenant/reports/:id/export.pdf`.

## Approach: `pdfkit`, not Playwright

ARCHITECTURE.md §2 lists `playwright-core + @sparticuz/chromium`
as the PDF stack. That works for **bespoke HTML/CSS layouts**
(future member-statement letter, partnership receipts), but it
adds significant operational weight for v1:

- The Alpine Docker image needs `chromium` apk + ~150 MB of
  system deps.
- The test environment needs `playwright install chromium` (≈300
  MB download per CI run).
- Each PDF render starts a browser, navigates a page, prints.

Every report we have today is **tabular**: title block, header
row, data rows, per-currency subtotal block. `pdfkit` generates
these programmatically in a few KB of code with no external
binary. The output is deterministic (good for tests), the dep
is ~50 KB, and there's no install step.

This PR therefore:

- Ships `pdfkit` as the v1 PDF renderer.
- Documents that Playwright is **deferred** to a follow-up PR
  that adds it alongside the bespoke layouts (member statement,
  partnership receipts) — same infra unlocks the Phase 5
  treasurer Playwright happy-path.
- Updates ARCHITECTURE.md §2 to note the two-tier strategy.

## Scope

### Files

- `packages/api/package.json` — add `pdfkit` + `@types/pdfkit`.
- `packages/api/src/services/reports/pdf/branded-table.ts` —
  generic branded-table PDF renderer:
  - Top-of-page branded header (zone name, legal name, country +
    default currency, report title, filter summary, generated
    timestamp).
  - Column header row with weighted widths from
    `ReportColumn.kind`.
  - Data rows with money / number / date / datetime formatting.
  - Per-currency subtotals block at the end.
  - Auto-pagination (recurring branded header on every page).
  - Landscape orientation for >8-column reports; portrait
    otherwise.
- `packages/api/src/services/reports/types.ts` — add optional
  `pdf?(rows, subtotals, filters, branding, extras): Promise<Uint8Array>`
  on `ReportSpec`. Spec authors can override; default (no
  override) means the route layer uses the generic
  `renderBrandedTablePdf`.
- `packages/api/src/routes/tenant-reports.ts` — add
  `GET /reports/:id/export.pdf` mirroring the `.xlsx` handler.
  Same role gating (export tier), same filename pattern,
  `content-type: application/pdf`.
- `packages/web/src/routes/zone/reports/[id]/+page.svelte` —
  "Download PDF" button next to the existing Excel download.
- Per-report tests in `reports.test.ts` and route tests in
  `tenant-reports.test.ts`.
- `docs/ARCHITECTURE.md` §2 — document the two-tier PDF
  strategy.
- `docs/REPORTS.md` — flip the per-report status from
  "Done (Excel)" to "Done" once PDF lands.
- `docs/ROADMAP.md` — bump Phase 7 audited-status block.

### Non-goals (deferred)

- **Bespoke member-statement layout** (letter-style header,
  body copy, signature block) — needs HTML/CSS; ships with
  Playwright when that lands.
- **Playwright infra** — deferred to a follow-up PR that
  introduces both bespoke layouts and the Phase 5 treasurer
  happy-path Playwright test.
- **Saved filters / background `report.generate` worker** —
  Phase 7 trailing items, queued.

## Tests (vitest)

### `describe("renderBrandedTablePdf")` (unit)

1. Renders a non-empty buffer (PDF magic bytes `%PDF`).
2. Empty rows still produces a valid PDF (branded header + no
   data block).
3. Per-currency subtotals render at the bottom.
4. Long text columns wrap (assert page count > 1 for a
   forced-large dataset).

### Per-report

Add one `pdf()` smoke test per report family — same shape as
the existing `excel()` smoke tests, asserting the returned
buffer starts with `%PDF`. No need to assert layout; the
generic renderer is unit-tested.

### `describe("tenant reports routes")`

- Owner can hit `/export.pdf` and gets a `application/pdf`
  response with `%PDF` magic bytes.
- Auditor is denied (export tier).
- Same per-spec accessCheck paths as `.xlsx`.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- Every report registered in `registry.ts` can be exported as
  PDF.
- ROADMAP.md Phase 7 audited-status block updated.
- ARCHITECTURE.md §2 documents the two-tier strategy.
