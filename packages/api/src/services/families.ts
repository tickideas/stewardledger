// packages/api/src/services/families.ts
// Family / household service. Pure functions that take an AuthorizedContext.
// Implements create / update / soft-delete / member add / member archive /
// primary-contact toggle / transfer. Audit emitted via services/audit.ts.
//
// All write paths run inside db.transaction so the partial-unique
// indexes on family_members (one open family per member, one primary
// contact per family) surface as clean service errors instead of stray
// 23505s in the route layer.
// RELEVANT FILES: packages/db/src/schema/families.ts, packages/api/src/routes/tenant-families.ts, packages/api/src/services/family-codes.ts, docs/DOMAIN-MODEL.md

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  chapters,
  contributionLines,
  contributions,
  families,
  familyMembers,
  memberAddresses,
  members,
} from "@stewardledger/db/schema";
import type { Database, Db } from "@stewardledger/db";
import type { AuthorizedContext, FamilyCreateInput } from "@stewardledger/shared";
import { writeAudit, writeAuditMany } from "./audit";
import { nextFamilyReferenceCode } from "./family-codes";

export class FamilyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const direct = err as { code?: unknown; cause?: unknown };
  if (direct.code === "23505") return true;
  const cause = direct.cause;
  return Boolean(cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505");
}

function uniqueConstraint(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const direct = err as { constraint_name?: unknown; constraint?: unknown; cause?: unknown };
  const fromTop =
    typeof direct.constraint_name === "string"
      ? direct.constraint_name
      : typeof direct.constraint === "string"
        ? direct.constraint
        : null;
  if (fromTop) return fromTop;
  const cause = direct.cause;
  if (cause && typeof cause === "object") {
    const c = cause as { constraint_name?: unknown; constraint?: unknown };
    if (typeof c.constraint_name === "string") return c.constraint_name;
    if (typeof c.constraint === "string") return c.constraint;
  }
  return null;
}

