CREATE TABLE "report_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"user_id" text NOT NULL,
	"report_id" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"error_code" text,
	"error_message" text,
	"row_count" integer,
	"byte_count" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_jobs_queued_idx" ON "report_jobs" USING btree ("created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "report_jobs_user_idx" ON "report_jobs" USING btree ("zone_id","user_id","created_at" DESC NULLS LAST);