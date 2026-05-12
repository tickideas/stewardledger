# Domain Model

> Companion to [`PRD.md`](PRD.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).
> This is the target schema for v1. Source of truth for `packages/db`.
> Lessons distilled from the legacy Church Plus DB are in [`DOMAIN-REFERENCE.md`](DOMAIN-REFERENCE.md). We do not migrate from it.

---

## 1. Conventions

- All ids: `uuid` (v7) primary keys.
- All money: `numeric(19,4)` paired with `currency_code text not null` (ISO 4217).
- All timestamps: `timestamptz`, default `now()`.
- All dates: `date`.
- Soft-delete: `deleted_at timestamptz null` on entities that allow it (members soft-delete; contributions are NOT soft-deleted — they are voided/reversed).
- Audit columns (where applicable): `created_at`, `created_by_user_id`, `updated_at`, `updated_by_user_id`.
- Multi-tenancy: every domain table has `zone_id uuid not null references zones(id)`. The **zone is the tenant**.
- Chapter scoping: every chapter-bound table has `chapter_id uuid not null references chapters(id)`.
- Region denormalization: most domain tables also carry `region_id uuid null references regions(id)` for fast region-aware reports. A region change at zone level fans out via a maintenance job.
- Naming: `snake_case`, plural table names.

---

## 2. Identity, regions, zones, chapters

### 2.1 Users (global)

```sql
users
  id uuid pk
  email citext unique not null
  email_verified_at timestamptz null
  password_hash text null
  display_name text null
  default_zone_id uuid null references zones(id)
  is_super_admin boolean default false
  created_at, updated_at, deleted_at

-- Better Auth tables (sessions, otps, magic_link_tokens, accounts, mfa, ...)
-- managed by Better Auth; reference users(id).
```

A user is a **global account** keyed by email. The user can belong to many zones via `user_role_bindings`. Sign-in is global; on login the user picks (or is auto-routed to) a zone. A platform-only super-admin may have no active zone bindings; in that case they are routed to platform-admin surfaces such as `/admin/zones`, not tenant pages.

### 2.2 Regions (reference data, not a tenant)

```sql
regions
  id uuid pk
  name text unique not null               -- e.g. "Christ Embassy UK Region 1"
  short_code text unique null
  country_code text null
  is_active boolean not null default true
  created_at, updated_at
  created_by_user_id uuid null            -- platform admin who created/approved
```

- Curated by `region_curator` and `super_admin` platform roles.
- `regions` is global (not zone-scoped).
- Zones can submit unverified region names during signup; they live on the zone row until a curator promotes them into `regions` and re-points the zone.

### 2.3 Zones (THE TENANT)

```sql
zones
  id uuid pk
  region_id uuid null references regions(id)
  region_name_unverified text null         -- free-text region name awaiting curator review
  slug text unique not null                -- subdomain, e.g. "uk-zone-1"
  name text not null                       -- "Christ Embassy UK Zone 1"
  legal_name text null
  country_code text not null
  default_currency_code text not null      -- ISO 4217
  default_time_zone text not null
  fiscal_year_start_month smallint not null default 1
  ministry_year_start_month smallint not null default 1
  status text not null                     -- pending_setup | active | past_due | suspended
  branding jsonb not null default '{}'::jsonb
  plan_id uuid null references plans(id)
  activated_at timestamptz null             -- when paid/onboarded
  primary_contact_user_id uuid null
  created_at, updated_at, deleted_at

custom_domains
  id uuid pk
  zone_id uuid not null
  hostname text unique not null
  status text not null                     -- pending | verifying | active | failed
  verification_started_at, verified_at, last_error
  created_at, updated_at
```

Constraint: exactly one of `region_id` or `region_name_unverified` is set on a zone. Once a curator approves an unverified region, the zone is updated atomically: `region_id` set, `region_name_unverified` cleared, denormalized `region_id` columns updated across the zone's data.

**Region/zone name disjointness**: `regions.name` and `zones.name` share a single global, case-insensitive namespace — no region and zone may have the same name, and no two regions or two zones may collide. AGENTS rule 4 (no business logic in triggers) keeps this in the service layer (`assertNameAvailable` in `packages/api/src/services/names.ts`); per-table case-insensitive unique indexes (`lower(name)`) backstop accidental duplicates inside each table.

