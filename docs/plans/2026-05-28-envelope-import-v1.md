<!-- docs/plans/2026-05-28-envelope-import-v1.md -->
<!-- Plans the Phase 10 bulk slip / envelope import v1 implementation. -->
<!-- Exists to scope the envelope-batch parser into the existing import pipeline before code changes. -->
<!-- RELEVANT FILES: docs/CHURCHPLUS-PORT-NOTES.md, docs/ROADMAP.md, packages/api/src/services/imports/index.ts, packages/api/src/services/imports/parsers.ts -->

# Bulk slip / envelope import v1 — implementation plan

Date: 2026-05-28
Branch (proposed): `feature/envelope-import-v1`
Phase: 10 — Billing & GA exit-checklist item *"Bulk slip / envelope import"*.
Reference: [`docs/CHURCHPLUS-PORT-NOTES.md` §2.2.3](../CHURCHPLUS-PORT-NOTES.md#223-bulk-slip--envelope-import-xlsxcsv).

> Status: **planned**. Stop after this plan; no implementation in this change.

---

## 1. Scope summary

Add an `envelope_batch` import kind to the existing tenant import pipeline: upload -> parse -> match -> schedule -> commit. The feature lets a chapter treasurer upload a CSV/XLSX-style envelope slip sheet from `/church/imports`, preview matched rows, schedule the import, and commit it atomically into posted envelope contributions grouped under a `contribution_batches` row.

This is a parser/materializer addition, not a bank-statement parser change. Existing statement import behavior (`generic_csv`, `bank_csv`, `online_giving`) must remain byte-for-byte compatible unless a shared type signature needs an additive field.

The committed ledger shape is:

- One `import_files` + `import_jobs` lifecycle, as today.
- One `import_rows` row per envelope spreadsheet row, as today.
- One posted `contribution_batches` row per import job per `(chapter_id, service_event_id, currency_code, payment_method_id?)` group.
- One posted `contributions` row per valid non-duplicate envelope row, with `source_type='envelope'`, `batch_id` set, and exactly one `contribution_lines` row for the row's giving type.
- One `processed_transactions` row per committed contribution using the same zone-scoped idempotency table already used by statement imports.

Out of scope: any change to the bank-statement parser or any attempt to auto-reconcile bank lines against envelope batches.

---

## 2. Data model

### 2.1 Existing tables reused

No new domain table is needed for v1. The importer reuses:

- `import_files`, `import_jobs`, `import_rows`, `import_row_failures`, `import_schedules`, `processed_transactions`.
- `contribution_batches`, `contributions`, `contribution_lines`.
- Existing lookup tables: `members`, `chapters`, `giving_types`, `giving_periods`, `service_events`, `payment_methods`, `accounts`.

The existing zone boundary is sufficient because every touched table already carries `zone_id`, and every FK used by import rows / contributions is composite `(zone_id, id)` where the schema requires it.

### 2.2 Schema changes

Add `envelope_batch` to the import metadata enums and checks:

```ts
IMPORT_FILE_TYPES = ["statement", "envelope_batch"] as const;
IMPORT_SOURCE_TYPES = ["generic_csv", "bank_csv", "online_giving", "envelope_batch"] as const;
```

Database migration:

- Update `import_files_file_type_check` to allow `'envelope_batch'`.
- No `contribution_batches.source_type` change: existing check already allows `'envelope'`.
- No `contributions.source_type` change: existing check already allows `'envelope'`.
- No `processed_transactions` change: reuse `unique(zone_id, external_transaction_id)`.

### 2.3 `import_rows.parsed` envelope payload

Keep the column as `jsonb`, but make the TypeScript parsed shape a discriminated union so the commit path can branch safely:

```ts
type StatementParsedRow = {
  kind: "statement";
  amount: string | null;
  contributionDate: string | null;
  memberReferenceCode: string | null;
  memberName: string | null;
  chapterReferenceCode: string | null;
  givingTypeName: string | null;
  givingTypeShortCode: string | null;
  givingCategoryName: string | null;
  externalTransactionId: string | null;
  currencyCode: string | null;
  paymentMethodCode: string | null;
  serviceEventId: string | null;
  serviceTypeName: string | null;
  serviceTypeShortCode: string | null;
  serviceDate: string | null;
  description: string | null;
};

type EnvelopeBatchParsedRow = StatementParsedRow & {
  kind: "envelope_batch";
  envelopeNumber: string | null;
  cashAmount: string | null;
  chequeAmount: string | null;
};
```

`kind` is additive; statement rows keep their current fields. If preserving exact `parsed` JSON for old statement tests proves important, the parser can omit `kind` from persisted statement rows and the service can infer `statement` from `import_files.file_type`. The implementation plan should prefer the safer union in TypeScript, but not force a persisted JSON churn if tests show it is noisy.

### 2.4 Idempotency key

Reuse `processed_transactions.external_transaction_id` for envelope imports.

Resolution order:

1. If the sheet supplies `External Reference`, use it after trimming.
2. Otherwise derive a deterministic key from stable row data:

```text
envelope_batch:<chapter_id>:<service_event_id>:<member_id-or-anon>:<giving_type_id>:<currency_code>:<amount>:<envelope_number-or-row_number>
```

The key is scoped by `zone_id` in `processed_transactions`, so two zones can upload the same envelope numbers without collision. For rows without a source reference, including the source row number is acceptable because file-level checksum reuse already catches identical re-uploads; the processed key catches edited-file re-uploads that would otherwise repost the same slip.

---

## 3. Migration plan

- **Migration number**: next Drizzle migration after the current head.
- **Generation**: update the Drizzle schema checks, then run `pnpm --filter @stewardledger/db exec drizzle-kit generate --name envelope_batch_import`.
- **Inspection**:
  - Confirm `import_files_file_type_check` includes `envelope_batch`.
  - Confirm no generated change touches money precision (`numeric(19,4)`).
  - Confirm no generated change edits contribution source-type checks.
- **Backfill**: none. Existing imports remain `file_type='statement'`.
- **Template registry**: flip the existing disabled `envelope-batch` entry to `enabled: true` only after the parser and route support land.
- **Docs**:
  - `docs/DOMAIN-MODEL.md` §7: add the envelope-batch import kind and the commit grouping rule.
  - `docs/CHURCHPLUS-PORT-NOTES.md` §2.2.3: mark as landed after implementation.
  - `docs/ROADMAP.md` Phase 10 checklist: tick the "Bulk slip / envelope import" line after implementation.

Rollback is a forward migration that removes `envelope_batch` from the import file-type check only if no `import_files.file_type='envelope_batch'` rows exist. In practice, code rollback is enough during rollout because the UI entry is additive and can be hidden by disabling the registry item.

---

## 4. API and service surface

All routes stay under the existing `tenantImportsRouter`; no new top-level API surface is needed.

### 4.1 Upload metadata

Update `importCreateSchema` and route validation to accept:

```ts
fileType: "statement" | "envelope_batch";
sourceType: "generic_csv" | "bank_csv" | "online_giving" | "envelope_batch";
```

Route constraints:

- `fileType='statement'` keeps the existing accepted source types only.
- `fileType='envelope_batch'` requires `sourceType='envelope_batch'`.
- `/church/imports` must send `chapterId` and `serviceEventId`; chapter-scoped imports still require a target service event.
- Zone-wide envelope import remains out of scope for the UI. The API can reject `fileType='envelope_batch'` with no `chapterId` using `chapter_required`, keeping v1 aligned with the church tab.

### 4.2 Parser selection

Change `parseImportBody` to branch on `fileType` and `sourceType`, not only file extension:

```ts
parseImportBody({
  body,
  fileName,
  fileType,
  sourceType,
});
```

Implementation files:

- `packages/api/src/services/imports/parsers.ts`
  - Keep existing statement CSV logic intact.
  - Add `parseEnvelopeBatchCsvBody`.
  - Keep `parseXlsxBody` behavior explicit. If XLSX support is implemented in this PR, use the existing `xlsx` dependency and the same bounds checks; otherwise accept CSV first and keep `.xlsx` returning a clear parser error. The Church Plus note says XLSX/CSV, so the preferred implementation is to support both in the envelope parser without widening the bank-statement parser.
- `packages/api/src/services/imports/envelope-parser.ts` is acceptable if `parsers.ts` would cross the ~400 line split threshold.

Envelope header aliases:

| Canonical field | Accepted headers |
| --- | --- |
| `serviceDate` | `Service Date`, `Date` |
| `serviceTypeShortCode` | `Service Type Code`, `Service Code` |
| `serviceTypeName` | `Service Type`, `Service` |
| `chapterReferenceCode` | `Chapter Reference`, `Chapter Code`, `Chapter` |
| `memberReferenceCode` | `Member Reference`, `Member Ref`, `Member Code` |
| `memberName` | `Member Name`, `Member` |
| `givingTypeShortCode` | `Giving Type Code`, `Giving Code` |
| `givingTypeName` | `Giving Type`, `Category` |
| `amount` | `Amount`, `Total`, `Value` |
| `cashAmount` | `Cash Amount`, `Cash` |
| `chequeAmount` | `Cheque Amount`, `Check Amount`, `Cheque`, `Check` |
| `currencyCode` | `Currency Code`, `Currency` |
| `paymentMethodCode` | `Payment Method`, `Method` |
| `envelopeNumber` | `Envelope Number`, `Envelope No`, `Slip Number`, `Slip No` |
| `externalTransactionId` | `External Reference`, `Reference`, `Transaction Reference` |
| `description` | `Description`, `Notes`, `Memo` |

Validation rule: a row must provide either `Amount` or exactly one of `Cash Amount` / `Cheque Amount`. If both cash and cheque are supplied, v1 should reject the row as `INVALID_AMOUNT_SPLIT` rather than materialising two contributions from one source row.

### 4.3 Matcher selection

Keep the current `matchRows` as the statement matcher and add an envelope-specific wrapper:

- `matchStatementRows(...)` (renamed from current `matchRows`, implementation unchanged).
- `matchEnvelopeRows(...)`:
  - Requires `fileChapterId`.
  - Resolves chapter from file scope; row-level chapter columns must match the file chapter if supplied.
  - Resolves service event from file scope first; row-level service date/type must match the selected service event if supplied.
  - Resolves member by reference first, then unique name within chapter. Member remains nullable only if the row is explicitly anonymous; v1 can reject anonymous rows unless a later Church Plus sample requires them.
  - Resolves giving type by short code first, then name.
  - Resolves payment method by code. If absent and `cashAmount` is present, infer `cash`; if `chequeAmount` is present, infer `cheque`; otherwise allow null and let the batch group use null.
  - Resolves giving period from the service event date / contribution date.
  - Checks amount with `decimal.js`; positive only.
  - Checks account currency against row/import currency.
  - Checks duplicates through `processed_transactions` using the resolved / derived idempotency key.

Failure codes to add to `import_failure_types` if missing:

- `ENVELOPE_BATCH_CHAPTER_REQUIRED`
- `ENVELOPE_BATCH_SERVICE_EVENT_REQUIRED`
- `ENVELOPE_BATCH_SERVICE_EVENT_MISMATCH`
- `ENVELOPE_BATCH_MEMBER_REQUIRED`
- `INVALID_AMOUNT_SPLIT`
- `ENVELOPE_DEDUPE_KEY_REQUIRED` only if the derived key cannot be built

Existing codes (`MEMBER_NOT_FOUND`, `MEMBER_AMBIGUOUS`, `GIVING_TYPE_NOT_FOUND`, `INVALID_AMOUNT`, `INVALID_DATE`, `PERIOD_NOT_FOUND`, `CURRENCY_MISMATCH`, `DUPLICATE`) should be reused where they already fit.

### 4.4 Commit selection

Split the current `commitImport` into a dispatcher:

```ts
commitImport(database, ctx, importJobId) {
  const detail = load job + file;
  if (detail.file.fileType === "envelope_batch") return commitEnvelopeBatchImport(...);
  return commitStatementImport(...);
}
```

`commitStatementImport` is the current implementation with no behavioral changes.

`commitEnvelopeBatchImport`:

1. Conditional status flip `scheduled -> committing`, same as today.
2. Load all rows for the job.
3. Partition valid non-duplicate rows into groups by `(chapter_id, service_event_id, currency_code, payment_method_id ?? "none")`.
4. Insert one `contribution_batches` row per group:
   - `sourceType='envelope'`
   - `status='draft'` initially
   - `referenceCode='IMPORT-' + importJobId.slice(0, 8) + '-' + groupIndex`
   - `cashTotal` = sum rows whose payment method is cash or whose `cashAmount` is set
   - `chequeTotal` = sum rows whose payment method is cheque or whose `chequeAmount` is set
   - `currencyCode` = group currency
   - `notes` references original file name + import job id
5. Insert draft `contributions` rows:
   - `sourceType='envelope'`
   - `batchId` points at the generated batch
   - `chapterId`, `memberId`, `paymentMethodId`, `serviceEventId`, `givingPeriodId`, `currencyCode`, `externalTransactionId`
   - `contributionDate` = service event date unless the row carries a valid contribution date matching the service event
   - `totalAmount` = parsed amount
6. Insert one `contribution_lines` row per contribution.
7. Bulk-promote contributions to `posted`.
8. Bulk-promote generated batches to `posted` with `postedAt` / `postedByUserId`.
9. Insert `processed_transactions` rows for every committed contribution.
10. Backfill `import_rows.contribution_id`.
11. Audit:
    - `contribution.batch.create` for each generated batch, or the existing batch audit action if one exists.
    - `contribution.create` + `contribution.post` per contribution, matching manual/import behavior.
    - `import.commit` with `{ committedRows, skippedDuplicates, generatedBatchIds }`.

Do not call the public `createBatch` / `postBatch` service per row or per batch if that would create N+1 writes. Reuse its invariants, but keep this importer bulk-oriented like the existing statement commit path.

### 4.5 Rollback

Reuse `rollbackImport`.

Expected behavior:

- Void all contributions emitted by the import job.
- Delete matching `processed_transactions` rows so a corrected upload can be committed later.
- Void generated `contribution_batches` that no longer have non-voided contributions after rollback.
- Write `contribution.void` audit rows and `import.rollback` as today, plus batch void audit rows for generated envelope batches.

If the current rollback only sees contributions through `import_rows.contribution_id`, it will already find the envelope contributions. The implementation needs to add the generated-batch voiding step.

---

## 5. UI surface

Surface this as a new tab on `/church/imports`; do not add envelope upload to the bank statement controls.

### 5.1 `/church/imports`

Refactor the page into two tabs:

| Tab | Purpose |
| --- | --- |
| `Statements` | Existing bank / online-giving upload form and import history. Default tab to preserve current behavior. |
| `Envelope batches` | New envelope upload form, template link, and import history filtered to `fileType=envelope_batch`. |

Implementation notes:

- Use existing Ledger Editorial primitives (`sl-card`, `sl-btn`, `sl-select`, `sl-input`, `var(--*)` tokens).
- Avoid raw Tailwind color palettes and ad-hoc card styling.
- Keep service event selection from the current church import form.
- File input accepts `.csv,.xlsx` only if XLSX support lands; otherwise `.csv` and the template copy should say CSV.
- Upload sends `fileType=envelope_batch`, `sourceType=envelope_batch`, active chapter id, and selected service event id.
- After successful upload, route to the existing detail screen (`/zone/imports/[id]`) unless a church detail route already exists by implementation time.

### 5.2 Import detail

The existing `/zone/imports/[id]` detail should render envelope jobs without a fork:

- Show `file.fileType` / `file.sourceType` labels.
- Row preview should include envelope-specific columns (`envelopeNumber`, `paymentMethodCode`, `serviceDate`) from `raw` / `parsed`.
- The schedule / commit buttons and status badges remain unchanged.
- For committed envelope jobs, show generated batch ids or a link to batch detail if such a route exists.

### 5.3 Template download centre

Enable the existing `envelope-batch` template in `packages/api/src/services/imports/registry.ts` after parser support lands.

The template should be available on the `church` surface. It can remain hidden on the `zone` surface for v1 if the API rejects zone-wide envelope imports.

---

## 6. Test plan

Tests live next to code (`foo.ts` + `foo.test.ts`). Numbers below are minimums.

### 6.1 Parser tests

`packages/api/src/services/imports/parsers.test.ts`:

- Parses a canonical envelope CSV with service date, member ref, giving type code, amount, currency, payment method, envelope number.
- Accepts UK-style dates and Excel serial dates consistently with the statement parser.
- Rejects row count / column count / cell length limit violations.
- Rejects both `Cash Amount` and `Cheque Amount` in the same row.
- If XLSX support lands: parses a minimal workbook and applies the same bounds.
- Statement parser tests remain unchanged.

### 6.2 Matcher tests

`packages/api/src/services/imports/imports.test.ts` or a new `envelope-imports.test.ts`:

- Chapter-scoped envelope rows resolve member, giving type, service event, period, currency, and payment method.
- Row-level chapter reference that differs from the file chapter fails.
- Row-level service date/type that differs from the selected service event fails.
- Unknown member and ambiguous member name produce existing member failure codes.
- Duplicate `external_transaction_id` from `processed_transactions` marks the row duplicate but not invalid.
- Derived idempotency key catches a second edited-file upload of the same slip data.

### 6.3 Commit tests

`packages/api/src/services/imports/imports.test.ts`:

- Upload -> match -> schedule -> commit posts envelope contributions atomically.
- Contributions are `source_type='envelope'`, `status='posted'`, and linked to generated `contribution_batches`.
- Generated batches are `source_type='envelope'`, `status='posted'`, single-currency, and carry correct cash / cheque totals.
- Re-uploading identical bytes reuses the existing job.
- Uploading edited bytes with already-seen envelope idempotency keys produces zero new contributions.
- Rollback voids contributions, voids generated batches, deletes matching `processed_transactions`, and allows a corrected re-upload.
- Commit is all-or-nothing when one valid row violates a DB invariant.

### 6.4 Route and RBAC tests

`packages/api/src/routes/tenant-imports.test.ts`:

- `/api/tenant/imports/templates` now includes `envelope-batch` for `surface=church`.
- Upload rejects `fileType=envelope_batch` without `chapterId`.
- Upload rejects `fileType=envelope_batch` without `serviceEventId`.
- Chapter bookkeeper can upload and preview but cannot schedule / commit / rollback.
- Chapter treasurer can upload, schedule, commit, and rollback for their own chapter.
- Chapter treasurer cannot upload to another chapter or use another chapter's service event.
- Zone finance admin can read envelope jobs but the church tab remains chapter-pinned.
- Cross-tenant fuzz: zone A callers cannot read, schedule, commit, rollback, or list zone B envelope jobs.

### 6.5 UI tests

Minimum Svelte component / route tests where existing harness supports them:

- `/church/imports` renders `Statements` and `Envelope batches` tabs.
- Envelope tab posts the correct multipart metadata.
- Template download centre shows the envelope template on church surface after enabling.
- Detail screen renders envelope-specific row fields without breaking statement rows.

### 6.6 Verification commands

Before opening the implementation PR:

```bash
pnpm -w lint
pnpm -w check
pnpm -w test
```

The test DB should run on port 5433 via `docker-compose.yml`, per AGENTS.md.

---

## 7. Out of scope (explicit non-goals)

1. **Bank-statement parser changes.** No header alias, date, amount, or commit behavior changes for statement imports.
2. **Bank reconciliation against envelope batches.** Envelope imports post physical giving; later bank deposits can still be imported separately.
3. **Zone-wide envelope upload UI.** v1 is surfaced on `/church/imports` and pinned to the active chapter.
4. **Inline row repair.** Bad rows are corrected in the source sheet and re-uploaded, matching current import behavior.
5. **Multi-line envelope rows.** v1 keeps one row = one giving type line. A physical envelope split across giving types appears as multiple source rows sharing the same envelope number.
6. **Negative envelope rows / reversals.** Imported envelope rows must be positive inflows. Corrections use the existing reversal / rollback paths.
7. **Changing paying-in-book validation.** Existing paying-in-book checks remain on manual batch flows unless the implementation can reuse them without scope creep.

---

## 8. Risks and rollback

- **Risk: accidentally changing statement import semantics.** Mitigate by splitting statement and envelope parser / matcher / commit paths and keeping existing statement tests unchanged.
- **Risk: duplicate envelopes repost after edited re-upload.** Mitigate by deriving deterministic `external_transaction_id` values and inserting every committed row into `processed_transactions`.
- **Risk: generated batch totals drift from contribution totals.** Mitigate by computing cash / cheque totals from the exact eligible rows used for contribution inserts inside the same transaction.
- **Risk: mixed currency in one generated batch.** Mitigate by grouping batches by `currency_code` and keeping the existing contribution-batch currency invariant.
- **Risk: service-event mismatch.** Mitigate in matcher: selected upload service event is authoritative, and row-level service fields can only confirm it, not override it.
- **Risk: rollback leaves posted batch shells.** Mitigate by extending rollback to void generated envelope batches after voiding their contributions.
- **Rollback:** disable `envelope-batch` in the import template registry and hide the UI tab. Code rollback is additive. Database rollback only removes the `envelope_batch` file-type check value when no envelope jobs exist.

---

## 9. Exit checklist (Phase 10 — Billing & GA)

Ticks the Phase 10 line **"Bulk slip / envelope import shipped (envelope-batch parser plugged into the existing `upload -> match -> schedule -> commit` pipeline, surfaced as a new tab on `/church/imports`). See [`CHURCHPLUS-PORT-NOTES.md` §2.2.3](../CHURCHPLUS-PORT-NOTES.md#223-bulk-slip--envelope-import-xlsxcsv)."** in `docs/ROADMAP.md`.

The PR is complete when every box below is checked:

- [ ] `IMPORT_FILE_TYPES` includes `envelope_batch`; `IMPORT_SOURCE_TYPES` includes `envelope_batch`.
- [ ] Drizzle migration updates `import_files_file_type_check` and does not alter contribution money/source checks.
- [ ] `importCreateSchema` accepts envelope metadata while rejecting invalid file/source combinations.
- [ ] Upload route accepts `fileType=envelope_batch` only for chapter + service-event scoped imports in v1.
- [ ] `parseImportBody` dispatches by import kind and the statement parser behavior remains unchanged.
- [ ] Envelope CSV parser exists with bounded rows / columns / cells and canonical header aliases.
- [ ] XLSX envelope parsing is either implemented with tests or explicitly deferred with user-facing copy limited to CSV.
- [ ] Envelope matcher resolves chapter, service event, member, giving type, payment method, giving period, currency, and idempotency key.
- [ ] `processed_transactions` is used for envelope duplicate detection and commit idempotency.
- [ ] `commitImport` dispatches to statement vs envelope materializers based on `import_files.file_type`.
- [ ] Statement commit tests still pass without behavior changes.
- [ ] Envelope commit creates posted `contribution_batches`, posted `contributions`, `contribution_lines`, `processed_transactions`, import row backfills, and audit rows in one transaction.
- [ ] Rollback voids envelope contributions, voids generated batches, removes processed transaction guards, and audits the rollback.
- [ ] `/church/imports` has `Statements` and `Envelope batches` tabs using `sl-*` primitives and `var(--*)` tokens.
- [ ] Envelope upload form sends `fileType=envelope_batch`, `sourceType=envelope_batch`, active chapter id, and selected service event id.
- [ ] Existing `/zone/imports/[id]` detail renders envelope rows and generated batch references.
- [ ] `envelope-batch` template is enabled for the church surface after parser support lands.
- [ ] Tests added: parser, matcher, commit / rollback, route RBAC, cross-tenant fuzz, and UI tab behavior.
- [ ] `pnpm -w lint`, `pnpm -w check`, and `pnpm -w test` all pass.
- [ ] `docs/DOMAIN-MODEL.md` documents envelope-batch import semantics and idempotency.
- [ ] `docs/CHURCHPLUS-PORT-NOTES.md` §2.2.3 marked landed after merge.
- [ ] `docs/ROADMAP.md` Phase 10 "Bulk slip / envelope import" item ticked after implementation.
- [ ] PR body mirrors this exit checklist and links back to `docs/plans/2026-05-28-envelope-import-v1.md`.

---

## Open questions for implementation

1. **XLSX in v1.** Church Plus accepted XLSX/CSV. The existing StewardLedger statement parser rejects XLSX. Recommendation: implement XLSX only for `envelope_batch` using the existing `xlsx` dependency, leaving bank-statement XLSX behavior unchanged.
2. **Anonymous envelopes.** Current parser can allow `member_id` null, but Church Plus envelope slips usually identify a member. Recommendation: require member in v1 and add anonymous support only if a real chapter sample needs it.
3. **Cash / cheque split.** Recommendation: reject rows with both cash and cheque amounts. Treasurers should enter two rows if one physical envelope truly contains both methods.
4. **Zone tab visibility.** Recommendation: template can be listed only on `surface=church` until zone-wide envelope uploads are explicitly designed.

