// packages/db/src/schema/invitations.ts
// Pending invitations to join a zone. The token is opaque (32-byte URL-safe);
// only its SHA-256 hash is stored. See docs/PRD.md §7.2 and §6.

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import { zones } from "./zones";

export const invitations = pgTable(
  "invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    /** Null = zone-wide binding. Set = chapter-scoped binding. */
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    /** Always stored lowercase. */
    email: text("email").notNull(),
    /** Role code from @stewardledger/shared/roles. Validated in service. */
    roleCode: text("role_code").notNull(),
    /** SHA-256 hex of the opaque token. The raw token is only in the email URL. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null when this is the bootstrap zone_owner invite created at signup. */
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_idx").on(table.tokenHash),
    index("invitations_zone_idx").on(table.zoneId),
    index("invitations_email_idx").on(table.email),
    /** Only one open invitation per (zone, email, chapter, role). */
    uniqueIndex("invitations_open_unique_idx")
      .on(table.zoneId, table.email, table.chapterId, table.roleCode)
      .where(sql`accepted_at is null and revoked_at is null`),
    check(
      "invitations_role_consistent_with_chapter",
      sql`(chapter_id is null) or (role_code like 'chapter_%')`,
    ),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