### 2.4 Chapters (the local church)

```sql
chapters
  id uuid pk
  zone_id uuid not null
  region_id uuid null                      -- denormalized from zone for reporting
  reference_code text not null             -- e.g. "LWUKZ100001" — generator preserves legacy-style format if requested
  name text not null
  country_code text null
  date_from date not null
  date_to date null                        -- null = active
  metadata jsonb not null default '{}'::jsonb
  created_at, updated_at, deleted_at
  unique (zone_id, reference_code)

chapter_name_history
  id uuid pk
  chapter_id uuid not null
  zone_id uuid not null
  name text not null
  date_from date not null
  date_to date not null
  created_at
```

### 2.5 Roles & bindings

```sql
roles
  id uuid pk
  zone_id uuid null                        -- null = platform-wide role
  code text not null                       -- e.g. "chapter_treasurer"
  name text not null
  scope text not null                      -- platform | zone | chapter
  permissions jsonb not null               -- e.g. ["contribution.read", "contribution.write"]
  is_system boolean not null default false
  unique (zone_id, code)

user_role_bindings
  id uuid pk
  user_id uuid not null
  zone_id uuid not null
  chapter_id uuid null                     -- null = zone-wide
  role_id uuid not null
  granted_by_user_id uuid null
  granted_at timestamptz default now()
  revoked_at timestamptz null
  unique (user_id, zone_id, chapter_id, role_id) where revoked_at is null
```

Bindings are tenant-scoped (`zone_id`). Session zone lookup ignores revoked bindings and soft-deleted zones. The current implementation stores the super-admin bit on `users.is_super_admin`; the fuller platform-role model (`super_admin`, `support_admin`, `billing_admin`, `region_curator`) is represented by a small `platform_role_bindings` table when those distinct roles are needed:

```sql
platform_role_bindings
  id uuid pk
  user_id uuid not null
  role_code text not null                  -- "super_admin" | "support_admin" | "billing_admin" | "region_curator"
  granted_by_user_id uuid null
  granted_at, revoked_at
```

### 2.6 Invitations

```sql
invitations
  id uuid pk
  zone_id uuid not null references zones(id) on delete cascade
  chapter_id uuid null references chapters(id) on delete cascade   -- required for chapter_* roles, forbidden otherwise (CHECK)
  email text not null                       -- always stored lowercase
  role_code text not null                   -- one of ZONE_ROLES | CHAPTER_ROLES
  token_hash text not null unique           -- sha256 of 32-byte url-safe token; raw token only in the email URL
  expires_at timestamptz not null           -- default 7 days from creation
  created_by_user_id uuid null              -- null for the bootstrap zone_owner invite at signup
  created_at timestamptz default now()
  accepted_at timestamptz null
  accepted_by_user_id uuid null
  revoked_at timestamptz null
  revoked_by_user_id uuid null
  unique (zone_id, email, chapter_id, role_code) where accepted_at is null and revoked_at is null
```

- A successful **public signup** writes one invitation for the primary contact email pinned to `zone_owner` and emails them a magic-link-style accept URL. No Better Auth user is created at signup.
- On accept (`POST /api/public/invitations/accept`): the invited person supplies their name and chooses a password. Better Auth `signUpEmail` runs with the email pinned by the invitation, then `applyAcceptedInvitation` writes a `user_role_bindings` row, marks the invite accepted, and — for `zone_owner` invites — promotes the zone from `pending_setup` to `active`.
- Team invitations follow the same shape but are created via `POST /api/tenant/invitations` (zone_owner / zone_admin only); the API forbids inviting a second `zone_owner`.
- Demo seeding creates tenant data only, not user accounts. Demo church/zone login accounts must be created by invitation acceptance, or accessed by a platform super-admin.

---

## 3. People

