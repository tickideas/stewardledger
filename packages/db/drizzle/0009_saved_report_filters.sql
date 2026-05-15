CREATE TABLE "saved_report_filters" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"user_id" text NOT NULL,
	"report_id" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_report_filters" ADD CONSTRAINT "saved_report_filters_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_report_filters" ADD CONSTRAINT "saved_report_filters_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_report_filters_unique_name_idx" ON "saved_report_filters" USING btree ("user_id","zone_id","report_id",lower("name"));--> statement-breakpoint
CREATE INDEX "saved_report_filters_user_zone_report_idx" ON "saved_report_filters" USING btree ("user_id","zone_id","report_id");