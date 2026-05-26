CREATE TABLE "families" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"region_id" text,
	"chapter_id" text NOT NULL,
	"reference_code" text NOT NULL,
	"name" text NOT NULL,
	"primary_address_id" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "families_zone_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
CREATE TABLE "family_members" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"family_id" text NOT NULL,
	"member_id" text NOT NULL,
	"relationship" text,
	"is_primary_contact" boolean DEFAULT false NOT NULL,
	"joined_at" date DEFAULT now() NOT NULL,
	"left_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_members_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "family_members_window_check" CHECK (left_at is null or left_at >= joined_at)
);
--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_primary_address_id_member_addresses_id_fk" FOREIGN KEY ("primary_address_id") REFERENCES "public"."member_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_zone_chapter_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_zone_family_fk" FOREIGN KEY ("zone_id","family_id") REFERENCES "public"."families"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_zone_member_fk" FOREIGN KEY ("zone_id","member_id") REFERENCES "public"."members"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "families_zone_reference_idx" ON "families" USING btree ("zone_id","reference_code");--> statement-breakpoint
CREATE UNIQUE INDEX "families_zone_chapter_name_active_idx" ON "families" USING btree ("zone_id","chapter_id",lower("name")) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "families_zone_chapter_active_idx" ON "families" USING btree ("zone_id","chapter_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "families_zone_active_idx" ON "families" USING btree ("zone_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "families_region_idx" ON "families" USING btree ("region_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_members_one_open_per_member_idx" ON "family_members" USING btree ("member_id") WHERE left_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "family_members_one_primary_per_family_idx" ON "family_members" USING btree ("family_id") WHERE is_primary_contact = true and left_at is null;--> statement-breakpoint
CREATE INDEX "family_members_zone_family_idx" ON "family_members" USING btree ("zone_id","family_id");--> statement-breakpoint
CREATE INDEX "family_members_zone_member_idx" ON "family_members" USING btree ("zone_id","member_id");