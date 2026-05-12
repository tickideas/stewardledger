// packages/db/src/schema/batch-templates.ts
// Per-chapter batch templates. A treasurer running Sunday close clones a
// template into a fresh `contribution_batches` row, saving the repeated
// data-entry of source type, default currency, and notes.
//
// Templates are intentionally narrow:
//   • `payload` carries the create-form preset (sourceType, currency,
//     reference, notes, optional pre-filled lines). The shape lives in
//     `@stewardledger/shared/schemas` (`contributionBatchTemplatePayloadSchema`).
//   • No live FK from `payload` into `giving_types` / `accounts` — those
//     are looked up by id when the template is applied, and a stale id
//     is treated as a soft skip on the client.
//
// Hard-deleted rather than soft-deleted: templates are a per-chapter
// convenience, not a system-of-record. Audit-of-delete still lands in
// `audit_events` via the route handler.

import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { chapters } from "./chapters";
import { user } from "./auth";
import { zones } from "./zones";

export const chapterBatchTemplates = pgTable(
  "chapter_batch_templates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chapter_batch_templates_chapter_idx").on(table.chapterId),
    // Within a chapter, template names are unique. Treasurers identify
    // templates by name; collisions would silently load the wrong shape.
    uniqueIndex("chapter_batch_templates_chapter_name_idx").on(table.chapterId, table.name),
  ],
);

export type ChapterBatchTemplate = typeof chapterBatchTemplates.$inferSelect;
export type NewChapterBatchTemplate = typeof chapterBatchTemplates.$inferInsert;
