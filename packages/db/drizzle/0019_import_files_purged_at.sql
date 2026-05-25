-- Phase 9 — retention sweep tombstone for `import_files`.
--
-- We can't hard-delete `import_files` rows: the
-- `import_jobs_file_zone_fk` FK is `restrict`, so any historical job
-- still referencing the file would block the DELETE. Instead the
-- sweep deletes the bytes from object storage and flips `purged_at`
-- to now(). The row stays for audit + FK integrity; downstream code
-- treats a non-null `purged_at` as "file no longer recoverable".

ALTER TABLE "import_files" ADD COLUMN "purged_at" timestamp with time zone;