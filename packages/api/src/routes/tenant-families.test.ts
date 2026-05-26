// packages/api/src/routes/tenant-families.test.ts
// Cross-tenant fuzz + happy/rejection tests for the families surface
// (CHURCHPLUS-PORT-NOTES §2.2.1). Mirrors the shape of tenant-members.test.ts:
// stand up two zones, drive the Hono app via app.fetch with a faked Better
// Auth session, and assert (a) zone-A users cannot read or mutate zone-B
// data, (b) chapter-scoped writers are clamped to their bound chapter,
// and (c) the partial-unique invariants on family_members surface as
// clean 409s.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "@stewardledger/shared";
import {
  auditEvents,
  chapters,
  familyMembers,
  groups,
  members,
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
  chapterTreasurerRoleId: string;
  groupAdminRoleId: string;
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
    chapterTreasurerRoleId: roleMap.get(CHAPTER_ROLES.CHAPTER_TREASURER)!,
    groupAdminRoleId: roleMap.get(GROUP_ROLES.GROUP_ADMIN)!,
  };
}

async function seedUser(email: string): Promise<string> {
  const id = `u-${unique()}`;
  await db.insert(userTable).values({ id, email, emailVerified: true });
  return id;
}

async function seedChapter(zoneId: string, name: string, groupId: string | null = null): Promise<string> {
  const [row] = await db
    .insert(chapters)
    .values({
      zoneId,
      referenceCode: `C${unique()}`,
      name,
      groupId,
      dateFrom: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: chapters.id });
  return row.id;
}

async function seedGroup(zoneId: string): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ zoneId, name: `Group ${unique()}`, slug: `group-${unique()}` })
    .returning({ id: groups.id });
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