```sql
members
  id uuid pk
  zone_id uuid not null
  region_id uuid null                       -- denormalized
  chapter_id uuid null references chapters(id)   -- "home chapter"
  reference_code text not null              -- e.g. "M0000123"
  title_id uuid null references titles(id)
  first_name text not null
  middle_names text null
  last_name text null
  full_name text generated always as (
    -- concat_ws is STABLE in Postgres so it cannot power a generated column;
    -- this expression is the equivalent built from immutable string ops.
    trim(both ' ' from regexp_replace(
      coalesce(first_name, '') || ' ' || coalesce(middle_names, '') || ' ' || coalesce(last_name, ''),
      '\s+', ' ', 'g'
    ))
  ) stored
  gender text null                          -- "M" | "F" | "U"
  email citext null
  date_of_birth date null
  mobile text null
  telephone text null
  kingschat_username text null
  is_active boolean not null default true
  marital_status_id uuid null references marital_statuses(id)
  member_type_id uuid null references member_types(id)
  date_joined_ministry date null
  foundation_school_graduation_date date null
  is_cell boolean default false
  is_department boolean default false
  metadata jsonb not null default '{}'::jsonb
  created_at, created_by_user_id, updated_at, updated_by_user_id, deleted_at
  unique (zone_id, reference_code)

member_addresses
  id uuid pk
  zone_id uuid not null
  member_id uuid not null references members(id)
  is_primary boolean default false
  line1, line2, city, region_text, postcode, country_code
  date_from date not null default now()::date
  date_to date null
  created_at, updated_at

titles                  -- Mr, Mrs, Pastor, etc.
marital_statuses        -- Single, Married, ...
member_types            -- Member, Cell Leader, Pastor, ...
```

(All three lookup tables are zone-scoped with sensible seed data per zone.)

### Member dedup

```sql
member_merge_proposals
  id uuid pk
  zone_id uuid not null
  primary_member_id uuid not null references members(id)
  duplicate_member_id uuid not null references members(id)
  match_score numeric(5,2) not null
  matched_fields jsonb not null
  proposed_by_user_id uuid not null
  proposed_at timestamptz default now()
  reviewed_by_user_id uuid null
  reviewed_at timestamptz null
  status text not null                    -- pending | approved | rejected | applied
  applied_at timestamptz null
  notes text null

-- When applied, every reference to duplicate_member_id is rewritten to
-- primary_member_id via a deterministic, audit-logged migration job.
```

---

## 4. Giving setup

```sql
giving_categories
  id uuid pk
  zone_id uuid not null
  parent_category_id uuid null references giving_categories(id)
  name text not null
  short_code text null
  ordinal int not null default 0
  date_from date not null default now()::date
  date_to date null
  created_at, updated_at
  unique (zone_id, name)

giving_types
  id uuid pk
  zone_id uuid not null
  category_id uuid not null references giving_categories(id)
  name text not null
  short_code text null
  is_zonal boolean default false
  is_chapter boolean default true
  has_partnership_target boolean default false
  account_id uuid null references accounts(id)
  ordinal int not null default 0
  is_active boolean default true
  created_at, updated_at
  unique (zone_id, name)

payment_methods
  id uuid pk
  zone_id uuid not null
  code text not null                      -- "cash" | "cheque" | "card" | "bank_transfer" | "online" | "mobile_money"
  name text not null
  is_active boolean default true
  unique (zone_id, code)

accounts                                  -- conceptually a fund/bucket
  id uuid pk
  zone_id uuid not null
  name text not null
  description text null
  currency_code text not null             -- defaults to zone.default_currency_code; can override
  date_from date not null default now()::date
  date_to date null
  created_at, updated_at
  unique (zone_id, name)

giving_type_accounts
  id uuid pk
  zone_id uuid not null
  giving_type_id uuid not null
  account_id uuid not null
  date_from date not null
  date_to date null

service_types                             -- legacy MeetingType
  id uuid pk
  zone_id uuid not null
  name text not null
  short_code text null
  is_active boolean default true
  unique (zone_id, name)

service_events                            -- legacy Meeting
  id uuid pk
  zone_id uuid not null
  chapter_id uuid null references chapters(id)   -- null = zone-wide event
  service_type_id uuid not null references service_types(id)
  service_date date not null
  giving_period_id uuid null references giving_periods(id)
  notes text null
  created_at, updated_at
```

---

## 5. Periods

