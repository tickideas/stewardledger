CREATE TABLE "financial_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text,
	"giving_type_id" text NOT NULL,
	"ministry_year_id" text NOT NULL,
	"full_target" numeric(19, 4) NOT NULL,
	"monthly_target" numeric(19, 4),
	"weekly_breakdown" numeric(19, 4),
	"full_target_copies" integer,
	"number_of_partners" integer,
	"currency_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_targets_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "financial_targets_money_nonneg" CHECK ("financial_targets"."full_target" >= 0
          and ("financial_targets"."monthly_target" is null or "financial_targets"."monthly_target" >= 0)
          and ("financial_targets"."weekly_breakdown" is null or "financial_targets"."weekly_breakdown" >= 0)),
	CONSTRAINT "financial_targets_counts_nonneg" CHECK (("financial_targets"."full_target_copies" is null or "financial_targets"."full_target_copies" >= 0)
          and ("financial_targets"."number_of_partners" is null or "financial_targets"."number_of_partners" >= 0))
);
--> statement-breakpoint
ALTER TABLE "financial_targets" ADD CONSTRAINT "financial_targets_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_targets" ADD CONSTRAINT "financial_targets_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_targets" ADD CONSTRAINT "financial_targets_giving_type_zone_fk" FOREIGN KEY ("zone_id","giving_type_id") REFERENCES "public"."giving_types"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_targets" ADD CONSTRAINT "financial_targets_ministry_year_zone_fk" FOREIGN KEY ("zone_id","ministry_year_id") REFERENCES "public"."ministry_years"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_targets_chapter_tuple_idx" ON "financial_targets" USING btree ("zone_id","chapter_id","giving_type_id","ministry_year_id") WHERE "financial_targets"."chapter_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_targets_zone_tuple_idx" ON "financial_targets" USING btree ("zone_id","giving_type_id","ministry_year_id") WHERE "financial_targets"."chapter_id" is null;--> statement-breakpoint
CREATE INDEX "financial_targets_zone_year_type_idx" ON "financial_targets" USING btree ("zone_id","ministry_year_id","giving_type_id");