interface FamilyRow {
  id: string;
  zoneId: string;
  chapterId: string;
  referenceCode: string;
  name: string;
  notes: string | null;
  primaryAddressId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface FamilyDetail extends FamilyRow {
  members: FamilyMemberDetail[];
}

export interface FamilyMemberDetail {
  id: string;
  memberId: string;
  memberReferenceCode: string;
  memberFullName: string | null;
  relationship: string | null;
  isPrimaryContact: boolean;
  joinedAt: string;
  leftAt: string | null;
}

async function ensureActiveChapterInZone(
  tx: Db,
  zoneId: string,
  chapterId: string,
): Promise<{ regionId: string | null }> {
  const [row] = await tx
    .select({ regionId: chapters.regionId })
    .from(chapters)
    .where(
      and(
        eq(chapters.zoneId, zoneId),
        eq(chapters.id, chapterId),
        isNull(chapters.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new FamilyError("chapter_not_found", "Chapter is not in this zone.");
  return { regionId: row.regionId };
}

async function ensureMemberInZoneAndChapter(
  tx: Db,
  zoneId: string,
  chapterId: string,
  memberId: string,
): Promise<{ id: string; chapterId: string | null }> {
  const [row] = await tx
    .select({ id: members.id, chapterId: members.chapterId })
    .from(members)
    .where(
      and(eq(members.zoneId, zoneId), eq(members.id, memberId), isNull(members.deletedAt)),
    )
    .limit(1);
  if (!row) throw new FamilyError("member_not_found", "Member is not in this zone.");
  // A family is chapter-scoped (DOMAIN-MODEL.md §3.5). A chapterless
  // member would force the operator to pick a chapter implicitly by
  // picking the family — better to fail loud and route them through
  // the member-profile chapter-assign flow first.
  if (!row.chapterId) {
    throw new FamilyError(
      "member_chapter_missing",
      "Assign the member to a chapter before adding them to a household.",
    );
  }
  if (row.chapterId !== chapterId) {
    throw new FamilyError(
      "member_chapter_mismatch",
      "Member belongs to a different chapter than this family.",
    );
  }
  return row;
}

async function ensureAddressBelongsToMember(
  tx: Db,
  zoneId: string,
  addressId: string,
  memberId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: memberAddresses.id })
    .from(memberAddresses)
    .where(
      and(
        eq(memberAddresses.zoneId, zoneId),
        eq(memberAddresses.id, addressId),
        eq(memberAddresses.memberId, memberId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new FamilyError(
      "address_not_in_member",
      "primaryAddressId must reference one of the primary contact's addresses.",
    );
  }
}

export async function createFamily(
  database: Database,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  input: FamilyCreateInput,
): Promise<FamilyDetail> {
  return database.transaction(async (tx) => {
    const { regionId } = await ensureActiveChapterInZone(tx, ctx.zoneId, input.chapterId);

    if (input.primaryMemberId) {
      await ensureMemberInZoneAndChapter(tx, ctx.zoneId, input.chapterId, input.primaryMemberId);
    }
    if (input.primaryAddressId) {
      if (!input.primaryMemberId) {
        throw new FamilyError(
          "primary_address_without_member",
          "primaryAddressId requires primaryMemberId so we can verify ownership.",
        );
      }
      await ensureAddressBelongsToMember(
        tx,
        ctx.zoneId,
        input.primaryAddressId,
        input.primaryMemberId,
      );
    }

    const referenceCode = await nextFamilyReferenceCode(tx, ctx.zoneId);

    let row: FamilyRow;
    try {
      const [inserted] = await tx
        .insert(families)
        .values({
          zoneId: ctx.zoneId,
          regionId,
          chapterId: input.chapterId,
          referenceCode,
          name: input.name,
          notes: input.notes ?? null,
          primaryAddressId: input.primaryAddressId ?? null,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning();
      row = inserted as FamilyRow;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const constraint = uniqueConstraint(err);
        if (constraint?.includes("name_active")) {
          throw new FamilyError(
            "family_name_taken",
            "Another active family already has this name in the chapter.",
          );
        }
        if (constraint?.includes("reference")) {
          throw new FamilyError(
            "reference_code_collision",
            "Reference-code generator collided; please retry.",
          );
        }
      }
      throw err;
    }

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      actorRoleCode: ctx.roleCode ?? null,
      action: "family.create",
      entityType: "family",
      entityId: row.id,
      after: {
        chapterId: row.chapterId,
        referenceCode: row.referenceCode,
        name: row.name,
        notes: row.notes,
      },
    });

    const memberDetails: FamilyMemberDetail[] = [];
    if (input.primaryMemberId) {
      const detail = await addFamilyMemberInTx(tx, ctx, row.id, {
        memberId: input.primaryMemberId,
        relationship: input.primaryMemberRelationship ?? null,
        isPrimaryContact: true,
      });
      memberDetails.push(detail);
    }

    return { ...row, members: memberDetails };
  });
}

export async function updateFamily(
  database: Database,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  familyId: string,
  patch: { name?: string; notes?: string | null; primaryAddressId?: string | null },
): Promise<FamilyRow> {
  return database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(families)
      .where(
        and(eq(families.zoneId, ctx.zoneId), eq(families.id, familyId), isNull(families.deletedAt)),
      )
      .limit(1);
    if (!existing) throw new FamilyError("family_not_found", "Family not in this zone.");

    // If we're rewiring primaryAddressId, ensure the address belongs to a
    // current (open) member of this family.
    if (patch.primaryAddressId !== undefined && patch.primaryAddressId !== null) {
      const [{ memberId } = { memberId: null as string | null }] = await tx
        .select({ memberId: memberAddresses.memberId })
        .from(memberAddresses)
        .where(
          and(
            eq(memberAddresses.zoneId, ctx.zoneId),
            eq(memberAddresses.id, patch.primaryAddressId),
          ),
        )
        .limit(1);
      if (!memberId) {
        throw new FamilyError("address_not_in_zone", "Address not in this zone.");
      }
      const [open] = await tx
        .select({ id: familyMembers.id })
        .from(familyMembers)
        .where(
          and(
            eq(familyMembers.zoneId, ctx.zoneId),
            eq(familyMembers.familyId, familyId),
            eq(familyMembers.memberId, memberId),
            isNull(familyMembers.leftAt),
          ),
        )
        .limit(1);
      if (!open) {
        throw new FamilyError(
          "address_not_in_member",
          "Selected address must belong to a current household member.",
        );
      }
    }

    const setPatch: Record<string, unknown> = { updatedAt: new Date(), updatedByUserId: ctx.userId };
    if (patch.name !== undefined) setPatch.name = patch.name;
    if (patch.notes !== undefined) setPatch.notes = patch.notes;
    if (patch.primaryAddressId !== undefined) setPatch.primaryAddressId = patch.primaryAddressId;

    let row: FamilyRow;
    try {
      const [updated] = await tx
        .update(families)
        .set(setPatch)
        .where(and(eq(families.zoneId, ctx.zoneId), eq(families.id, familyId)))
        .returning();
      row = updated as FamilyRow;
    } catch (err) {
      if (isUniqueViolation(err) && uniqueConstraint(err)?.includes("name_active")) {
        throw new FamilyError(
          "family_name_taken",
          "Another active family already has this name in the chapter.",
        );
      }
      throw err;
    }

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      actorRoleCode: ctx.roleCode ?? null,
      action: "family.update",
      entityType: "family",
      entityId: row.id,
      before: { name: existing.name, notes: existing.notes, primaryAddressId: existing.primaryAddressId },
      after: { name: row.name, notes: row.notes, primaryAddressId: row.primaryAddressId },
    });
    return row;
  });
}

