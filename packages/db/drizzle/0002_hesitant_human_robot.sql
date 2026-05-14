CREATE TABLE "service_event_attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"service_event_id" text NOT NULL,
	"men" integer DEFAULT 0 NOT NULL,
	"women" integer DEFAULT 0 NOT NULL,
	"teens" integer DEFAULT 0 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"first_timers" integer DEFAULT 0 NOT NULL,
	"new_converts" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_event_attendance_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "service_event_attendance_nonneg" CHECK ("service_event_attendance"."men" >= 0
          and "service_event_attendance"."women" >= 0
          and "service_event_attendance"."teens" >= 0
          and "service_event_attendance"."children" >= 0
          and "service_event_attendance"."first_timers" >= 0
          and "service_event_attendance"."new_converts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "service_event_attendance" ADD CONSTRAINT "service_event_attendance_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_event_attendance" ADD CONSTRAINT "service_event_attendance_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_event_attendance" ADD CONSTRAINT "service_event_attendance_event_zone_fk" FOREIGN KEY ("zone_id","service_event_id") REFERENCES "public"."service_events"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_event_attendance_event_unique" ON "service_event_attendance" USING btree ("zone_id","service_event_id");