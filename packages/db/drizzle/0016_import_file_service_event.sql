-- packages/db/drizzle/0016_import_file_service_event.sql
-- Adds selected service event metadata to import files.
-- Keeps same-file uploads distinct when they target different services.
-- RELEVANT FILES: packages/db/src/schema/imports.ts, packages/api/src/services/imports/index.ts, packages/api/src/routes/tenant-imports.ts

ALTER TABLE "import_files"
  ADD COLUMN "service_event_id" text;

ALTER TABLE "import_files"
  ADD CONSTRAINT "import_files_service_event_zone_fk"
  FOREIGN KEY ("zone_id", "service_event_id")
  REFERENCES "service_events" ("zone_id", "id")
  ON DELETE restrict;

ALTER TABLE "import_files"
  ADD CONSTRAINT "import_files_chapter_service_event_check"
  CHECK ("chapter_id" IS NULL OR "service_event_id" IS NOT NULL)
  NOT VALID;

DROP INDEX IF EXISTS "import_files_zone_chapter_checksum_unique";

CREATE UNIQUE INDEX "import_files_zone_chapter_service_checksum_unique"
  ON "import_files" (
    "zone_id",
    "chapter_id",
    "service_event_id",
    "checksum_sha256",
    "file_type",
    "source_type"
  )
  WHERE "chapter_id" IS NOT NULL;
