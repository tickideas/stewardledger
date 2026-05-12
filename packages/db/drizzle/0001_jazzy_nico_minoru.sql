CREATE TABLE "chapter_batch_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter_batch_templates" ADD CONSTRAINT "chapter_batch_templates_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_batch_templates" ADD CONSTRAINT "chapter_batch_templates_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_batch_templates" ADD CONSTRAINT "chapter_batch_templates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapter_batch_templates_chapter_idx" ON "chapter_batch_templates" USING btree ("chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chapter_batch_templates_chapter_name_idx" ON "chapter_batch_templates" USING btree ("chapter_id","name");