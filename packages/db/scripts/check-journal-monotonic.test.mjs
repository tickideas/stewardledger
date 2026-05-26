// Tests for the drizzle journal lint script. Uses node's built-in
// test runner so packages/db doesn't need a vitest dep.
//
// Run via `pnpm --filter @stewardledger/db test:journal` or directly:
//   node --test packages/db/scripts/check-journal-monotonic.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { lintJournal } from "./check-journal-monotonic.mjs";

/** @type {string} */
let migrationsDir;

beforeEach(() => {
	migrationsDir = mkdtempSync(join(tmpdir(), "sl-journal-lint-"));
});

afterEach(() => {
	rmSync(migrationsDir, { recursive: true, force: true });
});

/** Create empty .sql files for each tag so invariant 1 (file exists) passes. */
function touch(...tags) {
	for (const tag of tags) {
		writeFileSync(join(migrationsDir, `${tag}.sql`), "-- empty\n");
	}
}

describe("lintJournal", () => {
	it("returns no errors for a well-formed journal", () => {
		touch("0001_a", "0002_b", "0003_c");
		const journal = {
			entries: [
				{ idx: 1, when: 100, tag: "0001_a", breakpoints: true },
				{ idx: 2, when: 200, tag: "0002_b", breakpoints: true },
				{ idx: 3, when: 300, tag: "0003_c", breakpoints: true },
			],
		};
		assert.deepEqual(lintJournal(journal, migrationsDir), []);
	});

	it("flags an entry whose .sql is missing on disk (the 814a132 mode)", () => {
		touch("0001_a"); // intentionally omit 0002_b
		const journal = {
			entries: [
				{ idx: 1, when: 100, tag: "0001_a", breakpoints: true },
				{ idx: 2, when: 200, tag: "0002_b", breakpoints: true },
			],
		};
		const errors = lintJournal(journal, migrationsDir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /no matching 0002_b\.sql/);
	});

	it("flags a backward 'when' value (the 0023 mode)", () => {
		touch("0017_a", "0018_b");
		const journal = {
			entries: [
				{ idx: 17, when: 1000, tag: "0017_a", breakpoints: true },
				{ idx: 18, when: 999, tag: "0018_b", breakpoints: true }, // older
			],
		};
		const errors = lintJournal(journal, migrationsDir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /when=999 is not strictly greater than/);
		assert.match(errors[0], /SILENTLY SKIP/);
	});

	it("flags an equal 'when' (strict monotonicity, not just non-decreasing)", () => {
		touch("0001_a", "0002_b");
		const journal = {
			entries: [
				{ idx: 1, when: 100, tag: "0001_a", breakpoints: true },
				{ idx: 2, when: 100, tag: "0002_b", breakpoints: true }, // equal
			],
		};
		const errors = lintJournal(journal, migrationsDir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /when=100 is not strictly greater than/);
	});

	it("flags duplicate idx (the 0021_wild_guardian mode)", () => {
		touch("0021_a", "0021_b");
		const journal = {
			entries: [
				{ idx: 21, when: 100, tag: "0021_a", breakpoints: true },
				{ idx: 21, when: 200, tag: "0021_b", breakpoints: true },
			],
		};
		const errors = lintJournal(journal, migrationsDir);
		// Duplicate idx fires invariant 2 AND invariant 3 (idx not strictly
		// ascending). Both are genuine bugs worth flagging separately.
		const messages = errors.join("\n");
		assert.match(messages, /duplicate idx/);
		assert.match(messages, /out of idx order/);
	});

	it("flags out-of-order idx even when 'when' is fine", () => {
		touch("0001_a", "0002_b");
		const journal = {
			entries: [
				{ idx: 2, when: 100, tag: "0002_b", breakpoints: true },
				{ idx: 1, when: 200, tag: "0001_a", breakpoints: true },
			],
		};
		const errors = lintJournal(journal, migrationsDir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /out of idx order/);
	});

	it("exempts grandfathered tags from the 'when' check", () => {
		touch(
			"0017_report_jobs_pr2",
			"0018_zone_retention_policy",
			"0019_import_files_purged_at",
		);
		const journal = {
			entries: [
				{
					idx: 17,
					when: 1779724800000,
					tag: "0017_report_jobs_pr2",
					breakpoints: true,
				},
				{
					idx: 18,
					when: 1779708428764, // older — but grandfathered
					tag: "0018_zone_retention_policy",
					breakpoints: true,
				},
				{
					idx: 19,
					when: 1779714042072, // older — but grandfathered
					tag: "0019_import_files_purged_at",
					breakpoints: true,
				},
			],
		};
		assert.deepEqual(lintJournal(journal, migrationsDir), []);
	});

	it("keeps the high-water mark intact across a grandfathered entry", () => {
		// 17 is the real max; 18 is grandfathered with a smaller `when`.
		// A NEW non-grandfathered entry must still beat 17's `when` — if
		// the lint dropped the high-water mark to 18's value, a new entry
		// with when=1779724800001 would slip through and get silently
		// skipped in prod (same failure mode this whole PR exists to fix).
		touch(
			"0017_report_jobs_pr2",
			"0018_zone_retention_policy",
			"0099_new_migration",
		);
		const journal = {
			entries: [
				{ idx: 17, when: 1779724800000, tag: "0017_report_jobs_pr2" },
				{ idx: 18, when: 1, tag: "0018_zone_retention_policy" }, // grandfathered
				{ idx: 99, when: 1779724800000, tag: "0099_new_migration" }, // = 17, not > 17
			],
		};
		const errors = lintJournal(journal, migrationsDir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /0099_new_migration/);
		assert.match(errors[0], /when=1779724800000 is not strictly greater/);
	});

	it("accumulates multiple errors instead of bailing on the first", () => {
		touch("0001_a"); // missing 0002_b and 0003_c
		const journal = {
			entries: [
				{ idx: 1, when: 100, tag: "0001_a" },
				{ idx: 2, when: 50, tag: "0002_b" }, // backward when AND missing file
				{ idx: 2, when: 200, tag: "0003_c" }, // duplicate idx AND missing file
			],
		};
		const errors = lintJournal(journal, migrationsDir);
		assert.ok(errors.length >= 3, `expected ≥3 errors, got ${errors.length}`);
	});

	it("handles an empty journal cleanly", () => {
		assert.deepEqual(lintJournal({ entries: [] }, migrationsDir), []);
	});
});
