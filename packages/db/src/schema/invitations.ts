// packages/db/src/schema/invitations.ts
// Pending invitations to join a zone. The token is opaque (32-byte URL-safe);
// only its SHA-256 hash is stored. See docs/PRD.md §7.2 and §6.

import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import { groups } from "./groups";
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
    /** Null when binding is zone- or group-scoped; set for chapter bindings. */
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    /** Null when binding is zone- or chapter-scoped; set for group bindings. */
    groupId: text("group_id"),
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
    /** Open zone invite: (zone, email, role) when neither group nor chapter is set. */
    uniqueIndex("invitations_open_zone_unique_idx")
      .on(table.zoneId, table.email, table.roleCode)
      .where(sql`accepted_at is null and revoked_at is null and group_id is null and chapter_id is null`),
    /** Open group invite: (zone, email, group, role) when chapter is null. */
    uniqueIndex("invitations_open_group_unique_idx")
      .on(table.zoneId, table.email, table.groupId, table.roleCode)
      .where(sql`accepted_at is null and revoked_at is null and group_id is not null and chapter_id is null`),
    /** Open chapter invite: (zone, email, chapter, role) when group is null. */
    uniqueIndex("invitations_open_chapter_unique_idx")
      .on(table.zoneId, table.email, table.chapterId, table.roleCode)
      .where(sql`accepted_at is null and revoked_at is null and group_id is null and chapter_id is not null`),
    check(
      "invitations_scope_shape",
      sql`(
        (role_code like 'group_%' and group_id is not null and chapter_id is null) or
        (role_code like 'chapter_%' and chapter_id is not null and group_id is null) or
        (role_code not like 'group_%' and role_code not like 'chapter_%' and group_id is null and chapter_id is null)
      )`,
    ),
    foreignKey({
      name: "invitations_zone_group_fk",
      columns: [table.zoneId, table.groupId],
      foreignColumns: [groups.zoneId, groups.id],
    }).onDelete("cascade"),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