```sql
giving_periods                            -- one row per (zone, date)
  id uuid pk
  zone_id uuid not null
  date date not null
  weekday smallint not null
  iso_week int not null
  iso_year int not null
  month int not null
  quarter int not null
  fiscal_period_id uuid not null references fiscal_periods(id)
  ministry_period_id uuid not null references ministry_periods(id)
  partnership_period_id uuid not null references partnership_periods(id)
  unique (zone_id, date)

fiscal_years
  id uuid pk
  zone_id uuid not null
  year_label text not null                -- "FY2026"
  start_date date not null
  end_date date not null
  unique (zone_id, year_label)

fiscal_periods                            -- monthly periods within a fiscal year
  id uuid pk
  zone_id uuid not null
  fiscal_year_id uuid not null
  period_number smallint not null         -- 1..12
  start_date date not null
  end_date date not null
  status text not null default 'open'     -- open | closing | closed
  closed_at timestamptz null
  closed_by_user_id uuid null
  unique (zone_id, fiscal_year_id, period_number)

ministry_years
  id uuid pk
  zone_id uuid not null
  year_label text not null
  start_date date not null
  end_date date not null
  unique (zone_id, year_label)

ministry_periods
  id uuid pk
  zone_id uuid not null
  ministry_year_id uuid not null
  period_number smallint not null
  start_date date not null
  end_date date not null
  unique (zone_id, ministry_year_id, period_number)

partnership_years
  id uuid pk
  zone_id uuid not null
  year_label text not null
  start_date date not null
  end_date date not null

partnership_periods
  id uuid pk
  zone_id uuid not null
  partnership_year_id uuid not null
  period_number smallint not null
  start_date date not null
  end_date date not null
  unique (zone_id, partnership_year_id, period_number)
```

Each zone gets its own period rows, generated by a seed job at zone creation and on every fiscal/ministry-year start.

---

## 6. Contributions (unified envelope + online + import)

A single model handles every kind of giving capture:

```sql
contribution_batches
  id uuid pk
  zone_id uuid not null
  chapter_id uuid not null references chapters(id)
  service_event_id uuid null references service_events(id)
  payment_method_id uuid null references payment_methods(id)
  source_type text not null               -- envelope | online | bank_import | oblation | manual
  status text not null default 'draft'    -- draft | submitted | approved | posted | voided
  reference_code text null
  cash_total numeric(19,4) null
  cheque_total numeric(19,4) null
  currency_code text not null
  notes text null
  created_at, created_by_user_id, updated_at, updated_by_user_id
  submitted_at timestamptz null
  submitted_by_user_id uuid null
  approved_at timestamptz null
  approved_by_user_id uuid null
  posted_at timestamptz null
  posted_by_user_id uuid null
  voided_at timestamptz null
  voided_by_user_id uuid null
  void_reason text null

contributions
  id uuid pk
  zone_id uuid not null
  region_id uuid null                                 -- denormalized
  batch_id uuid null references contribution_batches(id)
  chapter_id uuid not null references chapters(id)
  member_id uuid null references members(id)          -- null allowed for anonymous
  parent_contribution_id uuid null references contributions(id)
  source_type text not null
  payment_method_id uuid null references payment_methods(id)
  service_event_id uuid null references service_events(id)
  giving_period_id uuid null references giving_periods(id)
  contribution_date date not null
  total_amount numeric(19,4) not null
  currency_code text not null
  external_transaction_id text null
  description text null
  status text not null default 'draft'                -- draft | posted | voided | reversed
  posted_at timestamptz null
  posted_by_user_id uuid null
  voided_at timestamptz null
  voided_by_user_id uuid null
  void_reason text null
  reversal_of_contribution_id uuid null
  created_at, created_by_user_id, updated_at, updated_by_user_id
  index (zone_id, chapter_id, contribution_date desc)
  index (zone_id, member_id, contribution_date desc)

contribution_lines
  id uuid pk
  zone_id uuid not null
  contribution_id uuid not null references contributions(id) on delete cascade
  giving_type_id uuid not null references giving_types(id)
  account_id uuid null references accounts(id)
  amount numeric(19,4) not null            -- signed; see "Sign convention" below
  currency_code text not null
  note text null
  created_at, updated_at

contribution_members                       -- multi-member contribution (oblation-style)
  id uuid pk
  zone_id uuid not null
  contribution_id uuid not null references contributions(id) on delete cascade
  member_id uuid not null references members(id)
  allocation_percent numeric(5,2) null check (allocation_percent is null or (allocation_percent between 0 and 100))
  created_at
```

