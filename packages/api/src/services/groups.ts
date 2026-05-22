// packages/api/src/services/groups.ts
// Group-layer invariants: name/slug uniqueness, pre-enable assignment,
// post-enable point-in-time move, one-way enable toggle, soft-delete gate.
// RELEVANT FILES: ./audit.ts, packages/db/src/schema/groups.ts, packages/db/src/schema/chapters.ts

import {
  chapterGroupHistory,
  chapters,
  groups,
  zones,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { writeAudit } from "./audit";

export class GroupNotFoundError extends Error {
  readonly code = "group_not_found";
  constructor(msg = "Group not found.") {
    super(msg);
  }
}

export class ChapterNotFoundError extends Error {
  readonly code = "chapter_not_found";
  constructor(msg = "Chapter not found.") {
    super(msg);
  }
}

export class GroupNameTakenError extends Error {
  readonly code = "group_name_taken";
  constructor(name: string) {
    super(`A group named "${name}" already exists in this zone.`);
  }
}

export class GroupSlugTakenError extends Error {
  readonly code = "group_slug_taken";
  constructor(slug: string) {
    super(`A group with slug "${slug}" already exists in this zone.`);
  }
}

export class GroupsNotEnabledError extends Error {
  readonly code = "groups_not_enabled";
  constructor(msg = "Groups are not enabled for this zone (or are already enabled).") {
    super(msg);
  }
}

export class GroupsEnableBlockedError extends Error {
  readonly code = "groups_enable_blocked";
  constructor(public readonly unassignedChapterIds: string[]) {
    super(`Cannot enable groups: ${unassignedChapterIds.length} chapter(s) are not assigned to a group.`);
  }
}

export class GroupNotEmptyError extends Error {
  readonly code = "group_not_empty";
  constructor(public readonly chapterCount: number) {
    super(`Cannot delete group: ${chapterCount} chapter(s) still belong to it.`);
  }
}

export class HistoryViolationError extends Error {
  readonly code = "history_violation";
  constructor(msg: string) {
    super(msg);
  }
}

export async function assertGroupNameAvailable(
  database: Db,
  zoneId: string,
  name: string,
  options: { excludeGroupId?: string } = {},
): Promise<void> {
  const lower = name.trim().toLowerCase();
  const rows = await database
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        eq(groups.zoneId, zoneId),
        isNull(groups.deletedAt),
        sql`lower(${groups.name}) = ${lower}`,
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (hit && hit.id !== options.excludeGroupId) {
    throw new GroupNameTakenError(name);
  }
}

export async function assertGroupSlugAvailable(
  database: Db,
  zoneId: string,
  slug: string,
  options: { excludeGroupId?: string } = {},
): Promise<void> {
  const rows = await database
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        eq(groups.zoneId, zoneId),
        isNull(groups.deletedAt),
        eq(groups.slug, slug),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (hit && hit.id !== options.excludeGroupId) {
    throw new GroupSlugTakenError(slug);
  }
}

/** Pre-enable: just sets `chapters.group_id`. No history row. Refuses post-enable. */
export async function assignChapterToGroupPreEnable(
  database: Db,
  args: { zoneId: string; chapterId: string; groupId: string; actorUserId: string | null },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.zoneId}, 0))`,
    );
    const [zone] = await tx
      .select({ groupsEnabled: zones.groupsEnabled })
      .from(zones)
      .where(eq(zones.id, args.zoneId))
      .limit(1);
    if (!zone) throw new GroupsNotEnabledError("Zone not found.");
    if (zone.groupsEnabled) throw new GroupsNotEnabledError("Use moveChapterToGroup once groups are enabled.");

    const [grp] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, args.groupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .limit(1);
    if (!grp) throw new GroupNotFoundError();

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.groupId}, 0))`,
    );
    const [grp2] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, args.groupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .limit(1);
    if (!grp2) throw new GroupNotFoundError();

    const result = await tx
      .update(chapters)
      .set({ groupId: args.groupId, updatedAt: new Date() })
      .where(and(eq(chapters.id, args.chapterId), eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt)))
      .returning({ id: chapters.id });
    if (result.length === 0) throw new ChapterNotFoundError();

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "chapter.group.assign",
      entityType: "chapter",
      entityId: args.chapterId,
      after: { groupId: args.groupId },
    });
  });
}

