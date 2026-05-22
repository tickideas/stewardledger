ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_format_check" CHECK ("report_jobs"."format" in ('xlsx', 'pdf'));--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_status_check" CHECK ("report_jobs"."status" in ('queued', 'running', 'completed', 'failed'));
