-- Phase 9 — per-zone data retention policy.
--
-- A jsonb column on `zones` driving the background sweep workers in
-- `packages/api/src/services/retention/`. The Zod schema in
-- `@stewardledger/shared` (`zoneRetentionPolicySchema`) is the
-- canonical shape; the column itself stays an open jsonb so new
-- dimensions can be added without a migration per field. New zones
-- start with `{}` and the service layer hydrates defaults on every
-- read.

ALTER TABLE "zones" ADD COLUMN "retention_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;