CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"image" text,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"default_zone_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_code" text,
	"country_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "custom_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verification_started_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" text PRIMARY KEY NOT NULL,
	"region_id" text,
	"region_name_unverified" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"country_code" text NOT NULL,
	"default_currency_code" text NOT NULL,
	"default_time_zone" text NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"ministry_year_start_month" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'pending_setup' NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"primary_contact_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "zones_region_xor_unverified" CHECK ((region_id is not null and region_name_unverified is null)
          or (region_id is null and region_name_unverified is not null))
);
--> statement-breakpoint
CREATE TABLE "chapter_name_history" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text NOT NULL,
	"name" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"region_id" text,
	"reference_code" text NOT NULL,
	"name" text NOT NULL,
	"country_code" text,
	"date_from" date NOT NULL,
	"date_to" date,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chapters_zone_row_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "platform_role_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role_code" text NOT NULL,
	"granted_by_user_id" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_role_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text,
	"role_id" text NOT NULL,
	"granted_by_user_id" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text,
	"email" text NOT NULL,
	"role_code" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	CONSTRAINT "invitations_role_consistent_with_chapter" CHECK ((chapter_id is null) or (role_code like 'chapter_%'))
);
--> statement-breakpoint
CREATE TABLE "marital_statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_types" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"name" text NOT NULL,
	"gender" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "titles_gender_check" CHECK ("titles"."gender" is null or "titles"."gender" in ('M', 'F'))
);
--> statement-breakpoint
CREATE TABLE "member_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"member_id" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"line1" text,
	"line2" text,
	"city" text,
	"region_text" text,
	"postcode" text,
	"country_code" text,
	"date_from" date NOT NULL,
	"date_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_merge_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"primary_member_id" text NOT NULL,
	"duplicate_member_id" text NOT NULL,
	"match_score" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"matched_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_by_user_id" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "member_merge_proposals_distinct" CHECK (primary_member_id <> duplicate_member_id),
	CONSTRAINT "member_merge_proposals_status_check" CHECK ("member_merge_proposals"."status" in ('pending', 'approved', 'rejected', 'applied'))
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"region_id" text,
	"chapter_id" text,
	"reference_code" text NOT NULL,
	"title_id" text,
	"first_name" text NOT NULL,
	"middle_names" text,
	"last_name" text,
	"full_name" text GENERATED ALWAYS AS (trim(both ' ' from regexp_replace(
        coalesce(first_name, '') || ' ' || coalesce(middle_names, '') || ' ' || coalesce(last_name, ''),
        's+', ' ', 'g'
      ))) STORED,
	"gender" text,
	"email" text,
	"date_of_birth" date,
	"mobile" text,
	"telephone" text,
	"kingschat_username" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"marital_status_id" text,
	"member_type_id" text,
	"date_joined_ministry" date,
	"foundation_school_graduation_date" date,
	"is_cell" boolean DEFAULT false NOT NULL,
	"is_department" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "members_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "members_gender_valid" CHECK (gender is null or gender in ('M', 'F', 'U'))
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"fiscal_year_id" text NOT NULL,
	"period_number" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_periods_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "fiscal_periods_number_check" CHECK ("fiscal_periods"."period_number" between 1 and 12),
	CONSTRAINT "fiscal_periods_dates_check" CHECK ("fiscal_periods"."end_date" >= "fiscal_periods"."start_date"),
	CONSTRAINT "fiscal_periods_status_check" CHECK ("fiscal_periods"."status" in ('open', 'closing', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "fiscal_years" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"year_label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_years_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "fiscal_years_dates_check" CHECK ("fiscal_years"."end_date" >= "fiscal_years"."start_date")
);
--> statement-breakpoint
CREATE TABLE "giving_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"date" date NOT NULL,
	"weekday" integer NOT NULL,
	"iso_week" integer NOT NULL,
	"iso_year" integer NOT NULL,
	"month" integer NOT NULL,
	"quarter" integer NOT NULL,
	"fiscal_period_id" text NOT NULL,
	"ministry_period_id" text NOT NULL,
	"partnership_period_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giving_periods_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "giving_periods_weekday_check" CHECK ("giving_periods"."weekday" between 1 and 7),
	CONSTRAINT "giving_periods_iso_week_check" CHECK ("giving_periods"."iso_week" between 1 and 53),
	CONSTRAINT "giving_periods_month_check" CHECK ("giving_periods"."month" between 1 and 12),
	CONSTRAINT "giving_periods_quarter_check" CHECK ("giving_periods"."quarter" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "ministry_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"ministry_year_id" text NOT NULL,
	"period_number" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ministry_periods_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "ministry_periods_number_check" CHECK ("ministry_periods"."period_number" between 1 and 12),
	CONSTRAINT "ministry_periods_dates_check" CHECK ("ministry_periods"."end_date" >= "ministry_periods"."start_date")
);
--> statement-breakpoint
CREATE TABLE "ministry_years" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"year_label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ministry_years_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "ministry_years_dates_check" CHECK ("ministry_years"."end_date" >= "ministry_years"."start_date")
);
--> statement-breakpoint
CREATE TABLE "partnership_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"partnership_year_id" text NOT NULL,
	"period_number" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partnership_periods_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "partnership_periods_number_check" CHECK ("partnership_periods"."period_number" between 1 and 12),
	CONSTRAINT "partnership_periods_dates_check" CHECK ("partnership_periods"."end_date" >= "partnership_periods"."start_date")
);
--> statement-breakpoint
CREATE TABLE "partnership_years" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"year_label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partnership_years_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "partnership_years_dates_check" CHECK ("partnership_years"."end_date" >= "partnership_years"."start_date")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"currency_code" text NOT NULL,
	"date_from" date DEFAULT now()::date NOT NULL,
	"date_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "accounts_dates_check" CHECK ("accounts"."date_to" is null or "accounts"."date_to" >= "accounts"."date_from")
);
--> statement-breakpoint
CREATE TABLE "giving_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"parent_category_id" text,
	"name" text NOT NULL,
	"short_code" text,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"date_from" date DEFAULT now()::date NOT NULL,
	"date_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giving_categories_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "giving_categories_dates_check" CHECK ("giving_categories"."date_to" is null or "giving_categories"."date_to" >= "giving_categories"."date_from")
);
--> statement-breakpoint
CREATE TABLE "giving_type_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"giving_type_id" text NOT NULL,
	"account_id" text NOT NULL,
	"date_from" date DEFAULT now()::date NOT NULL,
	"date_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giving_type_accounts_dates_check" CHECK ("giving_type_accounts"."date_to" is null or "giving_type_accounts"."date_to" >= "giving_type_accounts"."date_from")
);
--> statement-breakpoint
CREATE TABLE "giving_types" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"short_code" text,
	"is_zonal" boolean DEFAULT false NOT NULL,
	"is_chapter" boolean DEFAULT true NOT NULL,
	"has_partnership_target" boolean DEFAULT false NOT NULL,
	"account_id" text,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giving_types_zone_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_zone_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "service_events" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text,
	"service_type_id" text NOT NULL,
	"service_date" date NOT NULL,
	"giving_period_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_events_zone_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "service_types" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"name" text NOT NULL,
	"short_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_types_zone_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "contribution_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text NOT NULL,
	"service_event_id" text,
	"payment_method_id" text,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reference_code" text,
	"cash_total" numeric(19, 4),
	"cheque_total" numeric(19, 4),
	"currency_code" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" text,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"posted_at" timestamp with time zone,
	"posted_by_user_id" text,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" text,
	"void_reason" text,
	CONSTRAINT "contribution_batches_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "contribution_batches_source_type_check" CHECK ("contribution_batches"."source_type" in ('envelope', 'online', 'bank_import', 'oblation', 'manual')),
	CONSTRAINT "contribution_batches_status_check" CHECK ("contribution_batches"."status" in ('draft', 'submitted', 'approved', 'posted', 'voided')),
	CONSTRAINT "contribution_batches_cash_total_nonneg" CHECK ("contribution_batches"."cash_total" is null or "contribution_batches"."cash_total" >= 0),
	CONSTRAINT "contribution_batches_cheque_total_nonneg" CHECK ("contribution_batches"."cheque_total" is null or "contribution_batches"."cheque_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contribution_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"contribution_id" text NOT NULL,
	"giving_type_id" text NOT NULL,
	"account_id" text,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_lines_zone_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "contribution_members" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"contribution_id" text NOT NULL,
	"member_id" text NOT NULL,
	"allocation_percent" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_members_unique" UNIQUE("contribution_id","member_id"),
	CONSTRAINT "contribution_members_allocation_range" CHECK ("contribution_members"."allocation_percent" is null or ("contribution_members"."allocation_percent" >= 0 and "contribution_members"."allocation_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"region_id" text,
	"batch_id" text,
	"chapter_id" text NOT NULL,
	"member_id" text,
	"parent_contribution_id" text,
	"source_type" text NOT NULL,
	"payment_method_id" text,
	"service_event_id" text,
	"giving_period_id" text,
	"contribution_date" date NOT NULL,
	"total_amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"external_transaction_id" text,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by_user_id" text,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" text,
	"void_reason" text,
	"reversal_of_contribution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "contributions_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "contributions_source_type_check" CHECK ("contributions"."source_type" in ('envelope', 'online', 'bank_import', 'oblation', 'manual')),
	CONSTRAINT "contributions_status_check" CHECK ("contributions"."status" in ('draft', 'posted', 'voided', 'reversed')),
	CONSTRAINT "contributions_posted_requires_timestamp" CHECK (("contributions"."status" <> 'posted') or ("contributions"."posted_at" is not null)),
	CONSTRAINT "contributions_voided_requires_timestamp" CHECK (("contributions"."status" <> 'voided') or ("contributions"."voided_at" is not null)),
	CONSTRAINT "contributions_reversal_not_self" CHECK ("contributions"."reversal_of_contribution_id" is null or "contributions"."reversal_of_contribution_id" <> "contributions"."id"),
	CONSTRAINT "contributions_parent_not_self" CHECK ("contributions"."parent_contribution_id" is null or "contributions"."parent_contribution_id" <> "contributions"."id")
);
--> statement-breakpoint
CREATE TABLE "import_failure_types" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"details_placeholder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_files" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text,
	"uploaded_by_user_id" text,
	"original_file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"file_type" text NOT NULL,
	"source_type" text DEFAULT 'generic_csv' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_files_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "import_files_file_type_check" CHECK ("import_files"."file_type" in ('statement', 'member', 'giving', 'target'))
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"import_file_id" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"matched_rows" integer DEFAULT 0 NOT NULL,
	"unmatched_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "import_jobs_status_check" CHECK ("import_jobs"."status" in (
        'received', 'parsing', 'parsed', 'matching', 'matched',
        'scheduled', 'committing', 'committed', 'failed', 'rolled_back'
      ))
);
--> statement-breakpoint
CREATE TABLE "import_row_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"row_id" text NOT NULL,
	"failure_type_id" text NOT NULL,
	"failure_code" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"import_job_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"parsed" jsonb,
	"match_status" text DEFAULT 'pending' NOT NULL,
	"member_id" text,
	"chapter_id" text,
	"giving_type_id" text,
	"service_event_id" text,
	"giving_period_id" text,
	"account_id" text,
	"payment_method_id" text,
	"currency_code" text,
	"external_transaction_id" text,
	"contribution_id" text,
	"is_duplicate" boolean DEFAULT false NOT NULL,
	"duplicate_of_contribution_id" text,
	"validation_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "import_rows_job_row_unique" UNIQUE("import_job_id","row_number"),
	CONSTRAINT "import_rows_match_status_check" CHECK ("import_rows"."match_status" in ('pending', 'matched', 'partial', 'unmatched')),
	CONSTRAINT "import_rows_validation_status_check" CHECK ("import_rows"."validation_status" in ('pending', 'valid', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE "import_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"import_job_id" text NOT NULL,
	"scheduled_by_user_id" text,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"committed_by_user_id" text,
	"rolled_back_at" timestamp with time zone,
	"rolled_back_by_user_id" text,
	"rolled_back_reason" text,
	CONSTRAINT "import_schedules_zone_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "processed_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"external_transaction_id" text NOT NULL,
	"import_job_id" text NOT NULL,
	"contribution_id" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_transactions_zone_ext_unique" UNIQUE("zone_id","external_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"actor_user_id" text,
	"actor_role_code" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip_address" "inet",
	"user_agent" text,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_primary_contact_user_id_user_id_fk" FOREIGN KEY ("primary_contact_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_name_history" ADD CONSTRAINT "chapter_name_history_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_name_history" ADD CONSTRAINT "chapter_name_history_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_bindings" ADD CONSTRAINT "platform_role_bindings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_bindings" ADD CONSTRAINT "platform_role_bindings_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD CONSTRAINT "user_role_bindings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD CONSTRAINT "user_role_bindings_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD CONSTRAINT "user_role_bindings_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD CONSTRAINT "user_role_bindings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD CONSTRAINT "user_role_bindings_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marital_statuses" ADD CONSTRAINT "marital_statuses_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_types" ADD CONSTRAINT "member_types_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_addresses" ADD CONSTRAINT "member_addresses_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_addresses" ADD CONSTRAINT "member_addresses_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_merge_proposals" ADD CONSTRAINT "member_merge_proposals_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_merge_proposals" ADD CONSTRAINT "member_merge_proposals_primary_member_id_members_id_fk" FOREIGN KEY ("primary_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_merge_proposals" ADD CONSTRAINT "member_merge_proposals_duplicate_member_id_members_id_fk" FOREIGN KEY ("duplicate_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_merge_proposals" ADD CONSTRAINT "member_merge_proposals_proposed_by_user_id_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_merge_proposals" ADD CONSTRAINT "member_merge_proposals_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_marital_status_id_marital_statuses_id_fk" FOREIGN KEY ("marital_status_id") REFERENCES "public"."marital_statuses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_member_type_id_member_types_id_fk" FOREIGN KEY ("member_type_id") REFERENCES "public"."member_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_year_zone_fk" FOREIGN KEY ("zone_id","fiscal_year_id") REFERENCES "public"."fiscal_years"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_periods" ADD CONSTRAINT "giving_periods_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_periods" ADD CONSTRAINT "giving_periods_fiscal_period_zone_fk" FOREIGN KEY ("zone_id","fiscal_period_id") REFERENCES "public"."fiscal_periods"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_periods" ADD CONSTRAINT "giving_periods_ministry_period_zone_fk" FOREIGN KEY ("zone_id","ministry_period_id") REFERENCES "public"."ministry_periods"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_periods" ADD CONSTRAINT "giving_periods_partnership_period_zone_fk" FOREIGN KEY ("zone_id","partnership_period_id") REFERENCES "public"."partnership_periods"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ministry_periods" ADD CONSTRAINT "ministry_periods_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ministry_periods" ADD CONSTRAINT "ministry_periods_year_zone_fk" FOREIGN KEY ("zone_id","ministry_year_id") REFERENCES "public"."ministry_years"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ministry_years" ADD CONSTRAINT "ministry_years_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partnership_periods" ADD CONSTRAINT "partnership_periods_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partnership_periods" ADD CONSTRAINT "partnership_periods_year_zone_fk" FOREIGN KEY ("zone_id","partnership_year_id") REFERENCES "public"."partnership_years"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partnership_years" ADD CONSTRAINT "partnership_years_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_categories" ADD CONSTRAINT "giving_categories_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_categories" ADD CONSTRAINT "giving_categories_parent_category_id_giving_categories_id_fk" FOREIGN KEY ("parent_category_id") REFERENCES "public"."giving_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_categories" ADD CONSTRAINT "giving_categories_parent_zone_fk" FOREIGN KEY ("zone_id","parent_category_id") REFERENCES "public"."giving_categories"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_type_accounts" ADD CONSTRAINT "giving_type_accounts_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_type_accounts" ADD CONSTRAINT "giving_type_accounts_type_zone_fk" FOREIGN KEY ("zone_id","giving_type_id") REFERENCES "public"."giving_types"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_type_accounts" ADD CONSTRAINT "giving_type_accounts_account_zone_fk" FOREIGN KEY ("zone_id","account_id") REFERENCES "public"."accounts"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_types" ADD CONSTRAINT "giving_types_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_types" ADD CONSTRAINT "giving_types_category_zone_fk" FOREIGN KEY ("zone_id","category_id") REFERENCES "public"."giving_categories"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giving_types" ADD CONSTRAINT "giving_types_account_zone_fk" FOREIGN KEY ("zone_id","account_id") REFERENCES "public"."accounts"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_service_type_zone_fk" FOREIGN KEY ("zone_id","service_type_id") REFERENCES "public"."service_types"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_giving_period_zone_fk" FOREIGN KEY ("zone_id","giving_period_id") REFERENCES "public"."giving_periods"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_types" ADD CONSTRAINT "service_types_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_submitted_by_user_id_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_posted_by_user_id_user_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_voided_by_user_id_user_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_service_event_zone_fk" FOREIGN KEY ("zone_id","service_event_id") REFERENCES "public"."service_events"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_batches" ADD CONSTRAINT "contribution_batches_payment_method_zone_fk" FOREIGN KEY ("zone_id","payment_method_id") REFERENCES "public"."payment_methods"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_lines" ADD CONSTRAINT "contribution_lines_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_lines" ADD CONSTRAINT "contribution_lines_contribution_zone_fk" FOREIGN KEY ("zone_id","contribution_id") REFERENCES "public"."contributions"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_lines" ADD CONSTRAINT "contribution_lines_giving_type_zone_fk" FOREIGN KEY ("zone_id","giving_type_id") REFERENCES "public"."giving_types"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_lines" ADD CONSTRAINT "contribution_lines_account_zone_fk" FOREIGN KEY ("zone_id","account_id") REFERENCES "public"."accounts"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_members" ADD CONSTRAINT "contribution_members_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_members" ADD CONSTRAINT "contribution_members_contribution_zone_fk" FOREIGN KEY ("zone_id","contribution_id") REFERENCES "public"."contributions"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_members" ADD CONSTRAINT "contribution_members_member_zone_fk" FOREIGN KEY ("zone_id","member_id") REFERENCES "public"."members"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_posted_by_user_id_user_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_voided_by_user_id_user_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_batch_zone_fk" FOREIGN KEY ("zone_id","batch_id") REFERENCES "public"."contribution_batches"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_member_zone_fk" FOREIGN KEY ("zone_id","member_id") REFERENCES "public"."members"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_payment_method_zone_fk" FOREIGN KEY ("zone_id","payment_method_id") REFERENCES "public"."payment_methods"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_service_event_zone_fk" FOREIGN KEY ("zone_id","service_event_id") REFERENCES "public"."service_events"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_giving_period_zone_fk" FOREIGN KEY ("zone_id","giving_period_id") REFERENCES "public"."giving_periods"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_reversal_of_zone_fk" FOREIGN KEY ("zone_id","reversal_of_contribution_id") REFERENCES "public"."contributions"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_parent_zone_fk" FOREIGN KEY ("zone_id","parent_contribution_id") REFERENCES "public"."contributions"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_failure_types" ADD CONSTRAINT "import_failure_types_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_file_zone_fk" FOREIGN KEY ("zone_id","import_file_id") REFERENCES "public"."import_files"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_failures" ADD CONSTRAINT "import_row_failures_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_failures" ADD CONSTRAINT "import_row_failures_failure_type_id_import_failure_types_id_fk" FOREIGN KEY ("failure_type_id") REFERENCES "public"."import_failure_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_failures" ADD CONSTRAINT "import_row_failures_row_zone_fk" FOREIGN KEY ("zone_id","row_id") REFERENCES "public"."import_rows"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_zone_fk" FOREIGN KEY ("zone_id","import_job_id") REFERENCES "public"."import_jobs"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_member_zone_fk" FOREIGN KEY ("zone_id","member_id") REFERENCES "public"."members"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_giving_type_zone_fk" FOREIGN KEY ("zone_id","giving_type_id") REFERENCES "public"."giving_types"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_service_event_zone_fk" FOREIGN KEY ("zone_id","service_event_id") REFERENCES "public"."service_events"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_giving_period_zone_fk" FOREIGN KEY ("zone_id","giving_period_id") REFERENCES "public"."giving_periods"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_account_zone_fk" FOREIGN KEY ("zone_id","account_id") REFERENCES "public"."accounts"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_payment_method_zone_fk" FOREIGN KEY ("zone_id","payment_method_id") REFERENCES "public"."payment_methods"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_contribution_zone_fk" FOREIGN KEY ("zone_id","contribution_id") REFERENCES "public"."contributions"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_duplicate_of_zone_fk" FOREIGN KEY ("zone_id","duplicate_of_contribution_id") REFERENCES "public"."contributions"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_schedules" ADD CONSTRAINT "import_schedules_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_schedules" ADD CONSTRAINT "import_schedules_scheduled_by_user_id_user_id_fk" FOREIGN KEY ("scheduled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_schedules" ADD CONSTRAINT "import_schedules_committed_by_user_id_user_id_fk" FOREIGN KEY ("committed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_schedules" ADD CONSTRAINT "import_schedules_rolled_back_by_user_id_user_id_fk" FOREIGN KEY ("rolled_back_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_schedules" ADD CONSTRAINT "import_schedules_job_zone_fk" FOREIGN KEY ("zone_id","import_job_id") REFERENCES "public"."import_jobs"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_transactions" ADD CONSTRAINT "processed_transactions_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_transactions" ADD CONSTRAINT "processed_transactions_job_zone_fk" FOREIGN KEY ("zone_id","import_job_id") REFERENCES "public"."import_jobs"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_transactions" ADD CONSTRAINT "processed_transactions_contribution_zone_fk" FOREIGN KEY ("zone_id","contribution_id") REFERENCES "public"."contributions"("zone_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_name_lower_idx" ON "regions" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "regions_short_code_idx" ON "regions" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_hostname_idx" ON "custom_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "custom_domains_zone_id_idx" ON "custom_domains" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_slug_idx" ON "zones" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_name_lower_idx" ON "zones" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "zones_region_id_idx" ON "zones" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "zones_status_idx" ON "zones" USING btree ("status");--> statement-breakpoint
CREATE INDEX "zones_unverified_region_idx" ON "zones" USING btree ("created_at") WHERE region_id is null and region_name_unverified is not null;--> statement-breakpoint
CREATE INDEX "chapter_name_history_chapter_id_idx" ON "chapter_name_history" USING btree ("chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_zone_reference_idx" ON "chapters" USING btree ("zone_id","reference_code");--> statement-breakpoint
CREATE INDEX "chapters_zone_id_idx" ON "chapters" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "chapters_region_id_idx" ON "chapters" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "platform_role_bindings_user_idx" ON "platform_role_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_role_bindings_unique_idx" ON "platform_role_bindings" USING btree ("user_id","role_code") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_zone_code_idx" ON "roles" USING btree ("zone_id","code");--> statement-breakpoint
CREATE INDEX "user_role_bindings_user_idx" ON "user_role_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_role_bindings_zone_idx" ON "user_role_bindings" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "user_role_bindings_chapter_idx" ON "user_role_bindings" USING btree ("chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_bindings_unique_active_idx" ON "user_role_bindings" USING btree ("user_id","zone_id","chapter_id","role_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_zone_idx" ON "invitations" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_unique_idx" ON "invitations" USING btree ("zone_id","email","chapter_id","role_code") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "marital_statuses_zone_name_lower_idx" ON "marital_statuses" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE INDEX "marital_statuses_zone_idx" ON "marital_statuses" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_types_zone_name_lower_idx" ON "member_types" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE INDEX "member_types_zone_idx" ON "member_types" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "titles_zone_name_lower_idx" ON "titles" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE INDEX "titles_zone_idx" ON "titles" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "member_addresses_member_idx" ON "member_addresses" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "member_addresses_zone_idx" ON "member_addresses" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_addresses_one_primary_active_idx" ON "member_addresses" USING btree ("member_id") WHERE is_primary = true and date_to is null;--> statement-breakpoint
CREATE INDEX "member_merge_proposals_zone_status_idx" ON "member_merge_proposals" USING btree ("zone_id","status");--> statement-breakpoint
CREATE INDEX "member_merge_proposals_primary_idx" ON "member_merge_proposals" USING btree ("primary_member_id");--> statement-breakpoint
CREATE INDEX "member_merge_proposals_duplicate_idx" ON "member_merge_proposals" USING btree ("duplicate_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_merge_proposals_open_pair_idx" ON "member_merge_proposals" USING btree ("primary_member_id","duplicate_member_id") WHERE status in ('pending', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "members_zone_reference_idx" ON "members" USING btree ("zone_id","reference_code");--> statement-breakpoint
CREATE INDEX "members_zone_chapter_idx" ON "members" USING btree ("zone_id","chapter_id");--> statement-breakpoint
CREATE INDEX "members_zone_active_idx" ON "members" USING btree ("zone_id") WHERE deleted_at is null and is_active = true;--> statement-breakpoint
CREATE INDEX "members_zone_email_lower_idx" ON "members" USING btree ("zone_id",lower("email"));--> statement-breakpoint
CREATE INDEX "members_zone_full_name_lower_idx" ON "members" USING btree ("zone_id",lower("full_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_zone_year_number_idx" ON "fiscal_periods" USING btree ("zone_id","fiscal_year_id","period_number");--> statement-breakpoint
CREATE INDEX "fiscal_periods_zone_dates_idx" ON "fiscal_periods" USING btree ("zone_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "fiscal_periods_status_idx" ON "fiscal_periods" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_years_zone_label_idx" ON "fiscal_years" USING btree ("zone_id","year_label");--> statement-breakpoint
CREATE INDEX "fiscal_years_zone_dates_idx" ON "fiscal_years" USING btree ("zone_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "giving_periods_zone_date_idx" ON "giving_periods" USING btree ("zone_id","date");--> statement-breakpoint
CREATE INDEX "giving_periods_zone_fiscal_idx" ON "giving_periods" USING btree ("zone_id","fiscal_period_id");--> statement-breakpoint
CREATE INDEX "giving_periods_zone_ministry_idx" ON "giving_periods" USING btree ("zone_id","ministry_period_id");--> statement-breakpoint
CREATE INDEX "giving_periods_zone_partnership_idx" ON "giving_periods" USING btree ("zone_id","partnership_period_id");--> statement-breakpoint
CREATE INDEX "giving_periods_month_idx" ON "giving_periods" USING btree ("zone_id","iso_year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "ministry_periods_zone_year_number_idx" ON "ministry_periods" USING btree ("zone_id","ministry_year_id","period_number");--> statement-breakpoint
CREATE INDEX "ministry_periods_zone_dates_idx" ON "ministry_periods" USING btree ("zone_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ministry_years_zone_label_idx" ON "ministry_years" USING btree ("zone_id","year_label");--> statement-breakpoint
CREATE INDEX "ministry_years_zone_dates_idx" ON "ministry_years" USING btree ("zone_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "partnership_periods_zone_year_number_idx" ON "partnership_periods" USING btree ("zone_id","partnership_year_id","period_number");--> statement-breakpoint
CREATE INDEX "partnership_periods_zone_dates_idx" ON "partnership_periods" USING btree ("zone_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "partnership_years_zone_label_idx" ON "partnership_years" USING btree ("zone_id","year_label");--> statement-breakpoint
CREATE INDEX "partnership_years_zone_dates_idx" ON "partnership_years" USING btree ("zone_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_zone_name_lower_idx" ON "accounts" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE INDEX "accounts_zone_idx" ON "accounts" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "accounts_currency_idx" ON "accounts" USING btree ("zone_id","currency_code");--> statement-breakpoint
CREATE UNIQUE INDEX "giving_categories_zone_name_lower_idx" ON "giving_categories" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "giving_categories_zone_short_code_lower_idx" ON "giving_categories" USING btree ("zone_id",lower("short_code")) WHERE "giving_categories"."short_code" is not null;--> statement-breakpoint
CREATE INDEX "giving_categories_zone_idx" ON "giving_categories" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "giving_categories_parent_idx" ON "giving_categories" USING btree ("parent_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "giving_type_accounts_current_idx" ON "giving_type_accounts" USING btree ("zone_id","giving_type_id") WHERE "giving_type_accounts"."date_to" is null;--> statement-breakpoint
CREATE INDEX "giving_type_accounts_account_idx" ON "giving_type_accounts" USING btree ("zone_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "giving_types_zone_name_lower_idx" ON "giving_types" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "giving_types_zone_short_code_lower_idx" ON "giving_types" USING btree ("zone_id",lower("short_code")) WHERE "giving_types"."short_code" is not null;--> statement-breakpoint
CREATE INDEX "giving_types_zone_idx" ON "giving_types" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "giving_types_category_idx" ON "giving_types" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "giving_types_account_idx" ON "giving_types" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_zone_code_lower_idx" ON "payment_methods" USING btree ("zone_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_zone_name_lower_idx" ON "payment_methods" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE INDEX "payment_methods_zone_idx" ON "payment_methods" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "service_events_zone_date_idx" ON "service_events" USING btree ("zone_id","service_date");--> statement-breakpoint
CREATE INDEX "service_events_chapter_date_idx" ON "service_events" USING btree ("chapter_id","service_date");--> statement-breakpoint
CREATE INDEX "service_events_type_idx" ON "service_events" USING btree ("service_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_types_zone_name_lower_idx" ON "service_types" USING btree ("zone_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "service_types_zone_short_code_lower_idx" ON "service_types" USING btree ("zone_id",lower("short_code")) WHERE "service_types"."short_code" is not null;--> statement-breakpoint
CREATE INDEX "service_types_zone_idx" ON "service_types" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "contribution_batches_zone_status_idx" ON "contribution_batches" USING btree ("zone_id","status");--> statement-breakpoint
CREATE INDEX "contribution_batches_zone_chapter_idx" ON "contribution_batches" USING btree ("zone_id","chapter_id");--> statement-breakpoint
CREATE INDEX "contribution_batches_service_event_idx" ON "contribution_batches" USING btree ("service_event_id");--> statement-breakpoint
CREATE INDEX "contribution_lines_contribution_idx" ON "contribution_lines" USING btree ("contribution_id");--> statement-breakpoint
CREATE INDEX "contribution_lines_zone_giving_type_idx" ON "contribution_lines" USING btree ("zone_id","giving_type_id");--> statement-breakpoint
CREATE INDEX "contribution_lines_zone_account_idx" ON "contribution_lines" USING btree ("zone_id","account_id");--> statement-breakpoint
CREATE INDEX "contribution_members_member_idx" ON "contribution_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "contributions_zone_chapter_date_idx" ON "contributions" USING btree ("zone_id","chapter_id","contribution_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contributions_zone_member_date_idx" ON "contributions" USING btree ("zone_id","member_id","contribution_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contributions_zone_status_idx" ON "contributions" USING btree ("zone_id","status");--> statement-breakpoint
CREATE INDEX "contributions_zone_period_idx" ON "contributions" USING btree ("zone_id","giving_period_id");--> statement-breakpoint
CREATE INDEX "contributions_batch_idx" ON "contributions" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_failure_types_platform_code_unique" ON "import_failure_types" USING btree ("code") WHERE "import_failure_types"."zone_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "import_failure_types_zone_code_unique" ON "import_failure_types" USING btree ("zone_id","code") WHERE "import_failure_types"."zone_id" is not null;--> statement-breakpoint
CREATE INDEX "import_failure_types_code_idx" ON "import_failure_types" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "import_files_zone_checksum_unique" ON "import_files" USING btree ("zone_id","checksum_sha256","file_type","source_type") WHERE "import_files"."chapter_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "import_files_zone_chapter_checksum_unique" ON "import_files" USING btree ("zone_id","chapter_id","checksum_sha256","file_type","source_type") WHERE "import_files"."chapter_id" is not null;--> statement-breakpoint
CREATE INDEX "import_files_zone_idx" ON "import_files" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "import_jobs_zone_status_idx" ON "import_jobs" USING btree ("zone_id","status");--> statement-breakpoint
CREATE INDEX "import_jobs_zone_created_idx" ON "import_jobs" USING btree ("zone_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_row_failures_row_idx" ON "import_row_failures" USING btree ("row_id");--> statement-breakpoint
CREATE INDEX "import_row_failures_zone_code_idx" ON "import_row_failures" USING btree ("zone_id","failure_code");--> statement-breakpoint
CREATE INDEX "import_rows_zone_job_idx" ON "import_rows" USING btree ("zone_id","import_job_id");--> statement-breakpoint
CREATE INDEX "import_rows_zone_match_idx" ON "import_rows" USING btree ("zone_id","match_status");--> statement-breakpoint
CREATE INDEX "import_rows_zone_validation_idx" ON "import_rows" USING btree ("zone_id","validation_status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_schedules_active_unique" ON "import_schedules" USING btree ("zone_id","import_job_id") WHERE "import_schedules"."committed_at" is null and "import_schedules"."rolled_back_at" is null;--> statement-breakpoint
CREATE INDEX "processed_transactions_zone_job_idx" ON "processed_transactions" USING btree ("zone_id","import_job_id");--> statement-breakpoint
CREATE INDEX "audit_events_zone_entity_idx" ON "audit_events" USING btree ("zone_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_zone_occurred_idx" ON "audit_events" USING btree ("zone_id","occurred_at" DESC NULLS LAST);