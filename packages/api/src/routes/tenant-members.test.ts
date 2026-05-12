// packages/api/src/routes/tenant-members.test.ts
// Cross-tenant fuzz tests for the Phase 3 member routes. Mirrors the shape of
// tenant.test.ts: stand up two zones, drive the Hono app via app.fetch with a
// faked Better Auth session, and assert that user-A bound to zone-A cannot
// read or mutate zone-B's members, addresses, lookups, or merge proposals.

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  auditEvents,
  chapters,
  maritalStatuses,
  memberAddresses,
  memberMergeProposals,
  memberTypes,
  members,
  titles,
  user as userTable,
  userRoleBindings,
  zones,
} from "@stewardledger/db/schema";
import { createApp } from "../app";
import { auth } from "../auth";
import { db } from "../db";
import { seedZoneLookups } from "../services/lookup-seed";
import { seedZoneRoles } from "../services/role-seed";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

const HOST_DOMAIN = "localhost";

interface SeededZone {
  id: string;
  slug: string;
  name: string;
  ownerRoleId: string;
  chapterAdminRoleId: string;
}

async function seedZone(slug: string, name: string): Promise<SeededZone> {
  const [zone] = await db
    .insert(zones)
    .values({
      slug,
      name,
      countryCode: "GB",
      defaultCurrencyCode: "GBP",
      defaultTimeZone: "Europe/London",
      regionNameUnverified: `Region ${unique()}`,
      status: "active",
    })
    .returning({ id: zones.id, slug: zones.slug, name: zones.name });
  const roleMap = await seedZoneRoles(db, zone.id);
  await seedZoneLookups(db, zone.id);
  return {
    id: zone.id,
    slug: zone.slug,
    name: zone.name,
    ownerRoleId: roleMap.get(ZONE_ROLES.ZONE_OWNER)!,
    chapterAdminRoleId: roleMap.get(CHAPTER_ROLES.CHAPTER_ADMIN)!,
  };
}

async function seedUser(email: string): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({ id, email, emailVerified: true });
  return id;
}

async function seedChapter(zoneId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  return row.id;
}

async function seedMember(zoneId: string, firstName: string, chapterId?: string): Promise<string> {
  const [row] = await db
    .insert(members)
    .values({
      zoneId,
      chapterId: chapterId ?? null,
      referenceCode: `M-${unique()}`,
      firstName,
      lastName: "Test",
    })
    .returning({ id: members.id });
  return row.id;
}