export async function softDeleteFamily(
  database: Database,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  familyId: string,
  reason: string | null,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(families)
      .where(
        and(eq(families.zoneId, ctx.zoneId), eq(families.id, familyId), isNull(families.deletedAt)),
      )
      .limit(1);
    if (!existing) throw new FamilyError("family_not_found", "Family not in this zone.");

    const [{ openCount }] = await tx
      .select({ openCount: sql<number>`count(*)::int` })
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.zoneId, ctx.zoneId),
          eq(familyMembers.familyId, familyId),
          isNull(familyMembers.leftAt),
        ),
      );
    if (openCount > 0) {
      throw new FamilyError(
        "family_has_open_members",
        "Archive every member of the household before deleting it.",
      );
    }

    await tx
      .update(families)
      .set({ deletedAt: new Date(), updatedAt: new Date(), updatedByUserId: ctx.userId })
      .where(and(eq(families.zoneId, ctx.zoneId), eq(families.id, familyId)));

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      actorRoleCode: ctx.roleCode ?? null,
      action: "family.delete",
      entityType: "family",
      entityId: familyId,
      before: existing,
      after: null,
      reason,
    });
  });
}

/**
 * Insert a family_members row inside an already-open transaction. Shared by
 * `createFamily` (primary member convenience) and `addFamilyMember`.
 */
