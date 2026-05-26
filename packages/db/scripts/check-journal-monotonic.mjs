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
// This script enforces two invariants:
//
//   1. Every journal `tag` has a matching `<tag>.sql` file on disk.
//      (The 814a132 failure mode.)
//
//   2. Journal `when` values are strictly monotonically increasing in
//      `idx` order. (The 0023 failure mode.)
//
// Run via `pnpm --filter @stewardledger/db check`. Exit non-zero on
// any violation so CI / pre-merge gates can block the deploy.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const journalPath = resolve(__dirname, "..", "drizzle", "meta", "_journal.json");
const migrationsDir = resolve(__dirname, "..", "drizzle");

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const errors = [];

// Grandfathered monotonicity violations. These entries shipped with
// older `when` values than their predecessor; the missing schema was
// restored via the fix-up migration noted below. Re-bumping their
// `when` is unsafe because their .sql lacks `IF NOT EXISTS`, so any
// dev/test DB that *did* apply them in order would fail on the
// retried `ADD COLUMN`. We keep the bad timestamps and let 0023 carry
// the actual repair.
const GRANDFATHERED_WHEN_VIOLATIONS = new Set([
	// Repaired by 0023_fix_skipped_retention_columns.
	"0018_zone_retention_policy",
	"0019_import_files_purged_at",
]);

let prevWhen = -1;
let prevIdx = -1;
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

	// Invariant 2: `when` is strictly monotonic in `idx` order.
	if (idx <= prevIdx) {
		errors.push(
			`idx ${idx} (${tag}): journal entries are out of idx order ` +
				`(previous was idx ${prevIdx} / ${prevTag}). Sort or renumber.`,
		);
	}
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

	prevWhen = Math.max(prevWhen, when);
	prevIdx = idx;
	prevTag = tag;
}

if (errors.length > 0) {
	console.error("drizzle journal lint failed:");
	for (const err of errors) {
		console.error(`  - ${err}`);
	}
	process.exit(1);
}

console.log(`drizzle journal ok (${journal.entries.length} entries).`);
