# Phase 8 — Paying-in books + reference-code validation

Closes the second Phase 8 exit checklist item:
**"Reference-code ranges validate during contribution entry."**

A paying-in book is a treasurer's deposit-slip pad: each slip
carries a unique reference code, the chapter owns the pad, and
the range covers some date window. When a treasurer enters a
batch's `referenceCode`, the system must confirm the code falls
within an active book range for that chapter on the batch's date.

## Schema (per DOMAIN-MODEL.md §8)

```sql
paying_in_books (
  id text pk
  zone_id text not null references zones on delete cascade
  chapter_id text not null references chapters (zone_id, id)
  reference_code_start text not null
  reference_code_end text not null
  date_from date not null
  date_to date null
  created_at, updated_at timestamptz

  -- A treasurer can hand out the same code twice across two pads
  -- (e.g. an old retired book with a code that gets reused on a
  -- fresh pad). The schema enforces only that within ONE row, the
  -- start <= end. Overlap is operator-controllable via the
  -- date_from / date_to window: an overlap warning could exist at
  -- the API layer but we don't enforce it server-side.

  check date_to is null or date_to >= date_from
  check reference_code_start <= reference_code_end
  index (zone_id, chapter_id, date_from, date_to)
)
```

Soft-delete: not added. A retired pad ends with `date_to` set.

### Reference-code comparison semantics

Stored as `text`. Validation compares lexicographically (PostgreSQL
default text ordering) — which works for treasurer pads using
zero-padded sequential codes ("0000001" .. "0000200") and for
alphanumeric prefixes ("PIB-A-001" .. "PIB-A-100"). The schema
doesn't try to parse a numeric form because the legacy app uses
both shapes; lexicographic ordering covers both as long as widths
are consistent **within a single book**.

Document this constraint in the route handler's error message so a
treasurer who enters a malformed code gets a clear "not in range"
back rather than a parse error.

## API

`/api/tenant/paying-in-books` mounted on tenantRouter:

- `GET /api/tenant/paying-in-books` — list with optional
  `chapterId` / active-on-date filters. Zone readers see every
  book; chapter readers see only their bound chapters'.
- `POST` create. Validates `(zone, chapter)` ownership and the
  date / range invariants.
- `PATCH /:id` partial update of date / range / chapter (rare but
  legal — treasurer corrects a typo).
- `DELETE /:id` hard delete with audit (no soft delete).

Access:

- READ: any zone reader; chapter readers clamped to their bound
  chapters.
- WRITE: zone finance admin / zone admin / zone owner;
  chapter admin for chapter-scoped writes.

## Validation hook

`packages/api/src/services/paying-in-books/validate.ts`:

```ts
export async function assertReferenceCodeInRange(
  db: Db,
  args: {
    zoneId: string,
    chapterId: string,
    referenceCode: string,
    onDate: string,  // ISO yyyy-mm-dd, typically the batch's
                     // contributionDate or createdAt date.
  }
): Promise<void>  // throws PayingInBookError if no match
```

Called from `createContribution`'s batch path (or directly when
the batch service inserts/updates a `referenceCode`). The error
is tagged so the route layer can map it to a 422.

For v1 the hook fires **on batch create + on batch update of
`referenceCode`**, not at posting time, so a treasurer gets
immediate feedback rather than a deferred reject when they hit
post. Posting after the fact still validates because the trigger
on `contribution_batches.status` change to `posted` doesn't need
to re-check (the code was validated at write time and is
immutable from outside corrections).

## Files

- `packages/db/src/schema/paying-in-books.ts` — new schema module.
- `packages/db/src/schema/index.ts` — export.
- `packages/db/drizzle/0005_*.sql` — generated migration.
- `packages/shared/src/schemas.ts` — Zod schemas for create /
  update / list query.
- `packages/api/src/services/paying-in-books/validate.ts` — the
  validation hook.
- `packages/api/src/routes/tenant-paying-in-books.ts` — router.
- `packages/api/src/routes/tenant.ts` — mount.
- `packages/api/src/routes/tenant-paying-in-books.test.ts` —
  cover the route.
- `packages/api/src/services/contribution-batches.ts` — call the
  validator at `createContributionBatch` and
  `patchContributionBatch` when `referenceCode` is supplied.
- `packages/api/src/services/contributions-service.test.ts` (or a
  new file under `paying-in-books/`) — cover the validation
  invariant.
- `docs/ROADMAP.md` — bump Phase 8 status; the exit checklist line
  flips to `[x]`.
- `docs/DOMAIN-MODEL.md` §8 — mark implemented.

## Non-goals (deferred)

- **Overlap warnings between books** — the schema permits
  overlap; if a treasurer wants to know about overlapping ranges
  the UI can flag it. Out of scope here.
- **Code-range allocation tracking** ("which codes inside a pad
  have been used") — that's a Phase 8+ tooling concern; v1
  validates membership of the range only.
- **UI** — the API contract is sufficient for this PR; UI for
  paying-in book CRUD + the inline validation feedback ships with
  the Phase 8 UI pass.

## Tests (vitest)

### `describe("paying-in-books routes")`

1. Create chapter-scoped book; list returns it.
2. Reject when chapter belongs to another zone (404).
3. Reject `reference_code_start > reference_code_end` at the DB
   CHECK (round-trip via 500-or-409, depending on how we surface
   it — schema-level CHECK is the canonical guard).
4. Reject `date_to < date_from`.
5. Chapter admin can create on their bound chapter; denied
   elsewhere.
6. Treasurer can read but not write.

### `describe("paying-in-book reference-code validator")`

1. **Happy path**: a book covering codes "0001"-"0100" on dates
   2025-01-01 onwards; a batch with `referenceCode='0050'` and
   contributionDate `2025-06-01` validates.
2. **Out-of-range code** ("0200") → tagged error.
3. **Out-of-window date** (book closed 2024-12-31) → tagged
   error.
4. **No book at all** → tagged error.
5. **Wrong chapter** — book belongs to chapter A, batch is on
   chapter B → tagged error.
6. **Open-ended book** (`date_to` null) accepts any future date.

### Integration

The contribution-batches service test gains one case: creating a
batch with a `referenceCode` that doesn't match any book yields
422 from the route, with the tagged error code surfaced.

## Acceptance

- `pnpm lint`, `pnpm check`, `pnpm test` green.
- ROADMAP.md Phase 8 audited status + exit checklist updated.
- DOMAIN-MODEL.md §8 marked implemented for `paying_in_books`.