async function addFamilyMemberInTx(
  tx: Db,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  familyId: string,
  input: { memberId: string; relationship: string | null; isPrimaryContact: boolean },
): Promise<FamilyMemberDetail> {
  // If the caller wants the new row as primary, demote the existing primary
  // in the same tx so the partial unique on (family_id) where
  // is_primary_contact = true and left_at is null doesn't fire.
  if (input.isPrimaryContact) {
    await tx
      .update(familyMembers)
      .set({ isPrimaryContact: false, updatedAt: new Date() })
      .where(
        and(
          eq(familyMembers.zoneId, ctx.zoneId),
          eq(familyMembers.familyId, familyId),
          eq(familyMembers.isPrimaryContact, true),
          isNull(familyMembers.leftAt),
        ),
      );
  }

  let inserted: typeof familyMembers.$inferSelect;
  try {
    [inserted] = await tx
      .insert(familyMembers)
      .values({
        zoneId: ctx.zoneId,
        familyId,
        memberId: input.memberId,
        relationship: input.relationship,
        isPrimaryContact: input.isPrimaryContact,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const constraint = uniqueConstraint(err);
      if (constraint?.includes("one_open_per_member")) {
        throw new FamilyError(
          "member_already_in_family",
          "Member is already in another household. Archive that membership first.",
        );
      }
      if (constraint?.includes("one_primary_per_family")) {
        throw new FamilyError(
          "primary_contact_already_set",
          "Another primary contact was just assigned; refresh and try again.",
        );
      }
    }
    throw err;
  }

  const [member] = await tx
    .select({ referenceCode: members.referenceCode, fullName: members.fullName })
    .from(members)
    .where(and(eq(members.zoneId, ctx.zoneId), eq(members.id, input.memberId)))
    .limit(1);

  await writeAudit(tx, {
    zoneId: ctx.zoneId,
    actorUserId: ctx.userId,
    actorRoleCode: ctx.roleCode ?? null,
    action: "family.member.add",
    entityType: "family",
    entityId: familyId,
    after: {
      familyMemberId: inserted.id,
      memberId: input.memberId,
      relationship: input.relationship,
      isPrimaryContact: input.isPrimaryContact,
    },
  });

  return {
    id: inserted.id,
    memberId: inserted.memberId,
    memberReferenceCode: member?.referenceCode ?? "",
    memberFullName: member?.fullName ?? null,
    relationship: inserted.relationship,
    isPrimaryContact: inserted.isPrimaryContact,
    joinedAt: inserted.joinedAt as unknown as string,
    leftAt: (inserted.leftAt as unknown as string | null) ?? null,
  };
}

export async function addFamilyMember(
  database: Database,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  familyId: string,
  input: { memberId: string; relationship?: string | null; isPrimaryContact?: boolean },
): Promise<FamilyMemberDetail> {
  return database.transaction(async (tx) => {
    const [family] = await tx
      .select({ id: families.id, chapterId: families.chapterId })
      .from(families)
      .where(
        and(eq(families.zoneId, ctx.zoneId), eq(families.id, familyId), isNull(families.deletedAt)),
      )
      .limit(1);
    if (!family) throw new FamilyError("family_not_found", "Family not in this zone.");
    await ensureMemberInZoneAndChapter(tx, ctx.zoneId, family.chapterId, input.memberId);

    return addFamilyMemberInTx(tx, ctx, familyId, {
      memberId: input.memberId,
      relationship: input.relationship ?? null,
      isPrimaryContact: input.isPrimaryContact ?? false,
    });
  });
}

export async function updateFamilyMember(
  database: Database,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  familyId: string,
  memberId: string,
  patch: { relationship?: string | null; isPrimaryContact?: boolean },
): Promise<FamilyMemberDetail> {
  return database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.zoneId, ctx.zoneId),
          eq(familyMembers.familyId, familyId),
          eq(familyMembers.memberId, memberId),
          isNull(familyMembers.leftAt),
        ),
      )
      .limit(1);
    if (!existing) throw new FamilyError("family_member_not_found", "Member is not in this household.");

    // Promote to primary contact: demote any other current primary first.
    if (patch.isPrimaryContact === true && !existing.isPrimaryContact) {
      await tx
        .update(familyMembers)
        .set({ isPrimaryContact: false, updatedAt: new Date() })
        .where(
          and(
            eq(familyMembers.zoneId, ctx.zoneId),
            eq(familyMembers.familyId, familyId),
            eq(familyMembers.isPrimaryContact, true),
            isNull(familyMembers.leftAt),
          ),
        );
    }
    // Refuse demoting the last primary explicitly — operators must promote
    // another member first.
    if (patch.isPrimaryContact === false && existing.isPrimaryContact) {
      throw new FamilyError(
        "primary_contact_required",
        "Promote another member to primary before demoting this one.",
      );
    }

    const setPatch: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.relationship !== undefined) setPatch.relationship = patch.relationship;
    if (patch.isPrimaryContact !== undefined) setPatch.isPrimaryContact = patch.isPrimaryContact;

    let updated: typeof familyMembers.$inferSelect;
    try {
      [updated] = await tx
        .update(familyMembers)
        .set(setPatch)
        .where(eq(familyMembers.id, existing.id))
        .returning();
    } catch (err) {
      if (
        isUniqueViolation(err) &&
        uniqueConstraint(err)?.includes("one_primary_per_family")
      ) {
        throw new FamilyError(
          "primary_contact_already_set",
          "Another primary contact was just assigned; refresh and try again.",
        );
      }
      throw err;
    }

    const [member] = await tx
      .select({ referenceCode: members.referenceCode, fullName: members.fullName })
      .from(members)
      .where(and(eq(members.zoneId, ctx.zoneId), eq(members.id, memberId)))
      .limit(1);

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      actorRoleCode: ctx.roleCode ?? null,
      action:
        patch.isPrimaryContact === true && !existing.isPrimaryContact
          ? "family.primary_contact.set"
          : "family.member.update",
      entityType: "family",
      entityId: familyId,
      before: {
        relationship: existing.relationship,
        isPrimaryContact: existing.isPrimaryContact,
      },
      after: {
        relationship: updated.relationship,
        isPrimaryContact: updated.isPrimaryContact,
      },
    });

    return {
      id: updated.id,
      memberId: updated.memberId,
      memberReferenceCode: member?.referenceCode ?? "",
      memberFullName: member?.fullName ?? null,
      relationship: updated.relationship,
      isPrimaryContact: updated.isPrimaryContact,
      joinedAt: updated.joinedAt as unknown as string,
      leftAt: (updated.leftAt as unknown as string | null) ?? null,
    };
  });
}

