// packages/db/src/schema/platform-invitations.ts
// Pending invitations to a platform-level role (super_admin, support_admin,
// billing_admin, region_curator). Sibling to `invitations`, which is
// zone-scoped (zone_id NOT NULL); this table is deliberately separate so the
// zone-tenant invariant stays clean.
// RELEVANT FILES: packages/db/src/schema/invitations.ts, packages/db/src/schema/roles.ts, packages/api/src/services/platform-invitations.ts

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const platformInvitations = pgTable(
  "platform_invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Always stored lowercase. */
    email: text("email").notNull(),
    /** Display name set by the inviter; surfaced on the accept page. */
    name: text("name").notNull(),
    /**
     * Platform role granted on accept. `super_admin` is NOT a valid value —
     * the super-admin bit is layered via `superAdmin` below so the audit
     * action (`platform.admin.elevate`) stays distinct.
     */
    roleCode: text("role_code").notNull(),
    /** When true, also flips `user.is_super_admin` on accept. */
    superAdmin: boolean("super_admin").notNull().default(false),
    /** SHA-256 hex of the opaque token. Raw token only in the email URL. */
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
    uniqueIndex("platform_invitations_token_hash_idx").on(table.tokenHash),
    index("platform_invitations_email_idx").on(table.email),
    /** One open invitation per (email, role) at a time. */
    uniqueIndex("platform_invitations_open_unique_idx")
      .on(table.email, table.roleCode)
      .where(sql`accepted_at is null and revoked_at is null`),
    check(
      "platform_invitations_role_check",
      sql`${table.roleCode} in ('support_admin', 'billing_admin', 'region_curator')`,
    ),
  ],
);

export type PlatformInvitation = typeof platformInvitations.$inferSelect;
export type NewPlatformInvitation = typeof platformInvitations.$inferInsert;