function fakeSession(userId: string, email: string) {
  return {
    user: { id: userId, email },
    session: { id: `s-${userId}` },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

const app = createApp();

interface FetchOptions {
  method?: string;
  body?: unknown;
}

async function call(slug: string, path: string, opts: FetchOptions = {}): Promise<Response> {
  return app.fetch(
    new Request(`http://${slug}.${HOST_DOMAIN}${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body
        ? { "content-type": "application/json", host: `${slug}.${HOST_DOMAIN}` }
        : { host: `${slug}.${HOST_DOMAIN}` },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

describe("tenant member routes — cross-tenant fuzz", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let userA: string;
  let userBOwner: string;
  let userChapterA: string;
  let chapterA: string;
  let chapterAOther: string;
  let chapterB: string;
  let memberA: string;
  let memberAOther: string;
  let memberB: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    zoneA = await seedZone(`a-${unique()}`, `Zone A ${unique()}`);
    zoneB = await seedZone(`b-${unique()}`, `Zone B ${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    userA = await seedUser(`user-a+${unique()}@example.com`);
    userBOwner = await seedUser(`user-b+${unique()}@example.com`);
    userChapterA = await seedUser(`user-chapter-a+${unique()}@example.com`);
    cleanupUserIds.push(userA, userBOwner, userChapterA);

    await db.insert(userRoleBindings).values({
      userId: userA,
      zoneId: zoneA.id,
      roleId: zoneA.ownerRoleId,
    });
    await db.insert(userRoleBindings).values({
      userId: userBOwner,
      zoneId: zoneB.id,
      roleId: zoneB.ownerRoleId,
    });

    chapterA = await seedChapter(zoneA.id, "Chapter A");
    chapterAOther = await seedChapter(zoneA.id, "Chapter A Other");
    chapterB = await seedChapter(zoneB.id, "Chapter B");
    memberA = await seedMember(zoneA.id, "Alice", chapterA);
    memberAOther = await seedMember(zoneA.id, "Alison", chapterAOther);
    memberB = await seedMember(zoneB.id, "Bob", chapterB);

    await db.insert(userRoleBindings).values({
      userId: userChapterA,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterAdminRoleId,
    });
  });

  afterAll(async () => {
    // Order matters: members → addresses → chapters → lookups → roles → zones.
    for (const slug of cleanupSlugs) {
      await db.execute(
        sql`delete from member_addresses where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`delete from member_merge_proposals where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`delete from members where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`delete from chapters where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Listing isolation ──────────────────────────────────────────────

  it("GET /members from zone A only returns zone A members", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((m) => m.id)).toContain(memberA);
    expect(body.items.map((m) => m.id)).not.toContain(memberB);
  });

  it("GET /members/:id for another zone's member → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/members/${memberB}`);
    expect(res.status).toBe(404);
  });

  it("chapter-scoped admins only list members in their assigned chapters", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userChapterA, "chapter@x"));
    const res = await call(zoneA.slug, "/api/tenant/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((m) => m.id);
    expect(ids).toContain(memberA);
    expect(ids).not.toContain(memberAOther);
  });

  it("chapter-scoped admins cannot fetch or mutate another chapter's member", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userChapterA, "chapter@x"));
    const getRes = await call(zoneA.slug, `/api/tenant/members/${memberAOther}`);
    expect(getRes.status).toBe(404);

    const patchRes = await call(zoneA.slug, `/api/tenant/members/${memberAOther}`, {
      method: "PATCH",
      body: { firstName: "Hacked" },
    });
    expect(patchRes.status).toBe(404);
  });

  it("chapter-scoped admins can only create members in their assigned chapter", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userChapterA, "chapter@x"));
    const allowed = await call(zoneA.slug, "/api/tenant/members", {
      method: "POST",
      body: { firstName: "Chapter Scoped", chapterId: chapterA },
    });
    expect(allowed.status).toBe(201);

    const denied = await call(zoneA.slug, "/api/tenant/members", {
      method: "POST",
      body: { firstName: "Wrong Chapter", chapterId: chapterAOther },
    });
    expect(denied.status).toBe(403);
  });

  // ─── Chapter-scope filter (requireChapterScope) ─────────────────────

  it("GET /members?chapterId=<other-zone> → 404 chapter_not_found", async () => {
    // Zone admin in zone A hand-edits a URL pointing at zone B's chapter.
    // Previously: silently returned empty (zoneId filter masked it).
    // Now: 404 with a typed code so the UI can surface a clear error.
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/members?chapterId=${chapterB}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("GET /members?chapterId=<other-in-zone> from chapter-only user → 403", async () => {
    // userChapterA is bound to chapterA only; chapterAOther is in the same
    // zone but not on their roster. Returns 403, not 404 — the chapter
    // exists, they just can't see it.
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userChapterA, "chapter@x"));
    const res = await call(zoneA.slug, `/api/tenant/members?chapterId=${chapterAOther}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("GET /members?chapterId=<own-chapter> from chapter-only user → 200", async () => {
    // Sanity: the happy path the `/church/*` surface relies on.
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userChapterA, "chapter@x"));
    const res = await call(zoneA.slug, `/api/tenant/members?chapterId=${chapterA}`);
    expect(res.status).toBe(200);
  });

  // ─── Cross-tenant id smuggling ──────────────────────────────────────

  it("POST /members with another zone's chapter_id → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/members", {
      method: "POST",
      body: { firstName: "Eve", chapterId: chapterB },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("POST /members with another zone's title_id → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const [titleB] = await db
      .select({ id: titles.id })
      .from(titles)
      .where(sql`${titles.zoneId} = ${zoneB.id}`)
      .limit(1);
    const res = await call(zoneA.slug, "/api/tenant/members", {
      method: "POST",
      body: { firstName: "Eve", titleId: titleB.id },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("title_not_found");
  });

  it("PATCH /members/:id against another zone's member → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/members/${memberB}`, {
      method: "PATCH",
      body: { firstName: "Hacked" },
    });
    expect(res.status).toBe(404);
    const [stillBob] = await db
      .select({ firstName: members.firstName })
      .from(members)
      .where(sql`${members.id} = ${memberB}`);
    expect(stillBob.firstName).toBe("Bob");
  });

  // ─── Reference-code generator + creation flow ──────────────────────

  it("POST /members generates a per-zone monotonic reference code", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/members", {
      method: "POST",
      body: { firstName: "Claire", chapterId: chapterA },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { member: { referenceCode: string; chapterId: string } };
    expect(body.member.referenceCode).toMatch(/^M\d{7}$/);
    expect(body.member.chapterId).toBe(chapterA);
  });

  it("concurrent member creates receive distinct reference codes", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call(zoneA.slug, "/api/tenant/members", {
          method: "POST",
          body: { firstName: `Concurrent ${i}`, chapterId: chapterA },
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      member: { referenceCode: string };
    }>;
    expect(new Set(bodies.map((b) => b.member.referenceCode)).size).toBe(5);
  });

  // ─── Addresses ──────────────────────────────────────────────────────

  it("POST /members/:id/addresses against another zone's member → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, `/api/tenant/members/${memberB}/addresses`, {
      method: "POST",
      body: { line1: "123 Test St", isPrimary: true },
    });
    expect(res.status).toBe(404);
  });

  it("only one primary active address survives consecutive isPrimary inserts", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const r1 = await call(zoneA.slug, `/api/tenant/members/${memberA}/addresses`, {
      method: "POST",
      body: { line1: "First", isPrimary: true },
    });
    expect(r1.status).toBe(201);
    const r2 = await call(zoneA.slug, `/api/tenant/members/${memberA}/addresses`, {
      method: "POST",
      body: { line1: "Second", isPrimary: true },
    });
    expect(r2.status).toBe(201);
    const primaries = await db
      .select({ id: memberAddresses.id })
      .from(memberAddresses)
      .where(
        sql`${memberAddresses.memberId} = ${memberA}
            and ${memberAddresses.isPrimary} = true
            and ${memberAddresses.dateTo} is null`,
      );
    expect(primaries.length).toBe(1);
  });

  it("address routes reject soft-deleted members", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const deleted = await seedMember(zoneA.id, "Deleted Address Owner");
    await db
      .update(members)
      .set({ deletedAt: new Date(), isActive: false })
      .where(sql`${members.id} = ${deleted}`);

    const listRes = await call(zoneA.slug, `/api/tenant/members/${deleted}/addresses`);
    expect(listRes.status).toBe(404);

    const createRes = await call(zoneA.slug, `/api/tenant/members/${deleted}/addresses`, {
      method: "POST",
      body: { line1: "Should not save" },
    });
    expect(createRes.status).toBe(404);
  });

  // ─── Lookup tables ──────────────────────────────────────────────────

  it("GET /lookups/titles only returns this zone's titles", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/lookups/titles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; name: string }> };
    expect(body.items.length).toBe(11);
    const idsB = await db
      .select({ id: titles.id })
      .from(titles)
      .where(sql`${titles.zoneId} = ${zoneB.id}`);
    const aIds = new Set(body.items.map((t) => t.id));
    for (const r of idsB) expect(aIds.has(r.id)).toBe(false);
  });

  it("PATCH /lookups/marital-statuses/:id from another zone → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const [msB] = await db
      .select({ id: maritalStatuses.id })
      .from(maritalStatuses)
      .where(sql`${maritalStatuses.zoneId} = ${zoneB.id}`)
      .limit(1);
    const res = await call(zoneA.slug, `/api/tenant/lookups/marital-statuses/${msB.id}`, {
      method: "PATCH",
      body: { name: "Hacked" },
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /lookups/member-types/:id from another zone → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const [mtB] = await db
      .select({ id: memberTypes.id })
      .from(memberTypes)
      .where(sql`${memberTypes.zoneId} = ${zoneB.id}`)
      .limit(1);
    const res = await call(zoneA.slug, `/api/tenant/lookups/member-types/${mtB.id}`, {
      method: "PATCH",
      body: { name: "Hacked" },
    });
    expect(res.status).toBe(404);
  });

  it("each zone seeded the same lookup names but with distinct ids", async () => {
    const aTitles = await db
      .select({ name: titles.name })
      .from(titles)
      .where(sql`${titles.zoneId} = ${zoneA.id}`);
    const bTitles = await db
      .select({ name: titles.name })
      .from(titles)
      .where(sql`${titles.zoneId} = ${zoneB.id}`);
    expect(aTitles.length).toBe(11);
    expect(bTitles.length).toBe(11);
    expect(new Set(aTitles.map((t) => t.name))).toEqual(new Set(bTitles.map((t) => t.name)));
  });

  it("duplicate lookup names return 409", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/lookups/titles", {
      method: "POST",
      body: { name: "Mr" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("title_exists");
  });

  // ─── Merge proposals ────────────────────────────────────────────────

  it("POST /members/merge/proposals with a duplicate from another zone → 404", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/members/merge/proposals", {
      method: "POST",
      body: { primaryMemberId: memberA, duplicateMemberId: memberB },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("members_missing");
  });

  it("end-to-end: propose then apply a merge inside one zone", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    // Two siblings in zone A.
    const primary = await seedMember(zoneA.id, "Daniel");
    const dup = await seedMember(zoneA.id, "Danny");

    // Give both members a primary address. Applying the merge must demote one
    // before rewriting member_id, otherwise the partial unique index is hit.
    await db.insert(memberAddresses).values([
      {
        zoneId: zoneA.id,
        memberId: primary,
        isPrimary: true,
        line1: "Original Primary St",
        dateFrom: new Date().toISOString().slice(0, 10),
      },
      {
        zoneId: zoneA.id,
        memberId: dup,
        isPrimary: true,
        line1: "Migrated St",
        dateFrom: new Date().toISOString().slice(0, 10),
      },
    ]);

    const proposeRes = await call(zoneA.slug, "/api/tenant/members/merge/proposals", {
      method: "POST",
      body: { primaryMemberId: primary, duplicateMemberId: dup },
    });
    expect(proposeRes.status).toBe(201);
    const propose = (await proposeRes.json()) as { proposal: { id: string } };

    const applyRes = await call(zoneA.slug, "/api/tenant/members/merge/apply", {
      method: "POST",
      body: { proposalId: propose.proposal.id },
    });
    expect(applyRes.status).toBe(200);

    // Address rewrote to primary member.
    const migrated = await db
      .select({ memberId: memberAddresses.memberId })
      .from(memberAddresses)
      .where(sql`${memberAddresses.line1} = 'Migrated St'`);
    expect(migrated[0].memberId).toBe(primary);

    const primaries = await db
      .select({ id: memberAddresses.id })
      .from(memberAddresses)
      .where(
        sql`${memberAddresses.memberId} = ${primary}
          and ${memberAddresses.isPrimary} = true
          and ${memberAddresses.dateTo} is null`,
      );
    expect(primaries.length).toBe(1);

    // Duplicate is soft-deleted.
    const [delRow] = await db
      .select({ deletedAt: members.deletedAt, isActive: members.isActive })
      .from(members)
      .where(sql`${members.id} = ${dup}`);
    expect(delRow.deletedAt).not.toBeNull();
    expect(delRow.isActive).toBe(false);

    // Proposal is applied and each reassigned address is auditable.
    const [propRow] = await db
      .select({ status: memberMergeProposals.status })
      .from(memberMergeProposals)
      .where(sql`${memberMergeProposals.id} = ${propose.proposal.id}`);
    expect(propRow.status).toBe("applied");

    const reassignmentAudits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        sql`${auditEvents.zoneId} = ${zoneA.id}
          and ${auditEvents.action} = 'member.address.reassign'
          and ${auditEvents.entityType} = 'member_address'`,
      );
    expect(reassignmentAudits.length).toBeGreaterThanOrEqual(1);
  });

  it("duplicate open merge proposals return 409", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const primary = await seedMember(zoneA.id, "Merge Primary");
    const dup = await seedMember(zoneA.id, "Merge Duplicate");
    const body = { primaryMemberId: primary, duplicateMemberId: dup };
    const first = await call(zoneA.slug, "/api/tenant/members/merge/proposals", {
      method: "POST",
      body,
    });
    expect(first.status).toBe(201);
    const second = await call(zoneA.slug, "/api/tenant/members/merge/proposals", {
      method: "POST",
      body,
    });
    expect(second.status).toBe(409);
  });

  it("concurrent merge apply only applies one request", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const primary = await seedMember(zoneA.id, "Concurrent Merge Primary");
    const dup = await seedMember(zoneA.id, "Concurrent Merge Duplicate");
    const [proposal] = await db
      .insert(memberMergeProposals)
      .values({
        zoneId: zoneA.id,
        primaryMemberId: primary,
        duplicateMemberId: dup,
        matchedFields: [],
        matchScore: "0.00",
        status: "pending",
      })
      .returning({ id: memberMergeProposals.id });

    const responses = await Promise.all([
      call(zoneA.slug, "/api/tenant/members/merge/apply", {
        method: "POST",
        body: { proposalId: proposal.id },
      }),
      call(zoneA.slug, "/api/tenant/members/merge/apply", {
        method: "POST",
        body: { proposalId: proposal.id },
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("merge proposal listing is paginated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/members/merge/proposals?limit=1&offset=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; limit: number; offset: number };
    expect(body.items.length).toBeLessThanOrEqual(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
  });

  it("apply against another zone's proposal → 404", async () => {
    // Create a proposal in zone B, then try to apply it from zone A.
    const dupB = await seedMember(zoneB.id, "Other Bob");
    const [pRow] = await db
      .insert(memberMergeProposals)
      .values({
        zoneId: zoneB.id,
        primaryMemberId: memberB,
        duplicateMemberId: dupB,
        matchedFields: [],
        matchScore: "0.00",
        status: "pending",
      })
      .returning({ id: memberMergeProposals.id });

    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const res = await call(zoneA.slug, "/api/tenant/members/merge/apply", {
      method: "POST",
      body: { proposalId: pRow.id },
    });
    expect(res.status).toBe(404);
  });

  // ─── Soft-delete ───────────────────────────────────────────────────

  it("DELETE /members/:id soft-deletes (no hard delete)", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userA, "ua@x"));
    const target = await seedMember(zoneA.id, "Toast");
    const res = await call(zoneA.slug, `/api/tenant/members/${target}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ deletedAt: members.deletedAt })
      .from(members)
      .where(sql`${members.id} = ${target}`);
    expect(row).toBeDefined();
    expect(row.deletedAt).not.toBeNull();
  });
});
