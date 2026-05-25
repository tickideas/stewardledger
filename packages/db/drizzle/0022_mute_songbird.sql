CREATE TABLE "erasure_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"scope" text NOT NULL,
	"member_id" text,
	"requested_by_user_id" text,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reversibility_window_days" integer NOT NULL,
	"applies_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_requests_scope_check" CHECK ("erasure_requests"."scope" in ('member', 'zone')),
	CONSTRAINT "erasure_requests_status_check" CHECK ("erasure_requests"."status" in ('pending', 'applied', 'cancelled', 'failed')),
	CONSTRAINT "erasure_requests_scope_member_consistency_check" CHECK (("erasure_requests"."scope" = 'member' and (
            "erasure_requests"."member_id" is not null
            or "erasure_requests"."status" in ('applied', 'cancelled', 'failed')
          ))
       or ("erasure_requests"."scope" = 'zone' and "erasure_requests"."member_id" is null)),
	CONSTRAINT "erasure_requests_window_positive_check" CHECK ("erasure_requests"."reversibility_window_days" > 0),
	CONSTRAINT "erasure_requests_applies_after_created_check" CHECK ("erasure_requests"."applies_at" > "erasure_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_cancelled_by_user_id_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasure_requests_pending_idx" ON "erasure_requests" USING btree ("applies_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "erasure_requests_zone_idx" ON "erasure_requests" USING btree ("zone_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_requests_zone_member_pending_uidx" ON "erasure_requests" USING btree ("zone_id","member_id") WHERE status = 'pending' and member_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_requests_zone_scope_pending_uidx" ON "erasure_requests" USING btree ("zone_id") WHERE status = 'pending' and scope = 'zone';