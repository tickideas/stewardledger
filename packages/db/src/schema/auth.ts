// packages/db/src/schema/auth.ts
// Better Auth tables. Schema names match Better Auth's drizzle adapter
// expectations (`user`, `session`, `account`, `verification`,
// `twoFactor`).
// We add a thin StewardLedger-specific layer in roles.ts (user_role_bindings).

import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// ─── User ─────────────────────────────────────────────
// Global user identity. A user can belong to many zones via user_role_bindings.
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    image: text("image"),
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    /** Default zone to land on when the user has multiple bindings. */
    defaultZoneId: text("default_zone_id"),
    /**
     * Better Auth's two-factor plugin maintains this flag. The
     * column lives on `user` so it can be read alongside the
     * session without a join. Mirrors the plugin's
     * `twoFactorEnabled` field (see
     * `better-auth/dist/plugins/two-factor/schema.mjs`).
     */
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("user_email_idx").on(table.email)],
);

// ─── Session ──────────────────────────────────────────
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Account (OAuth providers, password) ──────────────
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Verification (OTP, magic link, email verification tokens) ────
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Two-factor (TOTP + backup codes) ─────────────────
// Owned by Better Auth's two-factor plugin. Field shapes mirror the
// plugin's expected schema (`better-auth/dist/plugins/two-factor/
// schema.mjs`): the plugin creates / updates rows here on
// enable / verify / disable. We do not write to this table from
// StewardLedger code paths.
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Base32 TOTP secret. Never returned to the client. */
    secret: text("secret").notNull(),
    /** Encrypted, comma-joined recovery codes. Never returned. */
    backupCodes: text("backup_codes").notNull(),
    /**
     * False between `enable` and the first successful `verify-totp`.
     * The plugin treats `verified=false` as "setup in progress".
     */
    verified: boolean("verified").notNull().default(true),
  },
  (table) => [index("two_factor_user_id_idx").on(table.userId)],
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type TwoFactor = typeof twoFactor.$inferSelect;
