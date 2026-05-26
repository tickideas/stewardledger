#!/usr/bin/env node
// Lint check: drizzle's pg migrator decides whether to run a journal
// entry by comparing the entry's `when` against the single max
// `created_at` in `__drizzle_migrations` (pg-core/dialect.js → migrate).
// If a later journal entry carries an *older* `when` than an
// already-applied entry, the migrator silently skips it — no error,
// exit 0 on the migrate one-shot, missing column on the next read.
//
// Hit this twice now:
//   814a132 — orphan 0021_wild_guardian entry (no matching .sql).
//   0023_fix_skipped_retention_columns — 0018/0019 had older `when`
//     than the hand-rolled 0017_report_jobs_pr2 timestamp, so prod
//     silently skipped them; this script would have caught it.
//
// This script enforces four invariants:
//
//   1. Every journal `tag` has a matching `<tag>.sql` file on disk.
//      (The 814a132 failure mode.)
//
//   2. Every `idx` is unique. Catches the `0021_wild_guardian`
//      duplicate-idx that PR #66 fixed by hand — drizzle iterates
//      every entry regardless of idx, but a duplicate is always a
//      sign of a botched generate/revert cycle.
//
//   3. Entries appear in strictly ascending `idx` order.
//
//   4. Journal `when` values are strictly monotonically increasing in
//      `idx` order. (The 0023 failure mode.)
//
// Run via `pnpm --filter @stewardledger/db check`. Exit non-zero on
// any violation so pre-merge gates can block the deploy.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Grandfathered monotonicity violations. These entries shipped with
// older `when` values than their predecessor; the missing schema was
// restored via a fix-up migration. Re-bumping their `when` is unsafe
// because their original .sql lacks `IF NOT EXISTS`, so any dev/test
// DB that *did* apply them in order would fail on the retried
// `ADD COLUMN`. We keep the bad timestamps and let the fix-up
// migration carry the actual repair.
//
// Keyed by tag; the value names the fix-up migration that restores
// the schema on environments where this entry was silently skipped.
export const GRANDFATHERED_WHEN_VIOLATIONS = new Map([
	["0018_zone_retention_policy", "0023_fix_skipped_retention_columns"],
	["0019_import_files_purged_at", "0023_fix_skipped_retention_columns"],
]);

/**
 * Lint a parsed drizzle journal against the on-disk migrations dir.
 * Pure function — no I/O beyond `existsSync` on `<migrationsDir>/<tag>.sql`.
 *
 * @param {{ entries: Array<{ idx: number; when: number; tag: string }> }} journal
 * @param {string} migrationsDir
 * @returns {string[]} errors (empty array = ok)
 */
export function lintJournal(journal, migrationsDir) {
	const errors = [];
	const seenIdx = new Set();
	let prevWhen = Number.NEGATIVE_INFINITY;
	let prevIdx = Number.NEGATIVE_INFINITY;
	let prevTag = "(none)";

	for (const entry of journal.entries) {
		const { idx, when, tag } = entry;

		// Invariant 1: matching .sql file exists.
		const sqlPath = resolve(migrationsDir, `${tag}.sql`);
		if (!existsSync(sqlPath)) {
			errors.push(
				`idx ${idx} (${tag}): no matching ${tag}.sql in drizzle/. ` +
					`drizzle-orm will throw 'No file ... found' at migrate time. ` +
					`Drop the orphan journal entry or restore the .sql file.`,
			);
		}

		// Invariant 2: `idx` is unique. Catches the duplicate-idx that
		// PR #66 fixed manually (two `idx: 21` entries in the journal).
		if (seenIdx.has(idx)) {
			errors.push(
				`idx ${idx} (${tag}): duplicate idx — another entry already ` +
					`claims this idx. Usually a botched 'drizzle-kit generate' / ` +
					`revert cycle. Drop the stale entry or renumber.`,
			);
		}
		seenIdx.add(idx);

		// Invariant 3: entries appear in strictly ascending idx order.
		if (idx <= prevIdx) {
			errors.push(
				`idx ${idx} (${tag}): journal entries are out of idx order ` +
					`(previous was idx ${prevIdx} / ${prevTag}). Sort or renumber.`,
			);
		}

		// Invariant 4: `when` is strictly monotonic in idx order.
		if (when <= prevWhen && !GRANDFATHERED_WHEN_VIOLATIONS.has(tag)) {
			errors.push(
				`idx ${idx} (${tag}): when=${when} is not strictly greater than ` +
					`previous entry's when=${prevWhen} (idx ${prevIdx} / ${prevTag}). ` +
					`drizzle's pg migrator compares 'when' against the single max ` +
					`created_at in __drizzle_migrations and will SILENTLY SKIP this ` +
					`entry on any DB that has already applied a later-but-newer ` +
					`migration. Bump 'when' to be strictly greater than the prior ` +
					`entry. If the entry has already shipped and was silently ` +
					`skipped on prod, write a fix-up migration with IF NOT EXISTS ` +
					`(see 0023_fix_skipped_retention_columns.sql) and add the tag ` +
					`to GRANDFATHERED_WHEN_VIOLATIONS in this script.`,
			);
		}

		// Track the high-water mark even when a grandfathered entry has
		// a smaller `when` — non-grandfathered entries later in the
		// journal still need to exceed the actual maximum to be safe.
		prevWhen = Math.max(prevWhen, when);
		prevIdx = idx;
		prevTag = tag;
	}

	return errors;
}

// ─── CLI entry ──────────────────────────────────────────────────────
// Only run as a script when invoked directly (not when imported by tests).
const __filename = fileURLToPath(import.meta.url);
const invokedDirectly =
	process.argv[1] && resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
	const __dirname = dirname(__filename);
	const journalPath = resolve(__dirname, "..", "drizzle", "meta", "_journal.json");
	const migrationsDir = resolve(__dirname, "..", "drizzle");
	const journal = JSON.parse(readFileSync(journalPath, "utf8"));
	const errors = lintJournal(journal, migrationsDir);

	if (errors.length > 0) {
		console.error("drizzle journal lint failed:");
		for (const err of errors) {
			console.error(`  - ${err}`);
		}
		process.exit(1);
	}

	console.log(`drizzle journal ok (${journal.entries.length} entries).`);
}
