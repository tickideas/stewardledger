// packages/shared/src/schemas.groups.test.ts
// Vitest coverage for the new group + move-group + enable-groups Zod schemas
// and the group/chapter/zone invitation invariants on invitationCreateSchema.
// RELEVANT FILES: ./schemas.ts, ./roles.ts, ./schemas.groups.test.ts

import { describe, expect, it } from "vitest";
import {
  chapterCreateSchema,
  chapterMoveGroupSchema,
  groupCreateSchema,
  groupUpdateSchema,
  invitableRoleSchema,
  invitationCreateSchema,
  zoneEnableGroupsSchema,
} from "./schemas";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("group schemas", () => {
  it("accepts a valid group create payload", () => {
    const out = groupCreateSchema.parse({ name: "East Region", slug: "east-region" });
    expect(out.name).toBe("East Region");
    expect(out.slug).toBe("east-region");
  });

  it("rejects non-kebab slug", () => {
    expect(() => groupCreateSchema.parse({ name: "x", slug: "East Region" })).toThrow();
    expect(() => groupCreateSchema.parse({ name: "x", slug: "east_region" })).toThrow();
    expect(() => groupCreateSchema.parse({ name: "x", slug: "-east" })).toThrow();
  });

  it("rejects empty name or oversize", () => {
    expect(() => groupCreateSchema.parse({ name: "", slug: "x" })).toThrow();
    expect(() => groupCreateSchema.parse({ name: "x".repeat(101), slug: "x" })).toThrow();
  });

  it("update is partial", () => {
    expect(() => groupUpdateSchema.parse({})).not.toThrow();
    expect(() => groupUpdateSchema.parse({ name: "X" })).not.toThrow();
  });

  it("move-group requires groupId; effectiveDate optional", () => {
    const a = chapterMoveGroupSchema.parse({ groupId: VALID_UUID });
    expect(a.groupId).toBe(VALID_UUID);
    expect(a.effectiveDate).toBeUndefined();
    const b = chapterMoveGroupSchema.parse({
      groupId: VALID_UUID,
      effectiveDate: "2026-05-22",
    });
    expect(b.effectiveDate).toBe("2026-05-22");
    expect(() => chapterMoveGroupSchema.parse({ groupId: "not-a-uuid" })).toThrow();
    expect(() =>
      chapterMoveGroupSchema.parse({
        groupId: VALID_UUID,
        effectiveDate: "not-a-date",
      }),
    ).toThrow();
  });

  it("zoneEnableGroupsSchema only accepts { enabled: true }", () => {
    expect(zoneEnableGroupsSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(() => zoneEnableGroupsSchema.parse({ enabled: false })).toThrow();
  });
});

describe("chapterCreateSchema with groupId", () => {
  it("accepts a valid UUID", () => {
    const out = chapterCreateSchema.parse({ name: "Chapter A", groupId: VALID_UUID });
    expect(out.groupId).toBe(VALID_UUID);
  });

  it("rejects malformed UUID", () => {
    expect(() => chapterCreateSchema.parse({ name: "Chapter A", groupId: "nope" })).toThrow();
  });

  it("accepts omission", () => {
    const out = chapterCreateSchema.parse({ name: "Chapter A" });
    expect(out.groupId).toBeUndefined();
  });
});

describe("invitableRoleSchema", () => {
  it("accepts known role codes", () => {
    expect(() => invitableRoleSchema.parse("group_admin")).not.toThrow();
    expect(() => invitableRoleSchema.parse("group_pastor_viewer")).not.toThrow();
    expect(() => invitableRoleSchema.parse("chapter_admin")).not.toThrow();
    expect(() => invitableRoleSchema.parse("zone_owner")).not.toThrow();
  });

  it("rejects an unknown code", () => {
    expect(() => invitableRoleSchema.parse("platform_admin")).toThrow();
  });
});

describe("invitationCreateSchema", () => {
  const email = "user@example.com";

  it("chapter role + chapterId → ok", () => {
    const r = invitationCreateSchema.safeParse({ email, roleCode: "chapter_admin", chapterId: VALID_UUID });
    expect(r.success).toBe(true);
  });

  it("chapter role + groupId → fails on groupId", () => {
    const r = invitationCreateSchema.safeParse({
      email,
      roleCode: "chapter_admin",
      chapterId: VALID_UUID,
      groupId: VALID_UUID,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toContain("groupId");
  });

  it("chapter role without chapterId → fails on chapterId", () => {
    const r = invitationCreateSchema.safeParse({ email, roleCode: "chapter_admin" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toContain("chapterId");
  });

  it("group role + groupId → ok", () => {
    const r = invitationCreateSchema.safeParse({ email, roleCode: "group_admin", groupId: VALID_UUID });
    expect(r.success).toBe(true);
  });

  it("group role + chapterId → fails on chapterId", () => {
    const r = invitationCreateSchema.safeParse({
      email,
      roleCode: "group_admin",
      groupId: VALID_UUID,
      chapterId: VALID_UUID,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toContain("chapterId");
  });

  it("group role without groupId → fails on groupId", () => {
    const r = invitationCreateSchema.safeParse({ email, roleCode: "group_admin" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toContain("groupId");
  });

  it("zone role with no scope → ok", () => {
    const r = invitationCreateSchema.safeParse({ email, roleCode: "zone_owner" });
    expect(r.success).toBe(true);
  });

  it("zone role with chapterId → fails on chapterId", () => {
    const r = invitationCreateSchema.safeParse({ email, roleCode: "zone_owner", chapterId: VALID_UUID });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toContain("chapterId");
  });

  it("zone role with groupId → fails on groupId", () => {
    const r = invitationCreateSchema.safeParse({ email, roleCode: "zone_owner", groupId: VALID_UUID });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toContain("groupId");
  });
});