### Posted-immutability

- `contributions` and `contribution_lines` rows in `posted` status cannot be updated or deleted.
- Database triggers enforce this (defined in `packages/db/src/bootstrap-triggers.ts`, applied by `pnpm --filter @stewardledger/db db:bootstrap`):
  - `contributions_posted_guard` permits only the void/reverse + bookkeeping columns to change once `status = 'posted'`; any other column change raises a `check_violation`.
  - `contributions_no_delete_when_posted` blocks deletes of `posted` rows.
  - `contribution_lines_posted_guard` blocks any insert / update / delete on lines once the parent contribution is `posted`, and refuses lines whose `currency_code` doesn't match their parent.
- Bootstrap is serialized by a session-level `pg_advisory_lock(hashtext('stewardledger.applyContributionTriggers'))` so concurrent test workers don't race the `drop trigger / create trigger` pair into a `tuple concurrently updated` error.
- Corrections are applied as **new** contributions with `reversal_of_contribution_id` set.

### Sign convention (Phase 5)

- Positive amounts are inflows / gifts; negative amounts are reversals.
- `reverseContribution` (in `packages/api/src/services/contributions.ts`)
  emits a corrective contribution whose `total_amount` is the negation of
  the original's, and whose lines are the exact negation of the original's
  lines, then flips the original to `status='reversed'`. Reports sum signed
  amounts, so original + reversal net to zero.
- The aggregate non-negative CHECKs that earlier sat on `contributions.total_amount`
  and `contribution_lines.amount` are intentionally NOT applied. Negative
  amounts are confined to the reversal flow: `createContribution` and
  `updateDraftContribution` reject non-positive line amounts (raising
  `non_positive_amount`); `reverseContribution` is the only path that
  emits them, and it constructs them by negating the original lines so
  `abs(reversal) === abs(original)` holds by construction. The
  posted-immutability triggers ensure the original is not retroactively edited.
  `contribution_batches.cash_total` / `cheque_total` retain their non-negative
  CHECKs — they are physical bag totals, never reversals.
- Reversal contributions are posted standalone (never inside the original
  batch); the corrective row records `parent_contribution_id` and
  `reversal_of_contribution_id` to link back.
- Implementation note: the corrective row is inserted with
  `status='draft'` first so the lines pass `contribution_lines_posted_guard`,
  then promoted to `posted` in the same tx; the original is flipped to
  `reversed` last so an audit reader sees cause-then-effect order.

### Currency rule

- `contribution.currency_code` defaults to the zone's `default_currency_code`
  in the service layer (`createContribution`) when callers don't supply one.
  Callers may override when the chosen `account` has a different currency.
- All `contribution_lines` of a single contribution must share the same
  `currency_code` as the contribution.
- All `contributions` attached to a `contribution_batch` must share the
  batch's `currency_code`. Enforced in
  `packages/api/src/services/contributions.ts` on attach and re-checked at
  batch-post time in `services/contribution-batches.ts`.
- Reports never mix currencies into a single number; mixed-currency totals are presented as per-currency subtotals.

---

## 7. Imports / file upload pipeline

