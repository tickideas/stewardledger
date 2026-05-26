-- Paired down-migration for 0024_families_and_family_members.
--
-- Acceptable because no production data depends on families yet
-- (Phase 10 / GA exit checklist item; see docs/ROADMAP.md and
-- docs/CHURCHPLUS-PORT-NOTES.md §2.2.1). A future zone that has
-- created families would lose them on rollback — refuse to run
-- this script against such a database.

DROP TABLE IF EXISTS "family_members";
DROP TABLE IF EXISTS "families";