export async function removeFamilyMember(
  database: Database,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  familyId: string,
  memberId: string,
  reason: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.zoneId, ctx.zoneId),
          eq(familyMembers.familyId, familyId),
          eq(familyMembers.memberId, memberId),
          isNull(familyMembers.leftAt),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new FamilyError("family_member_not_found", "Member is not currently in this household.");
    }

    if (existing.isPrimaryContact) {
      const [{ otherOpen }] = await tx
        .select({ otherOpen: sql<number>`count(*)::int` })
        .from(familyMembers)
        .where(
          and(
            eq(familyMembers.zoneId, ctx.zoneId),
            eq(familyMembers.familyId, familyId),
            isNull(familyMembers.leftAt),
            sql`${familyMembers.id} <> ${existing.id}`,
          ),
        );
      if (otherOpen > 0) {
        throw new FamilyError(
          "primary_contact_required",
          "Promote another member to primary before removing this one.",
        );
      }
      // Last member of the household — demote the primary flag first so the
      // archive write doesn't leave a stale primary in history.
    }

    // `left_at` is a calendar date in UTC — same convention as
    // `member_addresses.date_to` and `joined_at` above. A zone in a far-
    // east TZ writing at local 02:00 will see UTC "yesterday", which is
    // consistent across the schema; the `family_members_window_check`
    // (left_at >= joined_at) covers same-day add+remove.
    const today = new Date().toISOString().slice(0, 10);
    await tx
      .update(familyMembers)
      .set({ leftAt: today, isPrimaryContact: false, updatedAt: new Date() })
      .where(eq(familyMembers.id, existing.id));

    await writeAudit(tx, {
      zoneId: ctx.zoneId,
      actorUserId: ctx.userId,
      actorRoleCode: ctx.roleCode ?? null,
      action: "family.member.remove",
      entityType: "family",
      entityId: familyId,
      before: {
        familyMemberId: existing.id,
        memberId: existing.memberId,
        relationship: existing.relationship,
        isPrimaryContact: existing.isPrimaryContact,
        joinedAt: existing.joinedAt,
      },
      after: { leftAt: today },
      reason,
    });
  });
}

/**
 * Move every open member of `fromFamilyId` to `toFamilyId`. Both families
 * must live in the same chapter; cross-chapter moves go through
 * member-level edits so the audit trail is explicit.
 */
export async function transferFamily(
  database: Database,
  ctx: { zoneId: string; userId: string; roleCode?: string | null },
  fromFamilyId: string,
  toFamilyId: string,
  reason: string | null,
): Promise<{ movedMemberIds: string[] }> {
  return database.transaction(async (tx) => {
    if (fromFamilyId === toFamilyId) {
      throw new FamilyError("transfer_same_family", "Source and target families must differ.");
    }

    const both = await tx
      .select({ id: families.id, chapterId: families.chapterId, deletedAt: families.deletedAt })
      .from(families)
      .where(
        and(
          eq(families.zoneId, ctx.zoneId),
          inArray(families.id, [fromFamilyId, toFamilyId]),
        ),
      );
    const from = both.find((f) => f.id === fromFamilyId);
    const to = both.find((f) => f.id === toFamilyId);
    if (!from || !to) throw new FamilyError("family_not_found", "Family not in this zone.");
    if (from.deletedAt || to.deletedAt) {
      throw new FamilyError("family_deleted", "Cannot transfer to or from a deleted family.");
    }
    if (from.chapterId !== to.chapterId) {
      throw new FamilyError(
        "transfer_cross_chapter",
        "Families must share a chapter to transfer members in bulk.",
      );
    }

    // Snapshot the open members of the source family.
    const open = await tx
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.zoneId, ctx.zoneId),
          eq(familyMembers.familyId, fromFamilyId),
          isNull(familyMembers.leftAt),
        ),
      );
    if (open.length === 0) {
      return { movedMemberIds: [] };
    }

    // Demote any existing primary in the destination so we can carry the
    // source primary across without tripping the partial unique. The new
    // primary is whichever row was primary in the source (defaults to the
    // first if none).
    await tx
      .update(familyMembers)
      .set({ isPrimaryContact: false, updatedAt: new Date() })
      .where(
        and(
          eq(familyMembers.zoneId, ctx.zoneId),
          eq(familyMembers.familyId, toFamilyId),
          eq(familyMembers.isPrimaryContact, true),
          isNull(familyMembers.leftAt),
        ),
      );

    const primaryAssigned = open.find((r) => r.isPrimaryContact)?.id ?? open[0].id;

    for (const row of open) {
      const newPrimary = row.id === primaryAssigned;
      try {
        await tx
          .update(familyMembers)
          .set({
            familyId: toFamilyId,
            isPrimaryContact: newPrimary,
            updatedAt: new Date(),
          })
          .where(eq(familyMembers.id, row.id));
      } catch (err) {
        if (
          isUniqueViolation(err) &&
          uniqueConstraint(err)?.includes("one_primary_per_family")
        ) {
          throw new FamilyError(
            "primary_contact_already_set",
            "Destination family already has a primary contact; refresh and try again.",
          );
        }
        throw err;
      }
    }

    await writeAuditMany(
      tx,
      open.map((row) => ({
        zoneId: ctx.zoneId,
        actorUserId: ctx.userId,
        actorRoleCode: ctx.roleCode ?? null,
        action: "family.transfer",
        entityType: "family",
        entityId: row.familyId, // source family id — auditor reads the move from the source
        before: { fromFamilyId },
        after: { toFamilyId, memberId: row.memberId },
        reason,
      })),
    );

    return { movedMemberIds: open.map((r) => r.memberId) };
  });
}

