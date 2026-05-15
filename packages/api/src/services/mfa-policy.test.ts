// packages/api/src/services/mfa-policy.test.ts
// Phase 9 §5 (PR 2) — unit coverage for the bypass-closure helpers.
// The integration with Better Auth's hooks.before is exercised in
// `auth-twofactor.test.ts`; this file pins the pure functions.
// RELEVANT FILES: packages/api/src/services/mfa-policy.ts, packages/api/src/auth.ts

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user as userTable } from "@stewardledger/db/schema";
import { db } from "../db";
import {
  extractBypassEmail,
  isMfaEnrolled,
  MFA_BYPASS_PATHS,
  mfaRequiredInZone,
} from "./mfa-policy";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("MFA_BYPASS_PATHS", () => {
  it("covers the three paths an MFA-less user can sign in via", () => {
    expect(MFA_BYPASS_PATHS.has("/sign-in/email-otp")).toBe(true);
    expect(MFA_BYPASS_PATHS.has("/sign-in/magic-link")).toBe(true);
    expect(MFA_BYPASS_PATHS.has("/email-otp/send-verification-otp")).toBe(true);
  });

  it("does not include /sign-in/email (already TOTP-challenged)", () => {
    expect(MFA_BYPASS_PATHS.has("/sign-in/email")).toBe(false);
  });
});

describe("extractBypassEmail", () => {
  it("returns email from /sign-in/email-otp body", () => {
    expect(
      extractBypassEmail("/sign-in/email-otp", { email: "a@b.c", otp: "123456" }),
    ).toBe("a@b.c");
  });

  it("returns email from /sign-in/magic-link body", () => {
    expect(extractBypassEmail("/sign-in/magic-link", { email: "a@b.c" })).toBe(
      "a@b.c",
    );
  });

  it("returns email from /email-otp/send-verification-otp only when type=sign-in", () => {
    // The same endpoint serves email-verification + password-reset.
    // Only the sign-in flavour bypasses MFA; the others are not a
    // bypass risk and must remain functional.
    expect(
      extractBypassEmail("/email-otp/send-verification-otp", {
        email: "a@b.c",
        type: "sign-in",
      }),
    ).toBe("a@b.c");
    expect(
      extractBypassEmail("/email-otp/send-verification-otp", {
        email: "a@b.c",
        type: "email-verification",
      }),
    ).toBeNull();
    expect(
      extractBypassEmail("/email-otp/send-verification-otp", {
        email: "a@b.c",
        type: "forget-password",
      }),
    ).toBeNull();
  });

  it("returns null for malformed / missing-email bodies", () => {
    expect(extractBypassEmail("/sign-in/magic-link", null)).toBeNull();
    expect(extractBypassEmail("/sign-in/magic-link", "string body")).toBeNull();
    expect(extractBypassEmail("/sign-in/magic-link", { other: "x" })).toBeNull();
    expect(
      extractBypassEmail("/sign-in/magic-link", { email: 123 }),
    ).toBeNull();
  });
});

describe("mfaRequiredInZone", () => {
  it("returns false when the zone's required-role list is empty", () => {
    expect(mfaRequiredInZone([], ["zone_owner"])).toBe(false);
  });

  it("returns false when the user has no roles", () => {
    expect(mfaRequiredInZone(["zone_owner"], [])).toBe(false);
  });

  it("returns true when at least one of the user's role codes is required", () => {
    expect(
      mfaRequiredInZone(
        ["zone_owner", "zone_finance_admin"],
        ["chapter_treasurer", "zone_finance_admin"],
      ),
    ).toBe(true);
  });

  it("returns false when there's no intersection", () => {
    expect(
      mfaRequiredInZone(["zone_owner"], ["chapter_treasurer", "chapter_admin"]),
    ).toBe(false);
  });
});

describe("isMfaEnrolled", () => {
  const cleanupUserIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("_test")) {
      throw new Error("mfa-policy.test.ts requires a *_test DATABASE_URL");
    }
  });

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  it("returns false for an unknown email", async () => {
    expect(await isMfaEnrolled(db, `nobody-${unique()}@test.local`)).toBe(false);
  });

  it("returns false for a user who has not enrolled", async () => {
    const id = `u-${unique()}`;
    cleanupUserIds.push(id);
    const email = `${id}@test.local`;
    await db.insert(userTable).values({ id, email, emailVerified: true });
    expect(await isMfaEnrolled(db, email)).toBe(false);
  });

  it("returns true for a user with twoFactorEnabled set", async () => {
    const id = `u-${unique()}`;
    cleanupUserIds.push(id);
    const email = `${id}@test.local`;
    await db
      .insert(userTable)
      .values({ id, email, emailVerified: true, twoFactorEnabled: true });
    expect(await isMfaEnrolled(db, email)).toBe(true);
  });

  it("returns false for empty / whitespace-only email", async () => {
    expect(await isMfaEnrolled(db, "")).toBe(false);
    expect(await isMfaEnrolled(db, "   ")).toBe(false);
  });

  it("matches case-insensitively against a mixed-case stored email", async () => {
    // Better Auth lowercases on signup but our admin scripts /
    // imports could insert a mixed-case email directly. The bypass
    // check must catch the user either way — otherwise an attacker
    // could probe with a case variant and slip past the policy.
    const id = `u-${unique()}`;
    cleanupUserIds.push(id);
    const stored = `User+${unique()}@Example.COM`;
    await db.insert(userTable).values({
      id,
      email: stored,
      emailVerified: true,
      twoFactorEnabled: true,
    });
    expect(await isMfaEnrolled(db, stored.toLowerCase())).toBe(true);
    expect(await isMfaEnrolled(db, stored.toUpperCase())).toBe(true);
  });
});
