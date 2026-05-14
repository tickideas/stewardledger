// packages/api/src/services/paying-in-books/validate.ts
// Phase 8 — paying-in-book reference-code validation. Called from
// the contribution-batches service when a treasurer attaches a
// reference code to a batch; throws a tagged service error if the
// code doesn't fall within an active book range for the chapter on
// the given date.
// RELEVANT FILES: packages/db/src/schema/paying-in-books.ts, packages/api/src/services/contribution-batches.ts

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { payingInBooks } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

export class PayingInBookError extends Error {
  constructor(
    readonly code: "reference_code_not_in_book",
    message: string,
  ) {
    super(message);
  }
}

export interface ReferenceCodeRangeArgs {
  zoneId: string;
  chapterId: string;
  referenceCode: string;
  /** ISO yyyy-mm-dd. Typically the batch's `contributionDate` or
   *  `createdAt` truncated to a date. */
  onDate: string;
}

/**
 * Confirm `args.referenceCode` falls within at least one active
 * paying-in book for `(zoneId, chapterId)` on `onDate`. Throws a
 * tagged `PayingInBookError("reference_code_not_in_book", ...)` if
 * nothing matches. The route layer maps that to a 422.
 *
 * Reference codes are compared lexicographically (Postgres' default
 * text ordering). Treasurer pads use zero-padded or alphanumeric
 * codes; lexicographic ordering covers both consistently within a
 * single book. The error message is deliberately specific so a
 * malformed code (wrong width, wrong prefix) is easy to spot.
 */
export async function assertReferenceCodeInRange(
  database: Db,
  args: ReferenceCodeRangeArgs,
): Promise<void> {
  const [row] = await database
    .select({ id: payingInBooks.id })
    .from(payingInBooks)
    .where(
      and(
        eq(payingInBooks.zoneId, args.zoneId),
        eq(payingInBooks.chapterId, args.chapterId),
        lte(payingInBooks.dateFrom, args.onDate),
        or(isNull(payingInBooks.dateTo), sql`${payingInBooks.dateTo} >= ${args.onDate}::date`)!,
        sql`${payingInBooks.referenceCodeStart} <= ${args.referenceCode}`,
        sql`${payingInBooks.referenceCodeEnd} >= ${args.referenceCode}`,
      ),
    )
    .limit(1);
  if (!row) {
    throw new PayingInBookError(
      "reference_code_not_in_book",
      `Reference code "${args.referenceCode}" is not within any active paying-in book for this chapter on ${args.onDate}.`,
    );
  }
}