describe("tenant families routes", () => {
  let zoneA: SeededZone;
  let zoneB: SeededZone;
  let userAOwner: string;
  let userBOwner: string;
  let userChapterAdminA: string;
  let userChapterAdminAOther: string;
  let userChapterTreasurerA: string;
  let userGroupAdminA: string;
  let chapterA: string;
  let chapterAOther: string;
  let chapterB: string;
  let groupA: string;
  let memberA1: string;
  let memberA2: string;
  let memberAOther: string;
  let memberB: string;
  const cleanupSlugs: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    zoneA = await seedZone(`a-${unique()}`, `Zone A ${unique()}`);
    zoneB = await seedZone(`b-${unique()}`, `Zone B ${unique()}`);
    cleanupSlugs.push(zoneA.slug, zoneB.slug);

    userAOwner = await seedUser(`fam-a-owner+${unique()}@example.com`);
    userBOwner = await seedUser(`fam-b-owner+${unique()}@example.com`);
    userChapterAdminA = await seedUser(`fam-a-ch-adm+${unique()}@example.com`);
    userChapterAdminAOther = await seedUser(`fam-a-ch2-adm+${unique()}@example.com`);
    userChapterTreasurerA = await seedUser(`fam-a-ch-tre+${unique()}@example.com`);
    userGroupAdminA = await seedUser(`fam-a-grp-adm+${unique()}@example.com`);
    cleanupUserIds.push(
      userAOwner,
      userBOwner,
      userChapterAdminA,
      userChapterAdminAOther,
      userChapterTreasurerA,
      userGroupAdminA,
    );

    await db.insert(userRoleBindings).values({
      userId: userAOwner,
      zoneId: zoneA.id,
      roleId: zoneA.ownerRoleId,
      roleScope: "zone",
    });
    await db.insert(userRoleBindings).values({
      userId: userBOwner,
      zoneId: zoneB.id,
      roleId: zoneB.ownerRoleId,
      roleScope: "zone",
    });

    groupA = await seedGroup(zoneA.id);
    chapterA = await seedChapter(zoneA.id, "Chapter A Main", groupA);
    chapterAOther = await seedChapter(zoneA.id, "Chapter A Other");
    chapterB = await seedChapter(zoneB.id, "Chapter B");
    memberA1 = await seedMember(zoneA.id, "Alice", chapterA);
    memberA2 = await seedMember(zoneA.id, "Andrew", chapterA);
    memberAOther = await seedMember(zoneA.id, "Anita", chapterAOther);
    memberB = await seedMember(zoneB.id, "Bob", chapterB);

    await db.insert(userRoleBindings).values({
      userId: userChapterAdminA,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterAdminRoleId,
      roleScope: "chapter",
    });
    await db.insert(userRoleBindings).values({
      userId: userChapterAdminAOther,
      zoneId: zoneA.id,
      chapterId: chapterAOther,
      roleId: zoneA.chapterAdminRoleId,
      roleScope: "chapter",
    });
    await db.insert(userRoleBindings).values({
      userId: userChapterTreasurerA,
      zoneId: zoneA.id,
      chapterId: chapterA,
      roleId: zoneA.chapterTreasurerRoleId,
      roleScope: "chapter",
    });
    await db.insert(userRoleBindings).values({
      userId: userGroupAdminA,
      zoneId: zoneA.id,
      groupId: groupA,
      roleId: zoneA.groupAdminRoleId,
      roleScope: "group",
    });
  });

  afterAll(async () => {
    for (const slug of cleanupSlugs) {
      await db.execute(
        sql`delete from audit_events where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`delete from family_members where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`delete from families where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`delete from members where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`update chapters set group_id = null where zone_id = (select id from zones where slug = ${slug})`,
      );
      await db.execute(
        sql`delete from groups where zone_id = (select id from zones where slug = ${slug})`,
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

  // Helper: zone owner creates a family with one primary member.
  async function createFamilyAs(
    user: string,
    slug: string,
    body: { chapterId: string; name: string; primaryMemberId?: string },
  ): Promise<{ id: string; referenceCode: string }> {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(user, `${user}@x`));
    const res = await call(slug, "/api/tenant/families", { method: "POST", body });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { family: { id: string; referenceCode: string } };
    return json.family;
  }

  // ─── Happy path ────────────────────────────────────────────────────

  it("zone owner creates a family with an auto-allocated reference code", async () => {
    const family = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `The Adeyemi household ${unique()}`,
      primaryMemberId: memberA1,
    });
    expect(family.referenceCode).toMatch(/^F\d{7}$/);

    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(sql`${auditEvents.entityId} = ${family.id}`);
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining(["family.create", "family.member.add"]),
    );
  });

  it("listing returns only families in the caller's visible chapters", async () => {
    // Create one family per chapter in zone A; create one family in zone B.
    const famAa = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `Family A1 ${unique()}`,
    });
    const famAb = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterAOther,
      name: `Family A2 ${unique()}`,
    });
    const famB = await createFamilyAs(userBOwner, zoneB.slug, {
      chapterId: chapterB,
      name: `Family B ${unique()}`,
    });

    // Zone-owner sees both in zone A, never zone B.
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const ownerList = await call(zoneA.slug, "/api/tenant/families");
    expect(ownerList.status).toBe(200);
    const ownerBody = (await ownerList.json()) as { items: Array<{ id: string }> };
    const ownerIds = ownerBody.items.map((r) => r.id);
    expect(ownerIds).toContain(famAa.id);
    expect(ownerIds).toContain(famAb.id);
    expect(ownerIds).not.toContain(famB.id);

    // Chapter-admin sees only their chapter.
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userChapterAdminA, "ch@x"));
    const chList = await call(zoneA.slug, "/api/tenant/families");
    expect(chList.status).toBe(200);
    const chBody = (await chList.json()) as { items: Array<{ id: string }> };
    const chIds = chBody.items.map((r) => r.id);
    expect(chIds).toContain(famAa.id);
    expect(chIds).not.toContain(famAb.id);
  });

  // ─── Cross-tenant fuzz ──────────────────────────────────────────────

  it("zone-A owner cannot read a zone-B family by id", async () => {
    const famB = await createFamilyAs(userBOwner, zoneB.slug, {
      chapterId: chapterB,
      name: `Family B private ${unique()}`,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const res = await call(zoneA.slug, `/api/tenant/families/${famB.id}`);
    expect(res.status).toBe(404);
  });

  it("zone-A owner cannot POST a family pinned to a zone-B chapter", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const res = await call(zoneA.slug, "/api/tenant/families", {
      method: "POST",
      body: { chapterId: chapterB, name: `Cross zone ${unique()}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chapter_not_found");
  });

  it("zone-A owner cannot PATCH a zone-B family", async () => {
    const famB = await createFamilyAs(userBOwner, zoneB.slug, {
      chapterId: chapterB,
      name: `Family B patch ${unique()}`,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const res = await call(zoneA.slug, `/api/tenant/families/${famB.id}`, {
      method: "PATCH",
      body: { name: "hacked" },
    });
    expect(res.status).toBe(404);
  });

  it("zone-A owner cannot DELETE a zone-B family", async () => {
    const famB = await createFamilyAs(userBOwner, zoneB.slug, {
      chapterId: chapterB,
      name: `Family B delete ${unique()}`,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const res = await call(zoneA.slug, `/api/tenant/families/${famB.id}?reason=x`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("cannot add a zone-B member to a zone-A family", async () => {
    const famA = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `Family A xpoll ${unique()}`,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const res = await call(zoneA.slug, `/api/tenant/families/${famA.id}/members`, {
      method: "POST",
      body: { memberId: memberB },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("member_not_found");
  });

  it("cannot list family endpoint /members/:id/family for a cross-zone member", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    // memberB lives in zone B; query is in zone A.
    const res = await call(zoneA.slug, `/api/tenant/members/${memberB}/family`);
    // The query returns null (no open family in zone A for that id);
    // we expect 200 + null payload — confirming no cross-tenant leakage.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { family: unknown };
    expect(body.family).toBeNull();
  });

  // ─── Chapter clamp + role gating ───────────────────────────────────

  it("chapter-admin in chapter-A can create a family in chapter-A only", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(userChapterAdminA, "ch@x"),
    );
    const okRes = await call(zoneA.slug, "/api/tenant/families", {
      method: "POST",
      body: { chapterId: chapterA, name: `Chapter A scope ${unique()}` },
    });
    expect(okRes.status).toBe(201);

    const denied = await call(zoneA.slug, "/api/tenant/families", {
      method: "POST",
      body: { chapterId: chapterAOther, name: `Chapter A scope wrong ${unique()}` },
    });
    expect(denied.status).toBe(403);
  });

  it("chapter-treasurer is denied write but allowed read", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(userChapterTreasurerA, "tre@x"),
    );
    const read = await call(zoneA.slug, "/api/tenant/families");
    expect(read.status).toBe(200);
    const write = await call(zoneA.slug, "/api/tenant/families", {
      method: "POST",
      body: { chapterId: chapterA, name: `Treasurer write ${unique()}` },
    });
    expect(write.status).toBe(403);
  });

  it("group-admin can create a family in a chapter inside their group", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      fakeSession(userGroupAdminA, "grp@x"),
    );
    const res = await call(zoneA.slug, "/api/tenant/families", {
      method: "POST",
      body: { chapterId: chapterA, name: `Group admin ${unique()}` },
    });
    expect(res.status).toBe(201);
  });

  // ─── Partial-unique invariants ─────────────────────────────────────

  it("a member can belong to only one open family at a time", async () => {
    const f1 = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `F1 partial ${unique()}`,
      primaryMemberId: memberA2,
    });
    // memberA2 is already in f1; another POST to a fresh family must 409.
    const f2 = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `F2 partial ${unique()}`,
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const res = await call(zoneA.slug, `/api/tenant/families/${f2.id}/members`, {
      method: "POST",
      body: { memberId: memberA2 },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("member_already_in_family");
  });

  it("promoting a new primary contact demotes the existing primary in the same tx", async () => {
    // Seed two members specifically for this test so we are not racing
    // against other cases that have already claimed memberA1 / memberA2.
    const founder = await seedMember(zoneA.id, "Founder", chapterA);
    const fresh = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `Family promote ${unique()}`,
      primaryMemberId: founder,
    });
    const newMember = await seedMember(zoneA.id, "Promotable", chapterA);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const addRes = await call(zoneA.slug, `/api/tenant/families/${fresh.id}/members`, {
      method: "POST",
      body: { memberId: newMember, isPrimaryContact: true },
    });
    expect(addRes.status).toBe(201);

    const rows = await db
      .select({
        memberId: familyMembers.memberId,
        isPrimaryContact: familyMembers.isPrimaryContact,
      })
      .from(familyMembers)
      .where(
        sql`${familyMembers.familyId} = ${fresh.id} and ${familyMembers.leftAt} is null`,
      );
    expect(rows.find((r) => r.memberId === newMember)?.isPrimaryContact).toBe(true);
    expect(rows.find((r) => r.memberId === founder)?.isPrimaryContact).toBe(false);
  });

  it("removing the last primary requires promoting another first", async () => {
    const lastPrimary = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `Family last primary ${unique()}`,
      primaryMemberId: await seedMember(zoneA.id, "Lonely", chapterA),
    });
    // Add a second member (non-primary).
    const second = await seedMember(zoneA.id, "Second", chapterA);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    await call(zoneA.slug, `/api/tenant/families/${lastPrimary.id}/members`, {
      method: "POST",
      body: { memberId: second },
    });

    // Removing the primary now must fail because another open member exists.
    const detail = await call(zoneA.slug, `/api/tenant/families/${lastPrimary.id}`);
    const detailJson = (await detail.json()) as {
      family: { members: Array<{ memberId: string; isPrimaryContact: boolean }> };
    };
    const primary = detailJson.family.members.find((r) => r.isPrimaryContact)!;
    const res = await call(
      zoneA.slug,
      `/api/tenant/families/${lastPrimary.id}/members/${primary.memberId}?reason=moved`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("primary_contact_required");
  });

  // ─── Soft-delete ────────────────────────────────────────────────────

  it("cannot soft-delete a family with open members", async () => {
    const fresh = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `Family delete blocked ${unique()}`,
      primaryMemberId: await seedMember(zoneA.id, "DeleteBlocker", chapterA),
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(fakeSession(userAOwner, "owner@x"));
    const res = await call(zoneA.slug, `/api/tenant/families/${fresh.id}?reason=test`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("family_has_open_members");
  });

  // ─── DB-level guarantee (composite cross-tenant FK) ────────────────

  it("the (zone_id, member_id) composite FK refuses cross-tenant smuggling", async () => {
    // Create a family in zone A, then try to insert a family_members row
    // whose zone_id is zone A but member_id resolves to zone B.
    const famA = await createFamilyAs(userAOwner, zoneA.slug, {
      chapterId: chapterA,
      name: `Direct FK probe ${unique()}`,
    });
    let raised: { code?: string; cause?: { code?: string } } | null = null;
    try {
      await db.insert(familyMembers).values({
        zoneId: zoneA.id,
        familyId: famA.id,
        memberId: memberB, // zone-B member
      });
    } catch (err) {
      raised = err as { code?: string; cause?: { code?: string } };
    }
    expect(raised).not.toBeNull();
    // Postgres surfaces FK violations as SQLSTATE 23503; drizzle wraps the
    // pg error so the code lives on `cause` when bundled.
    const code = raised?.code ?? raised?.cause?.code;
    expect(code).toBe("23503");
  });
});