/**
 * Resolve the open family (if any) for a given member. Used by the
 * member-statement household band and the /zone/members/[id] UI.
 */
export async function familyForMember(
  database: Db,
  zoneId: string,
  memberId: string,
): Promise<
  | (FamilyRow & { familyMemberId: string; relationship: string | null; isPrimaryContact: boolean })
  | null
> {
  const [row] = await database
    .select({
      family: families,
      familyMemberId: familyMembers.id,
      relationship: familyMembers.relationship,
      isPrimaryContact: familyMembers.isPrimaryContact,
    })
    .from(familyMembers)
    .innerJoin(
      families,
      and(eq(families.zoneId, familyMembers.zoneId), eq(families.id, familyMembers.familyId)),
    )
    .where(
      and(
        eq(familyMembers.zoneId, zoneId),
        eq(familyMembers.memberId, memberId),
        isNull(familyMembers.leftAt),
        isNull(families.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...(row.family as FamilyRow),
    familyMemberId: row.familyMemberId,
    relationship: row.relationship,
    isPrimaryContact: row.isPrimaryContact,
  };
}

/**
 * Per-currency household giving total for a date window. Sums signed
 * `contribution_lines.amount` (so original + reversal nets to zero). The
 * caller is responsible for clamping `dateFrom`/`dateTo` to its own
 * reporting window — this helper does not infer a default range.
 *
 * Membership is matched POINT-IN-TIME: a contribution is attributed to a
 * household only if the giver was in that household on the contribution
 * date (`joined_at <= contribution_date AND (left_at IS NULL OR left_at >
 * contribution_date)`). This prevents transfers and member-archives from
 * silently re-attributing historical giving — a treasurer reading last
 * year's number gets last year's household composition.
 */
export async function familyGivingTotals(
  database: Db,
  zoneId: string,
  familyId: string,
  range: { dateFrom: string; dateTo: string },
): Promise<{ currencyCode: string; total: string }[]> {
  const rows = await database
    .select({
      currencyCode: contributionLines.currencyCode,
      amount: contributionLines.amount,
    })
    .from(contributionLines)
    .innerJoin(
      contributions,
      and(
        eq(contributionLines.zoneId, contributions.zoneId),
        eq(contributionLines.contributionId, contributions.id),
      ),
    )
    .innerJoin(
      familyMembers,
      and(
        eq(familyMembers.zoneId, contributions.zoneId),
        eq(familyMembers.memberId, contributions.memberId),
        sql`${familyMembers.joinedAt} <= ${contributions.contributionDate}`,
        sql`(${familyMembers.leftAt} is null or ${familyMembers.leftAt} > ${contributions.contributionDate})`,
      ),
    )
    .where(
      and(
        eq(contributions.zoneId, zoneId),
        eq(familyMembers.familyId, familyId),
        sql`${contributions.contributionDate} >= ${range.dateFrom}`,
        sql`${contributions.contributionDate} <= ${range.dateTo}`,
        sql`${contributions.status} in ('posted', 'reversed')`,
      ),
    );

  const totals = new Map<string, Decimal>();
  for (const row of rows) {
    const current = totals.get(row.currencyCode) ?? new Decimal(0);
    totals.set(row.currencyCode, current.plus(new Decimal(row.amount)));
  }
  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, total]) => ({ currencyCode, total: total.toFixed(4) }));
}

