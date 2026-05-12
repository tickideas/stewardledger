// packages/api/src/routes/admin.ts
// Platform-admin API. Mounted on the API host (apex / api subdomain).
// Guarded by requireSession + requirePlatformRole. Cross-zone reads are allowed
// here and ONLY here. Every write is audited.

import { zValidator } from "@hono/zod-validator";
import {
  PLATFORM_ROLES,
  regionCreateSchema,
  regionPromoteSchema,
  regionUpdateSchema,
} from "@stewardledger/shared";
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql, sum } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  chapters,
  contributions,
  members,
  regions,
  zones,
} from "@stewardledger/db/schema";
import { db } from "../db";
import { log } from "../logger";
import {
  requirePlatformRole,
  requireSession,
  type SessionUser,
} from "../middleware/auth";
import { writeAudit } from "../services/audit";
import { assertNameAvailable, NameTakenError } from "../services/names";

export const adminRouter = new Hono();

adminRouter.use(
  "*",
  requireSession,
  requirePlatformRole(PLATFORM_ROLES.SUPER_ADMIN, PLATFORM_ROLES.REGION_CURATOR),
);

/**
 * Inline check: cross-tenant endpoints admit super-admin only. Region-
 * curator access is in-scope for a follow-up; for now they get a 403 here
 * even though `requirePlatformRole` lets them through the router. Returns
 * a Response (the 403) when the user fails the gate, null when they pass.
 */
function superAdminGate(c: Context): Response | null {
  const user = c.get("user") as SessionUser;
  if (!user.isSuperAdmin) {
    return c.json({ error: { code: "forbidden", message: "Super-admin required" } }, 403);
  }
  return null;
}

function logAdminAccess(c: Context, event: string, extra: Record<string, unknown> = {}): void {
  const user = c.get("user") as SessionUser;
  log.info(
    {
      event,
      userId: user.id,
      userEmail: user.email,
      requestId: c.req.header("x-request-id") ?? null,
      ...extra,
    },
    "admin access",
  );
}

// ─── Zones (tenants) ─────────────────────────────────────────────────

// Pagination cap is intentionally low; this is an interactive dashboard, not
// a bulk export. Bulk operations should hit a dedicated endpoint with cursor
// + streaming.
const ZONES_DEFAULT_LIMIT = 50;
const ZONES_MAX_LIMIT = 100;

const zonesListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(ZONES_MAX_LIMIT).default(ZONES_DEFAULT_LIMIT),
  // Keyset cursor: `${createdAtIso}_${zoneId}` from the last row of the
  // previous page. Composite ordering prevents skips when multiple zones
  // share an identical createdAt timestamp.
  cursor: z.string().trim().max(200).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

type ZonesCursor = { createdAt: Date; id: string };

function encodeZonesCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}_${row.id}`;
}

function parseZonesCursor(cursor: string): ZonesCursor | null {
  const separator = cursor.lastIndexOf("_");
  if (separator === -1) return null;
  const createdAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

/**
 * Cross-tenant zones list with denormalized counts. Read-only — every write
 * still flows through the normal tenant-scoped endpoints so audits stay
 * per-zone. Super-admin only (region-curators are admitted by middleware but
 * gated here pending region-scoped filtering).
 *
 * Query params: ?limit=&cursor=&q=
 *   limit: 1..100 (default 50)
 *   cursor: `${createdAtIso}_${zoneId}` from the previous page's last row
 *   q: case-insensitive match against name / slug / regionNameUnverified
 */
adminRouter.get(
  "/zones",
  zValidator("query", zonesListQuerySchema),
  async (c) => {
    const denied = superAdminGate(c);
    if (denied) return denied;
    const { limit, cursor, q } = c.req.valid("query");
    logAdminAccess(c, "admin.zones.list", { limit, hasCursor: !!cursor, hasQuery: !!q });

    const whereClauses = [isNull(zones.deletedAt)];
    if (cursor) {
      const parsed = parseZonesCursor(cursor);
      if (!parsed) {
        return c.json({ error: { code: "invalid_cursor", message: "Invalid cursor" } }, 400);
      }
      const cursorClause = or(
        lt(zones.createdAt, parsed.createdAt),
        and(eq(zones.createdAt, parsed.createdAt), lt(zones.id, parsed.id)),
      );
      if (cursorClause) whereClauses.push(cursorClause);
    }
    if (q) {
      const like = `%${q}%`;
      const qClause = or(
        ilike(zones.name, like),
        ilike(zones.slug, like),
        ilike(zones.regionNameUnverified, like),
      );
      if (qClause) whereClauses.push(qClause);
    }

    // Fetch one extra row so we can tell the client whether more exist
    // without a second count() round-trip.
    const zoneRows = await db
      .select({
        id: zones.id,
        slug: zones.slug,
        name: zones.name,
        status: zones.status,
        countryCode: zones.countryCode,
        defaultCurrencyCode: zones.defaultCurrencyCode,
        regionId: zones.regionId,
        regionName: regions.name,
        regionNameUnverified: zones.regionNameUnverified,
        activatedAt: zones.activatedAt,
        createdAt: zones.createdAt,
      })
      .from(zones)
      .leftJoin(regions, eq(regions.id, zones.regionId))
      .where(and(...whereClauses))
      .orderBy(desc(zones.createdAt), desc(zones.id))
      .limit(limit + 1);

    const hasMore = zoneRows.length > limit;
    const page = hasMore ? zoneRows.slice(0, limit) : zoneRows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeZonesCursor(last) : null;

    if (page.length === 0) return c.json({ items: [], nextCursor: null });
    const zoneIds = page.map((z) => z.id);

    // Three independent grouped queries — fire in parallel. Cheaper than
    // correlated subqueries and avoids the N+1 trap.
    const [chapterCounts, memberCounts, contributionTotals] = await Promise.all([
      db
        .select({ zoneId: chapters.zoneId, n: count(chapters.id) })
        .from(chapters)
        .where(and(inArray(chapters.zoneId, zoneIds), isNull(chapters.deletedAt)))
        .groupBy(chapters.zoneId),
      db
        .select({ zoneId: members.zoneId, n: count(members.id) })
        .from(members)
        .where(and(inArray(members.zoneId, zoneIds), isNull(members.deletedAt)))
        .groupBy(members.zoneId),
      // Group by (zone, currency). A zone is allowed to hold contributions
      // in multiple currencies (members in different countries, FX gifts,
      // etc.) so summing across currencies would produce a nonsense total.
      // We expose per-currency subtotals; the client picks the right one
      // to display (typically zone.defaultCurrencyCode).
      db
        .select({
          zoneId: contributions.zoneId,
          currencyCode: contributions.currencyCode,
          total: sum(contributions.totalAmount),
          n: count(contributions.id),
        })
        .from(contributions)
        .where(and(inArray(contributions.zoneId, zoneIds), eq(contributions.status, "posted")))
        .groupBy(contributions.zoneId, contributions.currencyCode),
    ]);

    const chapterByZone = new Map(chapterCounts.map((r) => [r.zoneId, Number(r.n)]));
    const memberByZone = new Map(memberCounts.map((r) => [r.zoneId, Number(r.n)]));

    type Subtotal = { currencyCode: string; total: string; count: number };
    const subtotalsByZone = new Map<string, Subtotal[]>();
    for (const r of contributionTotals) {
      const list = subtotalsByZone.get(r.zoneId) ?? [];
      list.push({
        currencyCode: r.currencyCode,
        total: r.total ?? "0.0000",
        count: Number(r.n),
      });
      subtotalsByZone.set(r.zoneId, list);
    }

    const items = page.map((z) => {
      const subtotals = subtotalsByZone.get(z.id) ?? [];
      // Convenience: pick the subtotal in the zone's default currency for
      // the list view's single-currency cell. Clients that need every
      // currency render `postedContributionSubtotals`.
      const primary =
        subtotals.find((s) => s.currencyCode === z.defaultCurrencyCode) ?? subtotals[0];
      const totalCount = subtotals.reduce((acc, s) => acc + s.count, 0);
      return {
        ...z,
        chapterCount: chapterByZone.get(z.id) ?? 0,
        memberCount: memberByZone.get(z.id) ?? 0,
        // `postedContributionTotal` keeps the existing single-number client
        // contract: prefer the zone default-currency subtotal when present,
        // otherwise expose the first available currency subtotal. Clients
        // that need every currency should use `postedContributionSubtotals`.
        postedContributionTotal: primary?.total ?? "0.0000",
        postedContributionCurrency: primary?.currencyCode ?? z.defaultCurrencyCode,
        postedContributionCount: totalCount,
        // Full per-currency breakdown for clients that care.
        postedContributionSubtotals: subtotals,
      };
    });
    return c.json({ items, nextCursor });
  },
);

/** Zone detail: zone row + chapters + members snapshot. */
adminRouter.get("/zones/:slug", async (c) => {
  const denied = superAdminGate(c);
  if (denied) return denied;
  const slug = c.req.param("slug");
  logAdminAccess(c, "admin.zones.detail", { zoneSlug: slug });

  const [zone] = await db
    .select({
      id: zones.id,
      slug: zones.slug,
      name: zones.name,
      legalName: zones.legalName,
      status: zones.status,
      countryCode: zones.countryCode,
      defaultCurrencyCode: zones.defaultCurrencyCode,
      defaultTimeZone: zones.defaultTimeZone,
      fiscalYearStartMonth: zones.fiscalYearStartMonth,
      ministryYearStartMonth: zones.ministryYearStartMonth,
      regionId: zones.regionId,
      regionName: regions.name,
      regionNameUnverified: zones.regionNameUnverified,
      activatedAt: zones.activatedAt,
      createdAt: zones.createdAt,
    })
    .from(zones)
    .leftJoin(regions, eq(regions.id, zones.regionId))
    .where(and(eq(zones.slug, slug), isNull(zones.deletedAt)))
    .limit(1);

  if (!zone) {
    return c.json({ error: { code: "not_found", message: "Zone not found" } }, 404);
  }

  const [chapterRows, memberCountsByChapter, contributionAggRows] = await Promise.all([
    db
      .select({
        id: chapters.id,
        referenceCode: chapters.referenceCode,
        name: chapters.name,
        countryCode: chapters.countryCode,
        dateFrom: chapters.dateFrom,
        dateTo: chapters.dateTo,
        createdAt: chapters.createdAt,
      })
      .from(chapters)
      .where(and(eq(chapters.zoneId, zone.id), isNull(chapters.deletedAt)))
      .orderBy(asc(chapters.name)),
    db
      .select({ chapterId: members.chapterId, n: count(members.id) })
      .from(members)
      .where(and(eq(members.zoneId, zone.id), isNull(members.deletedAt)))
      .groupBy(members.chapterId),
    // Group by currency so a zone with mixed-currency contributions doesn't
    // get a meaningless total like USD + GBP. See list endpoint for context.
    db
      .select({
        currencyCode: contributions.currencyCode,
        total: sum(contributions.totalAmount),
        n: count(contributions.id),
      })
      .from(contributions)
      .where(and(eq(contributions.zoneId, zone.id), eq(contributions.status, "posted")))
      .groupBy(contributions.currencyCode),
  ]);

  // Use a typed Map<string | null> so unassigned-member rows are explicit
  // rather than coerced through the empty-string sentinel.
  const byChapter = new Map<string | null, number>(
    memberCountsByChapter.map((r) => [r.chapterId, Number(r.n)]),
  );

  const chaptersWithCounts = chapterRows.map((ch) => ({
    ...ch,
    memberCount: byChapter.get(ch.id) ?? 0,
  }));
  const unassignedMembers = byChapter.get(null) ?? 0;

  const subtotals = contributionAggRows.map((r) => ({
    currencyCode: r.currencyCode,
    total: r.total ?? "0.0000",
    count: Number(r.n),
  }));
  const primary =
    subtotals.find((s) => s.currencyCode === zone.defaultCurrencyCode) ?? subtotals[0];
  const totalContributionCount = subtotals.reduce((acc, s) => acc + s.count, 0);

  return c.json({
    zone,
    chapters: chaptersWithCounts,
    totals: {
      members:
        chaptersWithCounts.reduce((acc, ch) => acc + ch.memberCount, 0) + unassignedMembers,
      unassignedMembers,
      postedContributionTotal: primary?.total ?? "0.0000",
      postedContributionCurrency: primary?.currencyCode ?? zone.defaultCurrencyCode,
      postedContributionCount: totalContributionCount,
      postedContributionSubtotals: subtotals,
    },
  });
});

// ─── Regions CRUD ─────────────────────────────────────────────────────

adminRouter.get("/regions", async (c) => {
  const rows = await db
    .select({
      id: regions.id,
      name: regions.name,
      shortCode: regions.shortCode,
      countryCode: regions.countryCode,
      isActive: regions.isActive,
      createdAt: regions.createdAt,
    })
    .from(regions)
    .orderBy(asc(regions.name));
  return c.json({ items: rows });
});

adminRouter.post("/regions", zValidator("json", regionCreateSchema), async (c) => {
  const user = c.get("user") as SessionUser;
  const input = c.req.valid("json");
  try {
    await assertNameAvailable(db, input.name);
  } catch (err) {
    if (err instanceof NameTakenError)
      return c.json({ error: { code: err.code, message: err.message } }, 409);
    throw err;
  }
  const [row] = await db
    .insert(regions)
    .values({
      name: input.name,
      shortCode: input.shortCode ?? null,
      countryCode: input.countryCode ?? null,
      createdByUserId: user.id,
    })
    .returning();
  return c.json({ region: row }, 201);
});

adminRouter.patch("/regions/:id", zValidator("json", regionUpdateSchema), async (c) => {
  const id = c.req.param("id");
  const input = c.req.valid("json");
  if (input.name) {
    try {
      await assertNameAvailable(db, input.name, { ignoreRegionId: id });
    } catch (err) {
      if (err instanceof NameTakenError)
        return c.json({ error: { code: err.code, message: err.message } }, 409);
      throw err;
    }
  }
  const [row] = await db
    .update(regions)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.shortCode !== undefined && { shortCode: input.shortCode }),
      ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(regions.id, id))
    .returning();
  if (!row) return c.json({ error: { code: "not_found", message: "Region not found" } }, 404);
  return c.json({ region: row });
});

// ─── Unverified-region inbox ──────────────────────────────────────────

/** Zones whose region is still a free-text submission awaiting curation. */
adminRouter.get("/regions/inbox", async (c) => {
  const rows = await db
    .select({
      zoneId: zones.id,
      zoneSlug: zones.slug,
      zoneName: zones.name,
      countryCode: zones.countryCode,
      regionNameUnverified: zones.regionNameUnverified,
      createdAt: zones.createdAt,
    })
    .from(zones)
    .where(and(isNull(zones.regionId), sql`${zones.regionNameUnverified} is not null`))
    .orderBy(desc(zones.createdAt));
  return c.json({ items: rows });
});

/**
 * Promote a free-text region into the curated `regions` table and re-target
 * one or more zones onto it. Either pass `regionId` (existing region) or
 * `regionDraft` (creates a new region in the same transaction).
 *
 * On success: updates each target zone's region_id, clears
 * region_name_unverified, fans out the denormalized region_id onto every
 * chapter row in those zones, and emits one audit event per zone.
 */
adminRouter.post("/regions/promote", zValidator("json", regionPromoteSchema), async (c) => {
  const user = c.get("user") as SessionUser;
  const input = c.req.valid("json");

  const result = await db.transaction(async (tx) => {
    let regionId: string;
    if (input.regionId) {
      const [region] = await tx
        .select({ id: regions.id, isActive: regions.isActive })
        .from(regions)
        .where(eq(regions.id, input.regionId))
        .limit(1);
      if (!region || !region.isActive) {
        throw new PromoteError("region_not_found", "Region not found or inactive.");
      }
      regionId = region.id;
    } else if (input.regionDraft) {
      try {
        await assertNameAvailable(tx, input.regionDraft.name);
      } catch (err) {
        if (err instanceof NameTakenError) throw new PromoteError(err.code, err.message);
        throw err;
      }
      const [created] = await tx
        .insert(regions)
        .values({
          name: input.regionDraft.name,
          shortCode: input.regionDraft.shortCode ?? null,
          countryCode: input.regionDraft.countryCode ?? null,
          createdByUserId: user.id,
        })
        .returning({ id: regions.id });
      regionId = created.id;
    } else {
      throw new PromoteError("invalid_input", "regionId or regionDraft is required.");
    }

    // Lock + load target zones; ensure they're all currently in the inbox.
    const targets = await tx
      .select({
        id: zones.id,
        regionNameUnverified: zones.regionNameUnverified,
        regionId: zones.regionId,
      })
      .from(zones)
      .where(inArray(zones.id, input.zoneIds));

    if (targets.length !== input.zoneIds.length) {
      throw new PromoteError("zone_not_found", "One or more zones do not exist.");
    }
    for (const z of targets) {
      if (z.regionId !== null || z.regionNameUnverified === null) {
        throw new PromoteError(
          "zone_not_unverified",
          `Zone ${z.id} is not awaiting region curation.`,
        );
      }
    }

    await tx
      .update(zones)
      .set({ regionId, regionNameUnverified: null, updatedAt: new Date() })
      .where(inArray(zones.id, input.zoneIds));

    // Fan out denormalized region_id to chapters.
    await tx
      .update(chapters)
      .set({ regionId, updatedAt: new Date() })
      .where(inArray(chapters.zoneId, input.zoneIds));

    for (const zoneId of input.zoneIds) {
      await writeAudit(tx, {
        zoneId,
        actorUserId: user.id,
        actorRoleCode: PLATFORM_ROLES.REGION_CURATOR,
        action: "region.promote",
        entityType: "zone",
        entityId: zoneId,
        after: { regionId },
      });
    }

    return { regionId, zoneIds: input.zoneIds };
  }).catch((err) => {
    if (err instanceof PromoteError) return err;
    throw err;
  });

  if (result instanceof PromoteError) {
    return c.json({ error: { code: result.code, message: result.message } }, 409);
  }
  return c.json({ status: "promoted", regionId: result.regionId, zoneIds: result.zoneIds });
});

class PromoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
