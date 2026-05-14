// packages/db/src/schema/paying-in-books.ts
// Phase 8 — paying-in books. Each row represents a deposit-slip pad
// issued to a chapter: a contiguous range of reference codes, valid
// for some date window. Contribution batches reference one of these
// codes when a treasurer deposits cash; validation at write time
// confirms the code falls within an active book for the chapter.
// RELEVANT FILES: packages/api/src/services/paying-in-books/validate.ts, packages/api/src/routes/tenant-paying-in-books.ts, docs/DOMAIN-MODEL.md §8

import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { chapters } from "./chapters";
import { zones } from "./zones";

/**
 * Reference codes are stored as `text` and compared
 * lexicographically. Treasurer pads use zero-padded sequential
 * codes ("0000001"..."0000200") or alphanumeric prefixes
 * ("PIB-A-001"..."PIB-A-100"); lexicographic ordering matches the
 * intuitive ordering **only when start and end have the same
 * length**. With "0001" .. "100" (different widths) the range
 * would lexicographically include "002", a 3-digit code that
 * almost certainly wasn't supposed to fall inside a 4-digit pad.
 *
 * The Zod schema and the PATCH after-merge check both enforce
 * `length(start) === length(end)`. The DB CHECK below enforces
 * only `start <= end` because Postgres has no easy way to assert
 * equal-length without a function-based constraint and the
 * application layer guard is sufficient: nothing in the system
 * writes a paying-in book without going through the routes.
 *
 * The validator surfaces a clear "not in range" message rather
 * than trying to parse the code into a number, so a malformed
 * code (wrong width, wrong prefix) gets caught with an actionable
 * message at write time.
 */
export const payingInBooks = pgTable(
  "paying_in_books",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").notNull(),
    referenceCodeStart: text("reference_code_start").notNull(),
    referenceCodeEnd: text("reference_code_end").notNull(),
    dateFrom: date("date_from").notNull(),
    /** Null = open-ended; a closed book has `date_to` set. */
    dateTo: date("date_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("paying_in_books_zone_id_unique").on(table.zoneId, table.id),
    index("paying_in_books_zone_chapter_idx").on(
      table.zoneId,
      table.chapterId,
      table.dateFrom,
      table.dateTo,
    ),
    foreignKey({
      name: "paying_in_books_chapter_zone_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("restrict"),
    check(
      "paying_in_books_dates_check",
      sql`${table.dateTo} is null or ${table.dateTo} >= ${table.dateFrom}`,
    ),
    check(
      "paying_in_books_range_check",
      sql`${table.referenceCodeStart} <= ${table.referenceCodeEnd}`,
    ),
  ],
);

export type PayingInBook = typeof payingInBooks.$inferSelect;
export type NewPayingInBook = typeof payingInBooks.$inferInsert;