export interface FamilyListItem extends FamilyRow {
  chapterName: string;
  memberCount: number;
}

/**
 * List families visible to the caller, clamped to a chapter id list when
 * supplied. Returns row + chapter name + open-member count for the
 * register surfaces.
 */
export async function listFamiliesForCaller(
  database: Db,
  args: {
    zoneId: string;
    chapterIds: string[] | "all";
    explicitChapterId?: string;
    q?: string;
    limit: number;
    offset: number;
  },
): Promise<{ rows: FamilyListItem[]; total: number }> {
  const conds = [eq(families.zoneId, args.zoneId), isNull(families.deletedAt)];
  if (args.explicitChapterId) {
    conds.push(eq(families.chapterId, args.explicitChapterId));
  } else if (args.chapterIds !== "all") {
    if (args.chapterIds.length === 0) return { rows: [], total: 0 };
    conds.push(inArray(families.chapterId, args.chapterIds));
  }
  if (args.q && args.q.length > 0) {
    const needle = `%${args.q.toLowerCase()}%`;
    conds.push(sql`(lower(${families.name}) like ${needle} or lower(${families.referenceCode}) like ${needle})`);
  }

  const [{ total }] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(families)
    .where(and(...conds));

  const rowsRaw = await database
    .select({
      family: families,
      chapterName: chapters.name,
      memberCount: sql<number>`(
        select count(*)::int
        from family_members fm
        where fm.zone_id = ${args.zoneId}
          and fm.family_id = ${families.id}
          and fm.left_at is null
      )`,
    })
    .from(families)
    .innerJoin(
      chapters,
      and(eq(chapters.zoneId, families.zoneId), eq(chapters.id, families.chapterId)),
    )
    .where(and(...conds))
    .orderBy(sql`${families.name} asc`)
    .limit(args.limit)
    .offset(args.offset);

  return {
    rows: rowsRaw.map((r) => ({
      ...(r.family as FamilyRow),
      chapterName: r.chapterName,
      memberCount: r.memberCount,
    })),
    total,
  };
}

/**
 * Read a single family row + its open + archived member list.
 */
export async function getFamilyDetail(
  database: Db,
  zoneId: string,
  familyId: string,
): Promise<FamilyDetail | null> {
  const [family] = await database
    .select()
    .from(families)
    .where(and(eq(families.zoneId, zoneId), eq(families.id, familyId), isNull(families.deletedAt)))
    .limit(1);
  if (!family) return null;

  const memberRows = await database
    .select({
      id: familyMembers.id,
      memberId: familyMembers.memberId,
      memberReferenceCode: members.referenceCode,
      memberFullName: members.fullName,
      relationship: familyMembers.relationship,
      isPrimaryContact: familyMembers.isPrimaryContact,
      joinedAt: familyMembers.joinedAt,
      leftAt: familyMembers.leftAt,
    })
    .from(familyMembers)
    .innerJoin(
      members,
      and(eq(members.zoneId, familyMembers.zoneId), eq(members.id, familyMembers.memberId)),
    )
    .where(
      and(eq(familyMembers.zoneId, zoneId), eq(familyMembers.familyId, familyId)),
    )
    .orderBy(sql`${familyMembers.isPrimaryContact} desc, ${members.fullName} asc`);

  return {
    ...(family as FamilyRow),
    members: memberRows.map((row) => ({
      id: row.id,
      memberId: row.memberId,
      memberReferenceCode: row.memberReferenceCode,
      memberFullName: row.memberFullName ?? null,
      relationship: row.relationship,
      isPrimaryContact: row.isPrimaryContact,
      joinedAt: row.joinedAt as unknown as string,
      leftAt: (row.leftAt as unknown as string | null) ?? null,
    })),
  };
}

/** Convenience used by the chapter-clamp gate in tenant-families. */
export async function getFamilyChapterId(
  database: Db,
  zoneId: string,
  familyId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ chapterId: families.chapterId })
    .from(families)
    .where(and(eq(families.zoneId, zoneId), eq(families.id, familyId), isNull(families.deletedAt)))
    .limit(1);
  return row?.chapterId ?? null;
}

// Re-export the AuthorizedContext type so route files can stay tight.
export type { AuthorizedContext };