```sql
import_files
  id uuid pk
  zone_id uuid not null
  chapter_id uuid null
  uploaded_by_user_id uuid not null
  original_file_name text not null
  storage_key text not null               -- object storage key
  size_bytes int not null
  checksum_sha256 text not null
  file_type text not null                 -- statement in Phase 6; member/giving/target deferred
  source_type text not null default 'generic_csv' -- generic_csv | bank_csv | online_giving
  uploaded_at timestamptz default now()

import_jobs
  id uuid pk
  zone_id uuid not null
  import_file_id uuid not null references import_files(id)
  status text not null                    -- received | parsing | parsed | matching | matched | scheduled | committing | committed | failed | rolled_back
  total_rows int not null default 0
  matched_rows int not null default 0
  unmatched_rows int not null default 0
  duplicate_rows int not null default 0
  failed_rows int not null default 0
  committed_rows int not null default 0
  started_at, finished_at, error_code, error_message
  created_at, updated_at

import_rows
  id uuid pk
  zone_id uuid not null
  import_job_id uuid not null references import_jobs(id) on delete cascade
  row_number int not null
  raw jsonb not null
  parsed jsonb null
  match_status text not null              -- pending | matched | partial | unmatched
  member_id uuid null
  chapter_id uuid null
  giving_type_id uuid null
  service_event_id uuid null
  giving_period_id uuid null
  account_id uuid null
  currency_code text null
  contribution_id uuid null               -- set on commit
  is_duplicate boolean default false
  duplicate_of_contribution_id uuid null
  validation_status text not null         -- pending | valid | invalid
  created_at, updated_at
  unique (import_job_id, row_number)

import_row_failures
  id uuid pk
  zone_id uuid not null
  row_id uuid not null references import_rows(id) on delete cascade
  failure_type_id uuid not null references import_failure_types(id) -- platform default or same-zone override
  details jsonb null

import_failure_types                      -- catalog
  id uuid pk
  zone_id uuid null                       -- null = platform default
  code text not null                      -- "MEMBER_NOT_FOUND" | "DUPLICATE" | "INVALID_AMOUNT" | "CURRENCY_MISMATCH" | ...
  description text not null
  details_placeholder text null

import_schedules                          -- "validated, ready to commit"
  id uuid pk
  zone_id uuid not null
  import_job_id uuid not null
  scheduled_by_user_id uuid not null
  scheduled_at timestamptz default now()
  committed_at timestamptz null
  committed_by_user_id uuid null

processed_transactions
  id uuid pk
  zone_id uuid not null
  external_transaction_id text not null
  import_job_id uuid not null
  processed_at timestamptz default now()
  unique (zone_id, external_transaction_id)
```

---

## 8. Targets

```sql
financial_targets
  id uuid pk
  zone_id uuid not null
  chapter_id uuid null references chapters(id)   -- null = zone-wide target
  giving_type_id uuid not null
  ministry_year_id uuid not null
  full_target numeric(19,2) not null
  monthly_target numeric(19,2) null
  weekly_breakdown numeric(19,2) null
  full_target_copies int null
  number_of_partners int null
  currency_code text not null
  created_at, updated_at

paying_in_books
  id uuid pk
  zone_id uuid not null
  chapter_id uuid not null
  reference_code_start text not null
  reference_code_end text not null
  date_from date not null
  date_to date null
  created_at, updated_at
```

---

## 9. Audit

```sql
audit_events
  id uuid pk
  zone_id uuid not null
  actor_user_id uuid null
  actor_role_code text null
  action text not null                    -- "contribution.post"
  entity_type text not null
  entity_id uuid null
  before jsonb null
  after jsonb null
  reason text null
  ip_address inet null
  user_agent text null
  request_id text null
  occurred_at timestamptz default now()
  index (zone_id, entity_type, entity_id)
  index (zone_id, occurred_at desc)
```

Append-only. Never updated. Retained per tenant retention policy.

---

## 10. Notifications

```sql
email_templates
  id uuid pk
  zone_id uuid null                       -- null = platform default
  code text not null                      -- "welcome" | "otp" | "statement_ready"
  subject text not null
  html_body text not null
  text_body text null
  unique (zone_id, code)

email_messages
  id uuid pk
  zone_id uuid null
  to_email citext not null
  template_code text not null
  payload jsonb not null
  status text not null                    -- queued | sent | failed
  sent_at timestamptz null
  error text null
  created_at
```

---

## 11. Plans / billing

```sql
plans
  id uuid pk
  code text unique not null               -- "founding" | "standard" | "premium"
  name text not null
  monthly_price_amount numeric(19,2) not null
  annual_price_amount numeric(19,2) null  -- prepay discount (default offering)
  price_currency text not null            -- billing currency, NOT zone operating currency
  features jsonb not null default '{}'

subscriptions
  id uuid pk
  zone_id uuid not null
  plan_id uuid not null references plans(id)
  billing_mode text not null              -- "stripe" | "invoice"
  status text not null                    -- pending | active | past_due | canceled | suspended
  stripe_customer_id text null
  stripe_subscription_id text null
  invoice_contact_email citext null       -- for billing_mode = invoice
  current_period_start, current_period_end
  cancel_at_period_end boolean default false
  created_at, updated_at
```

