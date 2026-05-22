CREATE TABLE "chapter_group_history" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text NOT NULL,
	"group_id" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "groups_zone_row_id_unique" UNIQUE("zone_id","id")
);
--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_role_consistent_with_chapter";--> statement-breakpoint
DROP INDEX "user_role_bindings_unique_active_idx";--> statement-breakpoint
DROP INDEX "invitations_open_unique_idx";--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN "groups_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD COLUMN "role_scope" text;--> statement-breakpoint
UPDATE "user_role_bindings" b SET "role_scope" = r."scope" FROM "roles" r WHERE b."role_id" = r."id";--> statement-breakpoint
ALTER TABLE "user_role_bindings" ALTER COLUMN "role_scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "chapter_group_history" ADD CONSTRAINT "chapter_group_history_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_group_history" ADD CONSTRAINT "chapter_group_history_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_group_history" ADD CONSTRAINT "chapter_group_history_group_zone_fk" FOREIGN KEY ("zone_id","group_id") REFERENCES "public"."groups"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapter_group_history_chapter_idx" ON "chapter_group_history" USING btree ("chapter_id","date_from");--> statement-breakpoint
CREATE INDEX "chapter_group_history_group_idx" ON "chapter_group_history" USING btree ("group_id","date_from");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_zone_slug_idx" ON "groups" USING btree ("zone_id","slug") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_zone_name_lower_idx" ON "groups" USING btree ("zone_id",lower("name")) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "groups_zone_id_idx" ON "groups" USING btree ("zone_id");--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_zone_group_fk" FOREIGN KEY ("zone_id","group_id") REFERENCES "public"."groups"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD CONSTRAINT "user_role_bindings_zone_group_fk" FOREIGN KEY ("zone_id","group_id") REFERENCES "public"."groups"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_zone_group_fk" FOREIGN KEY ("zone_id","group_id") REFERENCES "public"."groups"("zone_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapters_zone_group_idx" ON "chapters" USING btree ("zone_id","group_id");--> statement-breakpoint
CREATE INDEX "user_role_bindings_group_idx" ON "user_role_bindings" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_bindings_active_zone_idx" ON "user_role_bindings" USING btree ("user_id","zone_id","role_id") WHERE revoked_at is null and group_id is null and chapter_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_bindings_active_group_idx" ON "user_role_bindings" USING btree ("user_id","zone_id","group_id","role_id") WHERE revoked_at is null and group_id is not null and chapter_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_bindings_active_chapter_idx" ON "user_role_bindings" USING btree ("user_id","zone_id","chapter_id","role_id") WHERE revoked_at is null and group_id is null and chapter_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_zone_unique_idx" ON "invitations" USING btree ("zone_id","email","role_code") WHERE accepted_at is null and revoked_at is null and group_id is null and chapter_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_group_unique_idx" ON "invitations" USING btree ("zone_id","email","group_id","role_code") WHERE accepted_at is null and revoked_at is null and group_id is not null and chapter_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_chapter_unique_idx" ON "invitations" USING btree ("zone_id","email","chapter_id","role_code") WHERE accepted_at is null and revoked_at is null and group_id is null and chapter_id is not null;--> statement-breakpoint
ALTER TABLE "user_role_bindings" ADD CONSTRAINT "user_role_bindings_scope_shape" CHECK ((
        (role_scope = 'group'    and group_id is not null and chapter_id is null) or
        (role_scope = 'chapter'  and chapter_id is not null and group_id is null) or
        (role_scope = 'zone'     and group_id is null and chapter_id is null) or
        (role_scope = 'platform' and group_id is null and chapter_id is null)
      ));--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_scope_shape" CHECK ((
        (role_code like 'group_%' and group_id is not null and chapter_id is null) or
        (role_code like 'chapter_%' and chapter_id is not null and group_id is null) or
        (role_code not like 'group_%' and role_code not like 'chapter_%' and group_id is null and chapter_id is null)
      ));--> statement-breakpoint
-- Seed group_admin and group_pastor_viewer for every existing zone
INSERT INTO "roles" ("id", "zone_id", "code", "name", "scope", "permissions", "is_system")
SELECT
  gen_random_uuid()::text,
  z."id",
  'group_admin',
  'Group Admin',
  'group',
  '["group.read","chapter.read","chapter.write","member.read","contribution.read","import.read","report.read","audit.read","target.read","invitation.write"]'::jsonb,
  true
FROM "zones" z
WHERE NOT EXISTS (
  SELECT 1 FROM "roles" r
  WHERE r."zone_id" = z."id" AND r."code" = 'group_admin'
);
--> statement-breakpoint
INSERT INTO "roles" ("id", "zone_id", "code", "name", "scope", "permissions", "is_system")
SELECT
  gen_random_uuid()::text,
  z."id",
  'group_pastor_viewer',
  'Group Pastor (Viewer)',
  'group',
  '["group.read","chapter.read","member.read","contribution.read","report.read","target.read"]'::jsonb,
  true
FROM "zones" z
WHERE NOT EXISTS (
  SELECT 1 FROM "roles" r
  WHERE r."zone_id" = z."id" AND r."code" = 'group_pastor_viewer'
);
