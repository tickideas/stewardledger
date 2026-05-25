// packages/api/src/services/exports/registry.ts
// Single source of truth for "what is in a zone export bundle?".
//
// Lists every zone-scoped table the bundle includes, in FK-safe
// order for both EXPORT (children-first so a partial dump remains
// internally consistent if the worker crashes mid-write) and
// RESTORE (parents-first so the loader can INSERT without
// deferred constraints).
//
// A coverage test (`registry.test.ts`) asserts that every Drizzle
// table with a `zone_id` column is either in `ZONE_SCOPED_TABLES`
// or in `EXCLUDED_ZONE_SCOPED_TABLES` with an explicit reason.
// A new schema-author can't accidentally leave a table out of the
// export.
//
// PR A scope: declaration + coverage. The actual streaming /
// gzipping happens in PR B's `bundle.ts`.
//
// `import * as schema` (rather than the codebase-typical named
// imports) is deliberate: this file references ~45 schema exports,
// and a flat namespace keeps the declaration table readable.
//
// RELEVANT FILES: packages/db/src/schema/index.ts

import * as schema from "@stewardledger/db/schema";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * How the bundle writer selects rows for a target zone:
 *
 *   - `"zone_id"`  — `WHERE zone_id = $zoneId` (the common case).
 *   - `"self"`     — `WHERE id = $zoneId` (only the `zones` row
 *                    itself: it has no `zone_id` column because
 *                    its PK *is* the zone identity).
 */
export type ZoneRowSelector = "zone_id" | "self";

/**
 * A zone-scoped table participating in the export bundle. The
 * `table` reference is the Drizzle object so the bundle generator
 * can use it directly with `db.select().from(table)` and the
 * runtime schema-introspection helpers; no string-typed identifiers
 * leak into the dump path.
 *
 * `restoreOrder` is the sequence used by the future restore
 * helper: parents before children so a straight INSERT loop works.
 * The export writer reverses this order so a partial bundle is
 * still internally consistent (a child row never references a
 * parent that isn't in the file).
 */
export interface ZoneScopedTable {
  /** Physical SQL name; matches the JSONL filename inside the bundle. */
  readonly name: string;
  /** Drizzle table reference, for `db.select().from(table)`. */
  readonly table: PgTable;
  /**
   * Position in the restore sequence. Lower = restored first.
   * Values are spaced so future tables can slot in without
   * renumbering. Numeric, not declarative-graph, because the
   * dependency tree is small and stable and a linear list keeps
   * the restore helper trivially correct.
   */
  readonly restoreOrder: number;
  /** How to pick rows for the target zone. Defaults to `zone_id`. */
  readonly selector?: ZoneRowSelector;
  /** Short prose explaining why this table is in scope. */
  readonly note: string;
}

/**
 * Tables the export INTENTIONALLY skips, with a reason. The
 * coverage test treats this as the exhaustive list of "yes I
 * thought about it and decided no".
 */
export interface ExcludedZoneScopedTable {
  readonly name: string;
  readonly reason: string;
}

