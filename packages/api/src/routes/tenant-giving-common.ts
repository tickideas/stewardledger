// packages/api/src/routes/tenant-giving-common.ts
// Shared helpers for tenant-scoped giving setup routes.

import { CHAPTER_ROLES, ZONE_ROLES } from "@stewardledger/shared";

export const GIVING_READ_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ZONE_ROLES.ZONE_AUDITOR,
  ZONE_ROLES.ZONE_PASTOR_VIEWER,
  CHAPTER_ROLES.CHAPTER_ADMIN,
  CHAPTER_ROLES.CHAPTER_TREASURER,
  CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
  CHAPTER_ROLES.CHAPTER_PASTOR_VIEWER,
] as const;

export const GIVING_WRITE_ROLES = [
  ZONE_ROLES.ZONE_OWNER,
  ZONE_ROLES.ZONE_ADMIN,
  ZONE_ROLES.ZONE_FINANCE_ADMIN,
] as const;

export function forbidden(
  c: { json: (b: unknown, s: number) => Response },
  msg = "Insufficient role",
): Response {
  return c.json({ error: { code: "forbidden", message: msg } }, 403);
}

export function conflict(
  c: { json: (b: unknown, s: number) => Response },
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, 409);
}

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const direct = err as { code?: unknown; cause?: unknown };
  if (direct.code === "23505") return true;
  const cause = direct.cause;
  return Boolean(cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505");
}

export function updateValues(input: Record<string, unknown>): Record<string, unknown> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) updates[key] = value;
  }
  return updates;
}
