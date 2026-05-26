// packages/db/src/schema/families.ts
// Household / family groupings inside a chapter. See docs/DOMAIN-MODEL.md §3.5
// and docs/CHURCHPLUS-PORT-NOTES.md §2.2.1.
// Composite cross-tenant FKs match the (zone_id, id) pattern shared by
// members.ts / chapters.ts.
// RELEVANT FILES: packages/db/src/schema/members.ts, packages/db/src/schema/chapters.ts, packages/api/src/services/families.ts, packages/api/src/routes/tenant-families.ts

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chapters } from "./chapters";
import { memberAddresses, members } from "./members";
import { regions } from "./regions";
import { zones } from "./zones";

/**
 * A `families` row models one household inside a single chapter. Pastors
 * and treasurers use it to roll up giving by household for the Top Family
 * report and for the "household total" band on the member statement.
 *
 * Soft-delete is allowed so a renamed / folded household preserves history
 * for already-applied reports; the active-name unique index ignores
 * soft-deleted rows. Hard-delete only happens via the dedicated migration
 * if/when we drop the feature.
 */
export const families = pgTable(
  "families",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),
    /** Denormalized from the chapter's zone for fast region-aware reports. */
    regionId: text("region_id").references(() => regions.id, { onDelete: "set null" }),
    /** Families are chapter-scoped per CHURCHPLUS-PORT-NOTES §2.2.1. */
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "restrict" }),
    /** Treasurer-visible code, e.g. "F0000001". Unique per zone. */
    referenceCode: text("reference_code").notNull(),
    /** Treasurer-curated household label, e.g. "The Adeyemi household". */
    name: text("name").notNull(),
    /**
     * Household address. Optional — when null the UI / reports fall back
     * to the primary contact's primary member_addresses row. References
     * member_addresses(id) so a single source of truth survives address
     * edits without duplicating the line1/postcode/etc. fields.
     */
    primaryAddressId: text("primary_address_id").references(() => memberAddresses.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Composite FK target: lets future tables reference families via
    // (zone_id, family_id) and prevents cross-tenant smuggling.
    unique("families_zone_id_unique").on(table.zoneId, table.id),
    // Composite cross-tenant FK to chapters.
    foreignKey({
      name: "families_zone_chapter_fk",
      columns: [table.zoneId, table.chapterId],
      foreignColumns: [chapters.zoneId, chapters.id],
    }).onDelete("restrict"),
    uniqueIndex("families_zone_reference_idx").on(table.zoneId, table.referenceCode),
    // Soft-delete-aware uniqueness on the human-readable label inside a
    // chapter; case-insensitive because treasurers re-type names.
    uniqueIndex("families_zone_chapter_name_active_idx")
      .on(table.zoneId, table.chapterId, sql`lower(${table.name})`)
      .where(sql`deleted_at is null`),
    index("families_zone_chapter_active_idx")
      .on(table.zoneId, table.chapterId)
      .where(sql`deleted_at is null`),
    index("families_zone_active_idx")
      .on(table.zoneId)
      .where(sql`deleted_at is null`),
    index("families_region_idx").on(table.regionId),
  ],
);

/**
 * Membership of a member in a family. `left_at` archives the row instead
 * of deleting it, mirroring `member_addresses.date_to`. A member belongs
 * to at most one open family at a time (partial unique on member_id
 * where left_at is null). Exactly one row per family carries
 * `is_primary_contact = true` while open (partial unique).
 */
export const familyMembers = pgTable(
  "family_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    /**
     * `restrict` because members are soft-deleted; we never hard-delete a
     * member, so the FK never bites in practice and an accidental hard
     * delete attempt during a developer mistake fails loudly.
     */
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    /** Free-text per CHURCHPLUS-PORT-NOTES §5 — household v1, kinship v2. */
    relationship: text("relationship"),
    isPrimaryContact: boolean("is_primary_contact").notNull().default(false),
    joinedAt: date("joined_at").notNull().defaultNow(),
    /** Null = currently in this family. Set = archived membership row. */
    leftAt: date("left_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite FK target so future tables can scope by (zone_id, id).
    unique("family_members_zone_id_unique").on(table.zoneId, table.id),
    // Composite cross-tenant FKs. The single-column FKs declared above
    // via `.references(() => ...)` keep cascading-delete semantics; the
    // composite FKs below guarantee that (zone_id, family_id) and
    // (zone_id, member_id) cannot disagree across tenants. The
    // duplication is intentional — do not "clean up" by dropping either
    // half. Removing the single-column FK breaks cascade-on-delete;
    // removing the composite FK reopens cross-tenant smuggling (see
    // tenant-families.test.ts "composite FK refuses cross-tenant
    // smuggling" and families.schema.test.ts).
    foreignKey({
      name: "family_members_zone_family_fk",
      columns: [table.zoneId, table.familyId],
      foreignColumns: [families.zoneId, families.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "family_members_zone_member_fk",
      columns: [table.zoneId, table.memberId],
      foreignColumns: [members.zoneId, members.id],
    }).onDelete("restrict"),
    // A member belongs to at most one OPEN family at a time. Archived
    // rows (left_at set) are excluded so re-joining a household later is
    // legal.
    uniqueIndex("family_members_one_open_per_member_idx")
      .on(table.memberId)
      .where(sql`left_at is null`),
    // Exactly one primary contact per family among open members.
    uniqueIndex("family_members_one_primary_per_family_idx")
      .on(table.familyId)
      .where(sql`is_primary_contact = true and left_at is null`),
    index("family_members_zone_family_idx").on(table.zoneId, table.familyId),
    index("family_members_zone_member_idx").on(table.zoneId, table.memberId),
    check(
      "family_members_window_check",
      sql`left_at is null or left_at >= joined_at`,
    ),
  ],
);

export type Family = typeof families.$inferSelect;
export type NewFamily = typeof families.$inferInsert;
export type FamilyMember = typeof familyMembers.$inferSelect;
export type NewFamilyMember = typeof familyMembers.$inferInsert;