/**
 * Restore order rationale:
 *
 *   100s — the zone row + per-zone identity tables every other
 *          table FK's into (zones, custom_domains, roles).
 *   200s — chapter / group taxonomy (groups first because
 *          `chapters` has a composite FK
 *          `chapters_zone_group_fk → groups`).
 *   300s — member identity (depends on chapters + lookups).
 *   400s — period dimension (depends on zones only).
 *   500s — financial taxonomy (giving categories / accounts /
 *          payment methods; depends on zones only).
 *   600s — service events (depend on chapters + service types).
 *   700s — contributions (depend on members, batches, payment
 *          methods, giving types, periods, all the above).
 *   800s — imports (depend on every domain table they fan out to).
 *   900s — operational rows (audit, invitations, role bindings,
 *          targets, paying-in-books, saved filters, report jobs,
 *          zone_exports itself is NOT included — see exclusions).
 *
 * The FK-order coverage test (`registry.test.ts`) parses every
 * `references(() => parent.X)` and `foreignKey({foreignColumns:
 * [parent.X, parent.Y]})` declaration in the schema, checks each
 * parent that's also in this registry, and fails if any
 * parent.restoreOrder >= child.restoreOrder. A future schema
 * author can't quietly introduce a restore ordering bug.
 *
 * Out-of-bundle parents (the restorer's responsibility):
 *
 *   - `zones.regionId → regions.id` — `regions` is a
 *     platform-managed global lookup. The restorer must either
 *     pre-seed the referenced region in the target schema or
 *     accept the `ON DELETE SET NULL` semantic and null it out.
 *   - `user` FK columns (`createdByUserId`, `userId`,
 *     `actorUserId`, etc., across ~20 tables) — Better Auth's
 *     global `user` table is intentionally NOT exported (a tenant
 *     bundle must not leak global account data into a different
 *     deployment). The restorer's contract is to either:
 *       (a) pre-seed referenced user rows in the target schema, or
 *       (b) rewrite/null `*_by_user_id` columns before INSERT.
 *     Option (b) is the v1 plan for the restore-helper script
 *     (`scripts/restore-export.ts`, PR 3) since the typical
 *     restore target is a fresh / different deployment where the
 *     original user identities don't exist.
 */
/**
 * Stable string names for tables that carry a per-table restore
 * contract (`services/exports/restore.ts:applyTableRestoreContract`).
 * A new contract should add its constant here and reference the
 * constant from both this registry entry's `name` and the restore
 * hook — keeping both sides in sync without magic strings.
 */
export const RESTORE_CONTRACT_TABLES = {
  erasureRequests: "erasure_requests",
} as const;
export type RestoreContractTableName =
  (typeof RESTORE_CONTRACT_TABLES)[keyof typeof RESTORE_CONTRACT_TABLES];

