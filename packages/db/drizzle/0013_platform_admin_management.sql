CREATE TABLE "platform_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role_code" text NOT NULL,
	"super_admin" boolean DEFAULT false NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	CONSTRAINT "platform_invitations_role_check" CHECK ("platform_invitations"."role_code" in ('support_admin', 'billing_admin', 'region_curator'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "zone_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_invitations" ADD CONSTRAINT "platform_invitations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invitations" ADD CONSTRAINT "platform_invitations_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invitations" ADD CONSTRAINT "platform_invitations_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invitations_token_hash_idx" ON "platform_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "platform_invitations_email_idx" ON "platform_invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invitations_open_unique_idx" ON "platform_invitations" USING btree ("email","role_code") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_zone_scope_check" CHECK ((("audit_events"."action" like 'platform.%') and "audit_events"."zone_id" is null)
          or (("audit_events"."action" not like 'platform.%') and "audit_events"."zone_id" is not null));