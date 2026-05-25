CREATE TABLE "zone_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"requested_by_user_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"byte_count" bigint,
	"table_count" integer,
	"file_count" integer,
	"artefact_count" integer,
	"error_code" text,
	"error_message" text,
	"email_sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zone_exports_status_check" CHECK ("zone_exports"."status" in ('queued', 'running', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "zone_exports" ADD CONSTRAINT "zone_exports_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_exports" ADD CONSTRAINT "zone_exports_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "zone_exports_queued_idx" ON "zone_exports" USING btree ("created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "zone_exports_zone_idx" ON "zone_exports" USING btree ("zone_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "zone_exports_expiry_idx" ON "zone_exports" USING btree ("expires_at") WHERE status = 'completed';