export const ZONE_SCOPED_TABLES: readonly ZoneScopedTable[] = [
  // 100s — zone identity + per-zone overrides
  {
    name: "zones",
    table: schema.zones,
    restoreOrder: 100,
    selector: "self",
    note: "The zone row itself. Every other table FKs `zone_id` here, so it must restore first.",
  },
  {
    name: "custom_domains",
    table: schema.customDomains,
    restoreOrder: 110,
    note: "Per-zone hostnames; restored after the zone row.",
  },
  {
    name: "roles",
    table: schema.roles,
    restoreOrder: 120,
    note: "Per-zone role rows (system + custom). User bindings later FK these.",
  },

  // 200s — chapter + group taxonomy. `groups` first because
  // `chapters_zone_group_fk` is a composite FK from chapters to
  // groups (the chapter can claim membership of a group).
  {
    name: "groups",
    table: schema.groups,
    restoreOrder: 210,
    note: "Group rows for the zone (feature-flagged by `zones.groups_enabled`). Restored before chapters because `chapters_zone_group_fk` references it.",
  },
  {
    name: "chapters",
    table: schema.chapters,
    restoreOrder: 220,
    note: "Chapter rows for the zone. Composite FK `chapters_zone_group_fk → groups`.",
  },
  {
    name: "chapter_name_history",
    table: schema.chapterNameHistory,
    restoreOrder: 225,
    note: "Append-only chapter rename log. FKs `chapters`.",
  },
  {
    name: "chapter_group_history",
    table: schema.chapterGroupHistory,
    restoreOrder: 230,
    note: "Append-only chapter↔group reassignment log. FKs both `groups` and `chapters`.",
  },

  // 300s — lookups + members
  {
    name: "titles",
    table: schema.titles,
    restoreOrder: 305,
    note: "Per-zone member-title overrides.",
  },
  {
    name: "marital_statuses",
    table: schema.maritalStatuses,
    restoreOrder: 306,
    note: "Per-zone marital-status overrides.",
  },
  {
    name: "member_types",
    table: schema.memberTypes,
    restoreOrder: 307,
    note: "Per-zone member-type overrides.",
  },
  {
    name: "members",
    table: schema.members,
    restoreOrder: 310,
    note: "Member identity rows.",
  },
  {
    name: "member_addresses",
    table: schema.memberAddresses,
    restoreOrder: 315,
    note: "Member contact rows.",
  },
  {
    name: "member_merge_proposals",
    table: schema.memberMergeProposals,
    restoreOrder: 320,
    note: "Open + resolved merge-deduplication proposals.",
  },

  // 400s — period dimension
  {
    name: "fiscal_years",
    table: schema.fiscalYears,
    restoreOrder: 410,
    note: "Calendar partition for accounting (children: fiscal_periods).",
  },
  {
    name: "fiscal_periods",
    table: schema.fiscalPeriods,
    restoreOrder: 415,
    note: "Months/quarters belonging to a fiscal year.",
  },
  {
    name: "ministry_years",
    table: schema.ministryYears,
    restoreOrder: 420,
    note: "Calendar partition for ministry programs.",
  },
  {
    name: "ministry_periods",
    table: schema.ministryPeriods,
    restoreOrder: 425,
    note: "Months/quarters belonging to a ministry year.",
  },
  {
    name: "partnership_years",
    table: schema.partnershipYears,
    restoreOrder: 430,
    note: "Calendar partition for partnership programs.",
  },
  {
    name: "partnership_periods",
    table: schema.partnershipPeriods,
    restoreOrder: 435,
    note: "Months/quarters belonging to a partnership year.",
  },
  {
    name: "giving_periods",
    table: schema.givingPeriods,
    restoreOrder: 440,
    note: "Tithe-collection windows.",
  },

  // 500s — financial taxonomy
  {
    name: "accounts",
    table: schema.accounts,
    restoreOrder: 510,
    note: "Chart-of-accounts rows for the zone.",
  },
  {
    name: "giving_categories",
    table: schema.givingCategories,
    restoreOrder: 520,
    note: "Top-level giving taxonomy (tithe / partnership / projects).",
  },
  {
    name: "giving_types",
    table: schema.givingTypes,
    restoreOrder: 525,
    note: "Specific giving-type rows under each category.",
  },
  {
    name: "payment_methods",
    table: schema.paymentMethods,
    restoreOrder: 530,
    note: "Cash / card / cheque / online channels.",
  },
  {
    name: "giving_type_accounts",
    table: schema.givingTypeAccounts,
    restoreOrder: 535,
    note: "Junction: which account a giving type posts to.",
  },

  // 600s — service events
  {
    name: "service_types",
    table: schema.serviceTypes,
    restoreOrder: 610,
    note: "Per-zone service-type taxonomy (Sunday service, mid-week, etc.).",
  },
  {
    name: "service_events",
    table: schema.serviceEvents,
    restoreOrder: 615,
    note: "Concrete service occurrences with attendance + offerings.",
  },
  {
    name: "service_event_attendance",
    table: schema.serviceEventAttendance,
    restoreOrder: 620,
    note: "Per-member attendance on a service event.",
  },
  {
    name: "chapter_batch_templates",
    table: schema.chapterBatchTemplates,
    restoreOrder: 630,
    note: "Per-chapter batch-entry templates (UI shortcut state).",
  },

  // 700s — contributions
  {
    name: "contribution_batches",
    table: schema.contributionBatches,
    restoreOrder: 710,
    note: "Counted-once-at-source batch headers.",
  },
  {
    name: "contributions",
    table: schema.contributions,
    restoreOrder: 715,
    note: "Money rows. The system of record.",
  },
  {
    name: "contribution_lines",
    table: schema.contributionLines,
    restoreOrder: 720,
    note: "Per-contribution split across giving types.",
  },
  {
    name: "contribution_members",
    table: schema.contributionMembers,
    restoreOrder: 725,
    note: "Per-contribution member attribution.",
  },
  {
    name: "financial_targets",
    table: schema.financialTargets,
    restoreOrder: 730,
    note: "Per-period budget / pledge targets.",
  },
  {
    name: "paying_in_books",
    table: schema.payingInBooks,
    restoreOrder: 735,
    note: "Pre-numbered receipt book metadata.",
  },

  // 800s — imports
  {
    name: "import_failure_types",
    table: schema.importFailureTypes,
    restoreOrder: 805,
    note: "Per-zone overrides on the default import-failure taxonomy.",
  },
  {
    name: "import_files",
    table: schema.importFiles,
    restoreOrder: 810,
    note: "Upload metadata. Blobs are streamed into `files/` alongside.",
  },
  {
    name: "import_jobs",
    table: schema.importJobs,
    restoreOrder: 815,
    note: "Import run lifecycle: queued / running / completed / failed.",
  },
  {
    name: "import_rows",
    table: schema.importRows,
    restoreOrder: 820,
    note: "One row per source-file row, with the parsed payload + outcome.",
  },
  {
    name: "import_row_failures",
    table: schema.importRowFailures,
    restoreOrder: 825,
    note: "Per-row failure annotations.",
  },
  {
    name: "import_schedules",
    table: schema.importSchedules,
    restoreOrder: 830,
    note: "Recurring import configurations.",
  },
  {
    name: "processed_transactions",
    table: schema.processedTransactions,
    restoreOrder: 835,
    note: "Idempotency ledger so a re-run of the same source row is a no-op.",
  },

  // 900s — operational
  {
    name: "invitations",
    table: schema.invitations,
    restoreOrder: 910,
    note: "Pending + accepted role invitations for this zone.",
  },
  {
    name: "user_role_bindings",
    table: schema.userRoleBindings,
    restoreOrder: 915,
    note: "Active + revoked bindings linking global users to per-zone roles.",
  },
  {
    name: "saved_report_filters",
    table: schema.savedReportFilters,
    restoreOrder: 920,
    note: "Named report filter presets per user.",
  },
  {
    name: "report_jobs",
    table: schema.reportJobs,
    restoreOrder: 925,
    note: "Report-job metadata. Retained artefacts are streamed into `reports/` alongside.",
  },
  {
    name: RESTORE_CONTRACT_TABLES.erasureRequests,
    table: schema.erasureRequests,
    restoreOrder: 930,
    note: "GDPR erasure history for the zone. FK to `members` is `set null` so restoring an erased-member request into a fresh schema is safe (the member_id may already be null when the apply pass scrubbed it). RESTORE CONTRACT: every `pending` row must be rewritten to `cancelled` on import \u2014 otherwise the restore target's cron sweep would apply an erase scheduled on the source environment against different data. See `packages/db/src/schema/erasure-requests.ts` header.",
  },
  {
    name: "audit_events",
    table: schema.auditEvents,
    restoreOrder: 990,
    note: "Per-zone audit log; restored last so the timeline reflects the dump itself, not the restore.",
  },
];

