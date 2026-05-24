// packages/web/scripts/check-design.mjs
// Fails when a .svelte file uses a forbidden raw-Tailwind pattern that
// the editorial design system in docs/DESIGN.md replaces with an sl-*
// primitive or var(--*) token.
// Run via `pnpm -F @stewardledger/web check:design` (also runnable as
// part of pnpm check / pre-commit).
// RELEVANT FILES: ../../../docs/DESIGN.md, ../src/app.css

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "src");
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/**
 * Each pattern names a *forbidden* shape that DESIGN.md replaces with
 * an `sl-*` class or `var(--*)` token. Keep the regex tight — overly
 * broad rules invite contributors to disable the check rather than
 * fix the code. When the system grows new primitives, add a rule here
 * alongside the doc update.
 */
const RULES = [
  {
    id: "raw-slate-color",
    description:
      "Raw Tailwind slate colors. Use var(--ink), var(--ink-soft), var(--ink-mute), var(--ink-faint), var(--rule), var(--paper), var(--card), or var(--card-warm).",
    pattern: /\b(?:text|bg|border|divide|ring)-slate-\d+\b/,
  },
  {
    id: "raw-semantic-color",
    description:
      "Raw Tailwind semantic palettes. Use var(--ok|warn|bad|info)(-soft)? or the matching sl-badge-* / sl-btn-*-(ghost)? classes.",
    pattern:
      /\b(?:text|bg|border|ring)-(?:rose|red|green|emerald|amber|yellow|blue|sky|indigo)-\d+\b/,
  },
  {
    id: "raw-card",
    description:
      "Ad-hoc card styling. Use sl-card or sl-card-warm instead of rounded-(lg|xl) border + bg-white.",
    pattern: /\brounded-(?:lg|xl)\b[^"']*\bbg-white\b|\bbg-white\b[^"']*\brounded-(?:lg|xl)\b/,
  },
  {
    id: "page-centered-wrapper",
    description:
      "Page-centred wrapper. Role layouts already handle horizontal padding; use `pt-2 pb-10 lg:pt-0` (or no wrapper).",
    pattern: /\bmax-w-(?:md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl) mx-auto px-\d+ py-\d+/,
  },
];

/**
 * Files we deliberately skip — generated trees, vendored assets, the
 * design-check script itself (its regex strings would self-match), and
 * the global stylesheet that *defines* the legitimate references.
 */
const SKIP_DIRS = new Set([".svelte-kit", "node_modules", "static", "build"]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (stat.isFile() && full.endsWith(".svelte")) yield full;
  }
}

const violations = [];

for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip HTML comments — the design doc reference inside file
    // headers ("Replaces /zone/merge…") shouldn't trigger rules.
    if (/^\s*<!--/.test(line)) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        violations.push({
          file: relative(REPO_ROOT, file),
          line: i + 1,
          rule,
          snippet: line.trim().slice(0, 160),
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log("✓ check:design — 0 violations across .svelte files.");
  process.exit(0);
}

console.error(
  `✗ check:design — ${violations.length} violation${
    violations.length === 1 ? "" : "s"
  } across ${new Set(violations.map((v) => v.file)).size} file${
    violations.length === 1 ? "" : "s"
  }.\n`,
);
console.error("See docs/DESIGN.md for the rule and the sl-* primitive to use.\n");

// Group violations by rule so the output is actionable rather than a
// long flat list. Each rule prints its description once and then the
// file:line hits underneath.
const byRule = new Map();
for (const v of violations) {
  if (!byRule.has(v.rule.id)) byRule.set(v.rule.id, { rule: v.rule, hits: [] });
  byRule.get(v.rule.id).hits.push(v);
}

for (const { rule, hits } of byRule.values()) {
  console.error(`[${rule.id}] ${rule.description}`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  ${h.snippet}`);
  }
  console.error("");
}

process.exit(1);
