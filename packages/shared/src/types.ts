// packages/shared/src/types.ts
// Shared TypeScript types used by API and web.

export type UUID = string;

/** Authorization context resolved by API middleware on every request. */
export interface AuthorizedContext {
  userId: UUID;
  zoneId: UUID;
  /** Denormalized; null when zone has only an unverified region name. */
  regionId: UUID | null;
  /** Effective role codes — union of all bindings the user holds in this zone. */
  roleCodes: string[];
  /** Chapter ids the user is bound to (empty = zone-wide bindings only). */
  chapterIds: UUID[];
  /** True if the user is a platform-level admin (super_admin etc.). */
  isPlatformAdmin: boolean;
}

/** Standard error envelope returned by the API. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Cursor pagination response. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