/** Post-enable: closes the open history segment, opens a new one. */
export async function moveChapterToGroup(
  database: Db,
  args: { zoneId: string; chapterId: string; newGroupId: string; effectiveDate: string; actorUserId: string | null },
): Promise<{ changed: boolean }> {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.zoneId}, 0))`,
    );
    const [zone] = await tx
      .select({ groupsEnabled: zones.groupsEnabled, tz: zones.defaultTimeZone })
      .from(zones)
      .where(eq(zones.id, args.zoneId))
      .limit(1);
    if (!zone) throw new GroupsNotEnabledError("Zone not found.");
    if (!zone.groupsEnabled) throw new GroupsNotEnabledError();

    // Serialize concurrent moves for the same chapter. The advisory key is
    // derived from the chapter UUID so different chapters never block each
    // other. Released automatically at transaction end.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.chapterId}, 0))`,
    );

    const [chap] = await tx
      .select({ groupId: chapters.groupId })
      .from(chapters)
      .where(and(eq(chapters.id, args.chapterId), eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt)))
      .limit(1);
    if (!chap) throw new ChapterNotFoundError();

    if (chap.groupId === args.newGroupId) return { changed: false };

    const [grp] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, args.newGroupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .limit(1);
    if (!grp) throw new GroupNotFoundError("Target group not found.");

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.newGroupId}, 0))`,
    );
    const [g2] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, args.newGroupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .limit(1);
    if (!g2) throw new GroupNotFoundError("Target group not found.");

    const [openSeg] = await tx
      .select({ id: chapterGroupHistory.id, dateFrom: chapterGroupHistory.dateFrom })
      .from(chapterGroupHistory)
      .where(and(
        eq(chapterGroupHistory.zoneId, args.zoneId),
        eq(chapterGroupHistory.chapterId, args.chapterId),
        isNull(chapterGroupHistory.dateTo),
      ))
      .limit(1);
    if (!openSeg) throw new HistoryViolationError("No open history segment found");
    if (args.effectiveDate <= openSeg.dateFrom) {
      throw new HistoryViolationError(
        `effectiveDate ${args.effectiveDate} must be after current segment date_from ${openSeg.dateFrom}`,
      );
    }

    await tx
      .update(chapterGroupHistory)
      .set({ dateTo: sql`(${args.effectiveDate}::date - INTERVAL '1 day')::date` })
      .where(and(
        eq(chapterGroupHistory.id, openSeg.id),
        eq(chapterGroupHistory.zoneId, args.zoneId),
      ));

    await tx.insert(chapterGroupHistory).values({
      zoneId: args.zoneId,
      chapterId: args.chapterId,
      groupId: args.newGroupId,
      dateFrom: args.effectiveDate,
    });

    await tx
      .update(chapters)
      .set({ groupId: args.newGroupId, updatedAt: new Date() })
      .where(and(eq(chapters.id, args.chapterId), eq(chapters.zoneId, args.zoneId)));

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "chapter.group.move",
      entityType: "chapter",
      entityId: args.chapterId,
      before: { groupId: chap.groupId },
      after: { groupId: args.newGroupId, effectiveDate: args.effectiveDate },
    });

    return { changed: true };
  });
}

/** Flip groups_enabled true; open initial history segments. Idempotent. */
export async function enableGroupsForZone(
  database: Db,
  args: { zoneId: string; actorUserId: string | null },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.zoneId}, 0))`,
    );
    const [zone] = await tx
      .select({ groupsEnabled: zones.groupsEnabled })
      .from(zones)
      .where(eq(zones.id, args.zoneId))
      .limit(1);
    if (!zone) throw new Error("Zone not found");
    if (zone.groupsEnabled) return;

    const unassigned = await tx
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt), isNull(chapters.groupId)));
    if (unassigned.length > 0) {
      throw new GroupsEnableBlockedError(unassigned.map((r) => r.id));
    }

    const assigned = await tx
      .select({ id: chapters.id, groupId: chapters.groupId, dateFrom: chapters.dateFrom })
      .from(chapters)
      .where(and(eq(chapters.zoneId, args.zoneId), isNull(chapters.deletedAt)));

    if (assigned.length > 0) {
      await tx.insert(chapterGroupHistory).values(
        assigned.map((c) => ({
          zoneId: args.zoneId,
          chapterId: c.id,
          groupId: c.groupId as string,
          dateFrom: c.dateFrom,
        })),
      );
    }

    await tx
      .update(zones)
      .set({ groupsEnabled: true, updatedAt: new Date() })
      .where(eq(zones.id, args.zoneId));

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "zone.groups.enable",
      entityType: "zone",
      entityId: args.zoneId,
    });
  });
}

/** Soft-delete a group. Refuses if any active chapter still belongs to it. */
export async function softDeleteGroup(
  database: Db,
  args: { zoneId: string; groupId: string; actorUserId: string | null },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.zoneId}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${args.groupId}, 0))`,
    );
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(chapters)
      .where(and(
        eq(chapters.zoneId, args.zoneId),
        eq(chapters.groupId, args.groupId),
        isNull(chapters.deletedAt),
      ));
    if (count > 0) throw new GroupNotEmptyError(count);

    const [updated] = await tx
      .update(groups)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(groups.id, args.groupId), eq(groups.zoneId, args.zoneId), isNull(groups.deletedAt)))
      .returning({ id: groups.id });
    if (!updated) throw new GroupNotFoundError();

    await writeAudit(tx, {
      zoneId: args.zoneId,
      actorUserId: args.actorUserId,
      action: "group.delete",
      entityType: "group",
      entityId: args.groupId,
    });
  });
}
