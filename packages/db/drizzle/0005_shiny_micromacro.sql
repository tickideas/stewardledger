CREATE TABLE "paying_in_books" (
	"id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	"chapter_id" text NOT NULL,
	"reference_code_start" text NOT NULL,
	"reference_code_end" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paying_in_books_zone_id_unique" UNIQUE("zone_id","id"),
	CONSTRAINT "paying_in_books_dates_check" CHECK ("paying_in_books"."date_to" is null or "paying_in_books"."date_to" >= "paying_in_books"."date_from"),
	CONSTRAINT "paying_in_books_range_check" CHECK ("paying_in_books"."reference_code_start" <= "paying_in_books"."reference_code_end")
);
--> statement-breakpoint
ALTER TABLE "paying_in_books" ADD CONSTRAINT "paying_in_books_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paying_in_books" ADD CONSTRAINT "paying_in_books_chapter_zone_fk" FOREIGN KEY ("zone_id","chapter_id") REFERENCES "public"."chapters"("zone_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paying_in_books_zone_chapter_idx" ON "paying_in_books" USING btree ("zone_id","chapter_id","date_from","date_to");