A billing party owning multiple zones holds one subscription per zone. There is no "trialing" status — zones are either pending paid setup, active, past_due, canceled, or suspended. Stripe integration spec lives in `docs/BILLING.md` (drafted in Phase 10).

---

## 12. Invariants

1. Every domain row has `zone_id`. Application middleware enforces it.
2. `contributions` rows in `posted` are immutable except for void/reversal flow.
3. `contribution_lines.amount` is signed: positive on inflow contributions, negative on reversals. Service-layer write paths reject non-positive amounts on every endpoint other than `reverseContribution`, which is the only place that emits negatives. The `total_amount` on `contributions` equals the signed sum of its lines; this invariant is enforced by the service layer (`createContribution` / `updateDraftContribution`), not by a DB constraint. See §6 "Sign convention (Phase 5)".
4. All `contribution_lines` of a contribution share its `currency_code`.
5. `import_jobs.status = 'committed'` ⇒ every non-duplicate `import_rows` row committed by that job has `validation_status = 'valid'` and points to a `contribution_id`; duplicate rows remain linked only to their duplicate source.
6. Audit event rows are never updated or deleted by application code.
7. A user's `user_role_bindings` resolves their permission set; absence ⇒ no access.
8. `members.reference_code` is unique within `zone_id`.
9. A zone has either `region_id` or `region_name_unverified` set, never both, never neither (after onboarding).
10. `processed_transactions` enforces idempotent imports per zone.

---

## 13. Reference: legacy domain → StewardLedger

This is **not a migration map** — StewardLedger does not import legacy data. It documents how the legacy concepts inform the new model, for design clarity.

| Legacy concept | StewardLedger concept |
|---|---|
| Single-DB per zone deployment | Multi-tenant `zones` rows in shared DB |
| `ChurchGroup` (sub-grouping inside a zone, sometimes used as a region label) | Either dropped, or modeled as `region` (curated reference data) |
| `Chapter` | `chapters` |
| `Member`, `MemberAddress` | `members`, `member_addresses` |
| `GivingCategory`, `GivingType` | same names, multi-tenant |
| `PaymentMethod`, `Account` | same names, multi-tenant |
| `MeetingType`, `Meeting` | `service_types`, `service_events` |
| `GivingsPeriod` (date dimension) | `giving_periods` (regenerated per zone) |
| `PartnershipPeriod` | `partnership_years`, `partnership_periods` |
| `Givings` (online/import) | `contributions` + `contribution_lines` |
| `ChurchEnvelope` + `ChurchEnvelopeGivings` | `contribution_batches` + `contributions` + `contribution_lines` |
| `OblationEnvelope*` | `contributions` + `contribution_members` (`source_type='oblation'`) |
| `TransactionUpload` | `processed_transactions` |
| `*_History` tables/triggers | `audit_events` |
| `TransferHolding.ChurchPlusStatement_Holding` | `import_files` + `import_rows` |
| `TransferHolding.ChurchPlusStatement_Schedule` | `import_schedules` + `import_rows` (matched) |
| `TransferHolding.FileUpload_ProcessFile` | `import_jobs` |
| `TransferHolding.FileUpload_ProcessFile_FailureType` | `import_failure_types` |
| `cto.GivingTypeAccount` | `giving_type_accounts` |
| `cto.MinistryCalendar` | `ministry_years` |
| `cto.FinancialTarget` | `financial_targets` |
| `cto.PayingInBook` | `paying_in_books` |
| `cto.Transaction`, `cto.TransactionType` | flattened into `contributions` |
| `AspNetUsers` / `AspNetRoles` | `users`, `roles`, `user_role_bindings` (Better Auth handles credentials) |

If a future zone wants to migrate from legacy Church Plus, an ETL can be built on top of this map. It is not part of v1.