/**
 * Tables we know are zone-scoped but DELIBERATELY skip. The
 * coverage test treats this list as the exhaustive justification.
 *
 * Why no `zone_exports`? A bundle that includes the row tracking
 * itself is a recursion hazard (a restore would re-trigger an
 * export of an export). Restoring into a clean target should start
 * with no export history; operators can request a fresh bundle
 * post-restore if they want one.
 */
export const EXCLUDED_ZONE_SCOPED_TABLES: readonly ExcludedZoneScopedTable[] = [
  {
    name: "zone_exports",
    reason:
      "Self-referential: a bundle containing its own row is a recursion hazard on restore.",
  },
];

// Pre-sorted at module load: the list is immutable and the writer
// may walk it once per export, so eat the sort cost once.
const RESTORE_SEQUENCE: readonly ZoneScopedTable[] = [
  ...ZONE_SCOPED_TABLES,
].sort((a, b) => a.restoreOrder - b.restoreOrder);
const EXPORT_SEQUENCE: readonly ZoneScopedTable[] = [
  ...RESTORE_SEQUENCE,
].reverse();

/**
 * Convenience: the export writer streams tables children-first so
 * a crash-during-write bundle is still internally consistent.
 */
export function exportOrder(): readonly ZoneScopedTable[] {
  return EXPORT_SEQUENCE;
}

/**
 * Convenience: the restore helper loads tables parents-first.
 */
export function restoreOrder(): readonly ZoneScopedTable[] {
  return RESTORE_SEQUENCE;
}
