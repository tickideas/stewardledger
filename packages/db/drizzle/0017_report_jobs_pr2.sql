-- Phase 7 PR 2 — async report jobs: email + cleanup support.
--
-- 1. `email_sent_at` is the idempotency guard for the "export ready"
--    / "export failed" mail. A pg-boss redeliver of a completed
--    handler must not double-send, and a dev environment without
--    `USESEND_*` simply leaves this null.
-- 2. `expired` joins the terminal status set so the daily cleanup
--    job can flip a `completed` row to `expired` after deleting the
--    artefact, retaining the row for audit while serving 404 on
--    download.

ALTER TABLE "report_jobs"
  ADD COLUMN "email_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "report_jobs"
  DROP CONSTRAINT "report_jobs_status_check";
--> statement-breakpoint
-- ADD with NOT VALID + VALIDATE so production tables don't take an
-- ACCESS EXCLUSIVE lock for the full re-scan. Both statements still
-- lock briefly (SHARE UPDATE EXCLUSIVE for VALIDATE) but neither
-- holds the table against concurrent reads/writes.
ALTER TABLE "report_jobs"
  ADD CONSTRAINT "report_jobs_status_check"
  CHECK ("report_jobs"."status" in ('queued', 'running', 'completed', 'failed', 'expired'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "report_jobs"
  VALIDATE CONSTRAINT "report_jobs_status_check";
