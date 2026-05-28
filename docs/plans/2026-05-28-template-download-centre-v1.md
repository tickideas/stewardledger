# Bulk template download centre v1 — implementation plan

Date: 2026-05-28
Branch (proposed): `feature/template-download-centre`
Phase: 10 — Billing & GA exit-checklist item *"Bulk template download centre"*.
Reference: [`docs/CHURCHPLUS-PORT-NOTES.md` §2.2.2](../CHURCHPLUS-PORT-NOTES.md#222-bulk-template-download-centre) and §2.2.3 for the envelope-batch importer template.

> Status: **partially implemented** on `feature/template-download-centre`. Enabled statement-importer templates are downloadable; the envelope-batch template is staged but hidden until the §2.2.3 importer lands.

---

## 1. Scope summary

Add one-click empty `.xlsx` template downloads for every registered importer so treasurers can download the canonical sheet, fill it in, and upload it without guessing column names. The first v1 registry covers the existing bank statement import parser variants (`generic_csv`, `bank_csv`, `online_giving`) plus the Phase 10 envelope-batch parser from CHURCHPLUS-PORT-NOTES §2.2.3. Templates are generated server-side with `exceljs`, stamped with the existing `addBrandedSheet` helper, and surfaced on both `/zone/imports` and `/church/imports` using existing Ledger Editorial primitives only. No new design tokens, no import pipeline behaviour changes beyond exposing parser metadata.

This closes the Phase 10 exit checklist line **"Bulk template download centre shipped (one-click empty-template downloads for every registered importer, surfaced on `/zone/imports` and `/church/imports`)."**

---

## 2. Template registry and metadata

### 2.1 Import template manifest

Create a single registry near the parser layer so templates cannot drift away from accepted import formats:

- New file: `packages/api/src/services/imports/registry.ts`.
- Export `IMPORTER_REGISTRY` and helpers:
  - `listImportTemplates()` — ordered public list for UI cards.
  - `getImportTemplate(kind)` — exact lookup used by the download route.
  - `registeredImportKinds` — inferred union for route validation/tests.
- The registry entries carry:
  - `kind`: stable URL slug, e.g. `generic-bank-statement`, `bank-statement`, `online-giving-statement`, `envelope-batch`.
  - `title`, `description`, `fileType`, `sourceType`.
  - `surface`: `zone`, `church`, or `both` (all four are visible on `/zone/imports`; `/church/imports` shows chapter-usable templates and auto-notes chapter scope).
  - `requiredRole`: read/download only; no money-posting role needed.
  - `columns`: ordered column specs with `header`, `required`, `example`, `notes`, and optional `width`.
  - `uploadHints`: short text matching the current upload form controls.

The registry should be the source for both the XLSX generator and the UI list. Do not duplicate column arrays inside Svelte files.

### 2.2 Initial registered templates

| Kind | Upload mapping | Sheet title | Required columns | Optional columns |
| --- | --- | --- | --- | --- |
| `generic-bank-statement` | `fileType=statement`, `sourceType=generic_csv` | Generic bank statement import | `Date`, `Amount`, `Reference` | `Member Reference`, `Member Name`, `Chapter Reference`, `Giving Type`, `Giving Type Code`, `Currency Code`, `Description`, `Service Type`, `Service Date` |
| `bank-statement` | `fileType=statement`, `sourceType=bank_csv` | Bank statement import | `Date`, `Amount`, `Transaction Reference` | same matcher-friendly fields as generic, with bank-oriented notes |
| `online-giving-statement` | `fileType=statement`, `sourceType=online_giving` | Online giving statement import | `Date`, `Amount`, `Transaction Reference`, `Currency Code` | `Member Reference`, `Member Name`, `Giving Type`, `Giving Type Code`, `Description` |
| `envelope-batch` | future `fileType=envelope_batch`, `sourceType=envelope_batch` or the final §2.2.3 names | Envelope batch import | `Service Date`, `Chapter Reference`, `Member Reference`, `Giving Type Code`, `Amount`, `Currency Code` | `Service Type Code`, `Payment Method`, `Envelope Number`, `Description`, `External Reference` |

Notes:
- The exact `fileType`/`sourceType` for `envelope-batch` must match the §2.2.3 parser when it lands. If template centre lands first, add the template entry behind the same shared constants the parser PR will use rather than hard-coding a divergent string.
- Existing `ParsedRow` aliases already recognise most statement headers. Envelope-only headers (`Envelope Number`) need a parser manifest column even if the current bank matcher ignores them.
- Keep the empty data area empty. Examples belong in comments/notes and a separate examples sheet, not as row 7 data that treasurers might forget to delete.

---

## 3. XLSX generation service

New file: `packages/api/src/services/imports/templates.ts`.

### 3.1 Service contract

```ts
export interface ImportTemplateWorkbookResult {
  fileName: string;
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  body: Uint8Array;
}

export async function buildImportTemplateWorkbook(
  database: Database,
  ctx: AuthorizedContext,
  kind: RegisteredImportKind,
): Promise<ImportTemplateWorkbookResult>;
```

### 3.2 Workbook shape

Use `ExcelJS.Workbook` plus the existing report branding helpers:

- Load zone branding with `loadReportBranding(database, ctx.zoneId)`.
- Create the first worksheet through `addBrandedSheet({ sheetName, reportTitle, filterSummary, columnCount })`.
- `reportTitle`: `<Template title> template`.
- `filterSummary`: `Empty import template; generated for <zone name>; upload as <fileType>/<sourceType>`.
- Row 6 contains the template column headers. Header cells are bold and frozen by `addBrandedSheet` (`ySplit: 6`).
- No sample data rows in the import sheet.
- Required columns get a subtle existing-theme marker in the header text, e.g. `Amount *`, rather than new colors/tokens.
- Add comments/notes on header cells for format hints when ExcelJS supports it reliably; otherwise add a second sheet named `Instructions`.
- Add an `Instructions` sheet with:
  - which upload source type to choose,
  - required column list,
  - accepted date/amount formats,
  - a reminder that posted contributions are immutable and corrections happen through reversals,
  - an instruction not to rename headers.

Every string written to a cell goes through `escapeExcelText` where user-controlled or registry text could begin with formula characters. Registry text is source-controlled, but applying the same escaping as reports keeps the generator consistent.

### 3.3 Filename convention

Return stable, support-friendly filenames:

```text
<zone-slug>-<kind>-template.xlsx
```

Examples:

```text
grace-uk-generic-bank-statement-template.xlsx
grace-uk-envelope-batch-template.xlsx
```

---

## 4. API surface

### 4.1 Routes

Add two tenant import-template endpoints to `packages/api/src/routes/tenant-imports.ts` or a small sibling `tenant-import-templates.ts` mounted by the tenant router:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tenant/imports/templates` | JSON list of registered templates visible to the current caller. |
| `GET` | `/api/tenant/imports/templates/:kind.xlsx` | Download the branded empty `.xlsx` template. |

### 4.2 Role gating

Download is a read/support action, not a commit action. Reuse the import read role buckets from `tenant-imports.ts`:

- Zone readers: `zone_owner`, `zone_admin`, `zone_finance_admin`, `zone_auditor`.
- Chapter readers: `chapter_admin`, `chapter_treasurer`, `chapter_bookkeeper`.
- Group readers: `group_admin`.

`/zone/imports` callers with zone read roles see all templates. `/church/imports` callers see templates that can be uploaded in chapter scope. Cross-zone leakage is not possible because both endpoints run under the existing tenant middleware and use `ctx.zoneId` for branding.

### 4.3 Response details

The `.xlsx` endpoint sets:

```http
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="<zone-slug>-<kind>-template.xlsx"
Cache-Control: private, no-store
```

Errors:

- Unknown `kind` → 404 `template_not_found`.
- Authenticated but role cannot read imports → 403 `forbidden`.
- Registry entry hidden from the current surface/role → 404, not 403, to avoid exposing unavailable templates.

---

## 5. UI surface

All UI reuses the existing `/zone/imports` and `/church/imports` page skeletons and Ledger Editorial classes (`sl-card`, `sl-eyebrow`, `sl-btn*`, `sl-input`, `sl-select`) from `packages/web/src/app.css`. No new tokens and no raw Tailwind slate/rose/emerald/amber colors.

| Path | Change |
| --- | --- |
| `packages/web/src/routes/zone/imports/+page.svelte` | Add a `sl-card` titled "Download empty templates" above or beside the upload card. Fetch `/api/tenant/imports/templates`, render one compact row/card per template, and link the primary action to `/api/tenant/imports/templates/:kind.xlsx`. |
| `packages/web/src/routes/church/imports/+page.svelte` | Add the same template download card, filtered by the API to chapter-usable templates. Include helper copy: "After download, fill the sheet and upload it below for this chapter/service." |
| Optional shared component `packages/web/src/lib/imports/template-download-centre.svelte` | If the duplicated markup exceeds a small block, extract a shared component used by both surfaces. Keep it presentation-only; data still comes from each page's existing load/fetch path. |

The UI should not add a separate route. The Phase 10 requirement says surface on `/zone/imports` and `/church/imports`; a centred block on those pages is sufficient and keeps import workflow one page.

---

## 6. Parser / envelope-batch interaction

This work should not implement the full envelope-batch import pipeline. It must, however, make template coverage future-proof:

1. Move importer metadata into the registry described in §2.
2. Wire existing bank statement parser choices to registry entries.
3. Add an `envelope-batch` registry entry with columns from CHURCHPLUS-PORT-NOTES §2.2.3.
4. When the §2.2.3 parser lands, it should import/reuse the same entry (or the same column constants), not redefine headers.
5. If the parser PR lands first, this plan's implementation should simply expose its registered template.

Non-negotiable: one-click downloads are for **every registered importer**. A test should fail if an importer kind lacks template metadata.

---

## 7. Test plan

Tests live next to code and cover service, route, UI, and registry drift.

### 7.1 Unit tests

- `packages/api/src/services/imports/templates.test.ts`:
  - Builds a workbook for each registered template kind.
  - Workbook includes branded rows via `addBrandedSheet` shape (`A1` zone name, data header on row 6, frozen view `ySplit: 6`).
  - Required headers are present and ordered.
  - First import data row is empty; no accidental sample row is emitted.
  - Instructions sheet exists and names the matching `fileType`/`sourceType`.
  - Filename is `<zone-slug>-<kind>-template.xlsx`.
  - Formula-looking registry/zone strings are escaped through `escapeExcelText`.

- `packages/api/src/services/imports/registry.test.ts`:
  - Every registered importer has at least one required column.
  - Every registry entry has a unique `kind`.
  - Existing import source types (`generic_csv`, `bank_csv`, `online_giving`) have matching template entries.
  - `envelope-batch` is present.

### 7.2 Route tests

- `packages/api/src/routes/tenant-imports.test.ts` or `tenant-import-templates.test.ts`:
  - `GET /api/tenant/imports/templates` returns visible template metadata for zone import readers.
  - Chapter reader can list/download templates on `/church/imports` context.
  - Viewer without import read role gets 403.
  - Unknown template kind returns 404.
  - `.xlsx` endpoint returns correct `Content-Type`, `Content-Disposition`, and non-empty body.
  - Cross-tenant fuzz: user from zone A cannot use zone B auth/slug context to receive zone B branding in a workbook.

### 7.3 UI tests

- `packages/web/src/routes/zone/imports/+page.test.ts` (or the existing Svelte route test location):
  - Renders the template centre when API returns templates.
  - Download links point to `/api/tenant/imports/templates/:kind.xlsx`.
  - Empty-list state is clear but unlikely.

- `packages/web/src/routes/church/imports/+page.test.ts`:
  - Renders the same centre with chapter-scoped helper copy.
  - Does not expose unsupported/hidden template kinds if the API omits them.

### 7.4 Verification commands

Before marking the implementation complete:

```bash
pnpm lint
pnpm check
pnpm test
```

These match the repo-level AGENTS.md gates. The test DB must be running on port 5433 via `docker-compose.yml` before `pnpm test`.

---

## 8. Out of scope (explicit non-goals)

1. **No full envelope-batch import implementation.** This plan only includes the template manifest entry required for §2.2.3. The actual upload → match → schedule → commit materialisation into `contribution_batches` / `contributions` remains the separate Bulk slip / envelope import item.
2. **No CSV template downloads.** Church Plus distributed Excel/CSV, but this v1 scope explicitly ships XLSX using `addBrandedSheet`.
3. **No new design tokens or bespoke styling.** Reuse the existing import page skeleton and `sl-*` primitives.
4. **No import schema migration unless §2.2.3 lands in the same branch.** If only template downloads are implemented, database checks remain untouched.
5. **No sample tenant data or seeded templates.** Templates are generated dynamically from branding and registry metadata.
6. **No public/unauthenticated downloads.** Templates are tenant-branded and exposed only through authenticated tenant routes.
7. **No automatic upload-form selection from downloaded template.** Helpful copy tells the treasurer which source type to choose; deeper UX coupling can wait.

---

## 9. Risks and rollback

- **Risk: template headers drift from parser aliases.** Mitigated by keeping template metadata beside parser registration and adding a registry drift test.
- **Risk: Excel formula injection through branded header text.** Mitigated by reusing `addBrandedSheet` / `escapeExcelText` and adding a test with hostile zone names.
- **Risk: envelope-batch naming diverges between this PR and §2.2.3.** Mitigated by centralising `kind`, `fileType`, and `sourceType` constants; if the parser PR is not landed, leave a compile-time TODO tied to the shared registry rather than independent strings.
- **Risk: users mistake examples for data.** Mitigated by keeping the import sheet empty and moving examples/instructions to comments or a separate `Instructions` sheet.
- **Risk: large workbook generation under load.** Empty templates are tiny; no background job needed. If needed later, route-level private caching can be added without changing the public contract.
- **Rollback:** revert the route, service, registry, and UI card. No persisted data is created. Existing import uploads keep working because parser behaviour is unchanged.

---

## 10. Exit checklist (Phase 10 — Billing & GA)

Ticks the Phase 10 line **"Bulk template download centre shipped (one-click empty-template downloads for every registered importer, surfaced on `/zone/imports` and `/church/imports`). See [`CHURCHPLUS-PORT-NOTES.md` §2.2.2](../CHURCHPLUS-PORT-NOTES.md#222-bulk-template-download-centre)."** in `docs/ROADMAP.md`.

The PR is complete when every box below is checked:

- [ ] `packages/api/src/services/imports/registry.ts` defines the importer/template registry and exports list/get helpers.
- [ ] Registry includes bank statement parser templates for `generic_csv`, `bank_csv`, and `online_giving`.
- [ ] Registry includes the §2.2.3 `envelope-batch` template entry.
- [ ] `packages/api/src/services/imports/templates.ts` builds `.xlsx` workbooks via `exceljs`.
- [ ] Template workbooks use `loadReportBranding` and `addBrandedSheet` for the first sheet.
- [ ] Template sheets have frozen branded headers, ordered row-6 column headers, and no sample data rows.
- [ ] Workbooks include instructions/notes for required fields and upload source type.
- [ ] `GET /api/tenant/imports/templates` returns visible template metadata.
- [ ] `GET /api/tenant/imports/templates/:kind.xlsx` returns the branded workbook with correct download headers.
- [ ] Route gating reuses import read roles; unauthorized callers receive 403 and unknown template kinds receive 404.
- [ ] `/zone/imports` surfaces the download centre using existing `sl-*` primitives.
- [ ] `/church/imports` surfaces the download centre using existing `sl-*` primitives.
- [ ] No new design tokens or ad-hoc Tailwind color/card/button styling added.
- [ ] Unit tests cover registry completeness, workbook shape, filenames, and formula escaping.
- [ ] Route tests cover listing, download headers/body, role denial, unknown kind, and cross-tenant branding isolation.
- [ ] UI tests cover both import pages' template cards and download links.
- [ ] `pnpm lint && pnpm check && pnpm test` all green.
- [ ] `docs/ROADMAP.md` Phase 10 line "Bulk template download centre" ticked with implementation file references.
- [ ] `docs/CHURCHPLUS-PORT-NOTES.md` §2.2.2 marked as landed with the branch/merge SHA.
- [ ] PR body mirrors this exit checklist and links back to `docs/plans/2026-05-28-template-download-centre-v1.md`.

---

## Open questions (confirm before implementation)

1. **Envelope-batch source naming.** Should the §2.2.3 parser use `fileType=envelope_batch` + `sourceType=envelope_batch`, or keep `fileType=statement` and distinguish only by `sourceType` until the import schema check constraint is widened? Recommendation: widen intentionally in the envelope-batch PR and keep template registry constants ready for that value.
2. **Instruction sheet examples.** Do you want examples only in header notes, or a separate `Examples` sheet? Recommendation: instructions only for v1 so the import sheet stays unmistakably empty.
3. **Online giving label.** The current parser source type is `online_giving`, but the upload UI presents it beside bank statements. Should the user-facing template title be "Online giving statement" or "Online giving export"? Recommendation: "Online giving statement" to match the Phase 6 import wording.

---

Plan written to docs/plans/2026-05-28-template-download-centre-v1.md. Awaiting approval before implementation.
