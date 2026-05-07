// packages/api/src/services/members.ts
// Member service helpers: address normalisation + merge-proposal apply.
// Member CRUD itself is small enough to live inline in routes/tenant.ts.

import { and, eq, sql } from "drizzle-orm";
import {
  memberAddresses,
  memberMergeProposals,
  members,
} from "@stewardledger/db/schema";
import type { Database, Db } from "@stewardledger/db";
import { writeAudit } from "./audit";

export class MemberError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * When marking an address as primary, demote every other primary address for
 * the same member. Run inside the same transaction as the insert/update.
 */
export async function clearOtherPrimaryAddresses(
  tx: Db,
  args: { memberId: string; exceptAddressId?: string | null },
): Promise<void> {
  const conditions = args.exceptAddressId
    ? sql`${memberAddresses.memberId} = ${args.memberId}
        and ${memberAddresses.id} <> ${args.exceptAddressId}
        and ${memberAddresses.isPrimary} = true
        and ${memberAddresses.dateTo} is null`
    : sql`${memberAddresses.memberId} = ${args.memberId}
        and ${memberAddresses.isPrimary} = true
        and ${memberAddresses.dateTo} is null`;
  await tx.update(memberAddresses).set({ isPrimary: false }).where(conditions);
}

/**
 * Apply a merge proposal: rewrite every reference to the duplicate member to
 * the primary, soft-delete the duplicate, mark the proposal applied, and
 * audit each step. Returns the updated proposal id.
 *
 * Phase 3 only knows about `members` and `member_addresses` — later phases
 * (contributions, imports, targets) must extend this function as those tables
 * land. Each new reference must be added here BEFORE the duplicate is deleted.
 */
export async function applyMergeProposal(
  database: Database,
  args: { proposalId: string; zoneId: string; reviewedByUserId: string },
): Promise<{ id: string; primaryMemberId: string; duplicateMemberId: string }> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${args.proposalId}))`);

    const [proposal] = await tx
      .select({
        id: memberMergeProposals.id,
        zoneId: memberMergeProposals.zoneId,
        primaryMemberId: memberMergeProposals.primaryMemberId,
        duplicateMemberId: memberMergeProposals.duplicateMemberId,
        status: memberMergeProposals.status,
      })
      .from(memberMergeProposals)
      .where(
        and(
          eq(memberMergeProposals.id, args.proposalId),
          eq(memberMergeProposals.zoneId, args.zoneId),
        ),
      )
      .limit(1);
    if (!proposal) {
      throw new MemberError("proposal_not_found", "Merge proposal not found in this zone.");
    }
    if (proposal.status === "applied") {
      throw new MemberError("proposal_already_applied", "Proposal already applied.");
    }
    if (proposal.status === "rejected") {
      throw new MemberError("proposal_rejected", "Proposal was rejected.");
    }

    // Both members must still exist in this zone and not be soft-deleted.
    const sides = await tx
      .select({
        id: members.id,
        deletedAt: members.deletedAt,
      })
      .from(members)
      .where(
        and(
          eq(members.zoneId, args.zoneId),
          sql`${members.id} in (${proposal.primaryMemberId}, ${proposal.duplicateMemberId})`,
        ),
      );
    if (sides.length !== 2) {
      throw new MemberError("members_missing", "Both members must exist in this zone.");
    }
    if (sides.some((m) => m.deletedAt !== null)) {
      throw new MemberError("member_deleted", "Cannot merge a deleted member.");
    }

    // Resolve active-primary-address collisions before reassignment. If both
    // members have an active primary address, updating the duplicate rows to
    // the primary member first would violate the partial unique index.
    const allPrimary = await tx
      .select({ id: memberAddresses.id, createdAt: memberAddresses.createdAt })
      .from(memberAddresses)
      .where(
        and(
          eq(memberAddresses.zoneId, args.zoneId),
          sql`${memberAddresses.memberId} in (${proposal.primaryMemberId}, ${proposal.duplicateMemberId})`,
          eq(memberAddresses.isPrimary, true),
          sql`${memberAddresses.dateTo} is null`,
        ),
      );
    if (allPrimary.length > 1) {
      const sorted = [...allPrimary].sort((a, b) => +b.createdAt - +a.createdAt);
      const keepId = sorted[0].id;
      await tx
        .update(memberAddresses)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(memberAddresses.zoneId, args.zoneId),
            sql`${memberAddresses.memberId} in (${proposal.primaryMemberId}, ${proposal.duplicateMemberId})`,
            sql`${memberAddresses.id} <> ${keepId}`,
            eq(memberAddresses.isPrimary, true),
            sql`${memberAddresses.dateTo} is null`,
          ),
        );
    }

    const reassignedAddresses = await tx
      .select({ id: memberAddresses.id })
      .from(memberAddresses)
      .where(
        and(
          eq(memberAddresses.zoneId, args.zoneId),
          eq(memberAddresses.memberId, proposal.duplicateMemberId),
        ),
      );

    // Reassign every member_addresses row.
    await tx
      .update(memberAddresses)
      .set({ memberId: proposal.primaryMemberId, updatedAt: new Date() })
      .where(
        and(
          eq(memberAddresses.zoneId, args.zoneId),
          eq(memberAddresses.memberId, proposal.duplicateMemberId),
        ),
      );

    for (const address of reassignedAddresses) {
      await writeAudit(tx, {
        zoneId: args.zoneId,
        actorUserId: args.reviewedByUserId,
        action: "member.address.reassign",
        entityType: "member_address",
        entityId: address.id,
        before: { memberId: proposal.duplicateMemberId },
        after: { memberId: proposal.primaryMemberId, proposalId: proposal.id },
      });
    }

    // Soft-delete the duplicate. Hard-delete is forbidden by AGENTS for members.
    await tx
      .update(members)
      .set({
        deletedAt: new Date(),
        isActive: false,
        updatedByUserId: args.reviewedByUserId,
        updatedAt: new Date(),
      })
      .where(
        and(eq(members.zoneId, args.zoneId), eq(members.id, proposal.duplicateMemberId)),
      );

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.reviewedByUserId,
      action: "member.merge.absorb",
      entityType: "member",
      entityId: proposal.duplicateMemberId,
      before: { deletedAt: null, isActive: true },
      after: { deletedAt: "set", isActive: false, proposalId: proposal.id },
    });

    await tx
      .update(memberMergeProposals)
      .set({
        status: "applied",
        appliedAt: new Date(),
        reviewedByUserId: args.reviewedByUserId,
        reviewedAt: new Date(),
      })
      .where(eq(memberMergeProposals.id, proposal.id));

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.reviewedByUserId,
      action: "member.merge.apply",
      entityType: "member",
      entityId: proposal.primaryMemberId,
      after: {
        proposalId: proposal.id,
        absorbedMemberId: proposal.duplicateMemberId,
      },
    });

    return {
      id: proposal.id,
      primaryMemberId: proposal.primaryMemberId,
      duplicateMemberId: proposal.duplicateMemberId,
    };
  });
}
