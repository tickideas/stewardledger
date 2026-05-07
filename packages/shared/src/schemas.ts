// packages/shared/src/schemas.ts
// Shared Zod schemas for API ↔ web validation.

import { z } from "zod";
import { currencyCodeSchema } from "./money";
import { CHAPTER_ROLES, ZONE_ROLES } from "./roles";

/** UUID v4 / v7 schema. */
export const uuidSchema = z.string().uuid();

/** Zone slug: lowercase, kebab-case, 3–40 chars. */
export const zoneSlugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](-?[a-z0-9])*$/, "slug must be lowercase kebab-case");

/** ISO 4217 currency code. */
export { currencyCodeSchema };

/** ISO 3166-1 alpha-2 country code. */
export const countryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, "country must be ISO 3166-1 alpha-2 (e.g. GB, US, NG)");

/** IANA time zone (loose check; Better Auth / Date APIs validate fully at runtime). */
export const timeZoneSchema = z.string().min(3).max(64);

/**
 * Zone signup payload. Includes either a known regionId OR a free-text
 * regionNameUnverified — never both, never neither.
 */
export const zoneSignupSchema = z
  .object({
    name: z.string().min(2).max(120),
    slug: zoneSlugSchema,
    countryCode: countryCodeSchema,
    timeZone: timeZoneSchema,
    defaultCurrency: currencyCodeSchema,
    fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
    ministryYearStartMonth: z.number().int().min(1).max(12).default(3),
    regionId: uuidSchema.optional(),
    regionNameUnverified: z.string().min(2).max(120).optional(),
    primaryContactName: z.string().min(2).max(120),
    primaryContactEmail: z.string().email(),
  })
  .refine(
    (v) =>
      (v.regionId !== undefined && v.regionNameUnverified === undefined) ||
      (v.regionId === undefined && v.regionNameUnverified !== undefined),
    { message: "Provide either regionId or regionNameUnverified, not both", path: ["regionId"] },
  );
export type ZoneSignupInput = z.infer<typeof zoneSignupSchema>;

/** Region creation (platform admin). */
export const regionCreateSchema = z.object({
  name: z.string().min(2).max(120),
  shortCode: z.string().min(2).max(16).optional(),
  countryCode: countryCodeSchema.optional(),
});
export type RegionCreateInput = z.infer<typeof regionCreateSchema>;

/** Region update (platform admin). */
export const regionUpdateSchema = regionCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type RegionUpdateInput = z.infer<typeof regionUpdateSchema>;

/**
 * Promote one or more zones currently on `region_name_unverified` onto a real
 * region. The region either already exists (`regionId`) or is created from
 * `regionDraft` in the same request.
 */
export const regionPromoteSchema = z
  .object({
    zoneIds: z.array(uuidSchema).min(1),
    regionId: uuidSchema.optional(),
    regionDraft: regionCreateSchema.optional(),
  })
  .refine(
    (v) =>
      (v.regionId !== undefined && v.regionDraft === undefined) ||
      (v.regionId === undefined && v.regionDraft !== undefined),
    { message: "Provide either regionId or regionDraft, not both", path: ["regionId"] },
  );
export type RegionPromoteInput = z.infer<typeof regionPromoteSchema>;

/** Chapter creation. */
export const chapterCreateSchema = z.object({
  name: z.string().min(2).max(120),
  countryCode: countryCodeSchema.optional(),
  dateFrom: z.string().date().optional(),
});
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;

/** Role codes that may be granted via an invitation (no platform roles). */
export const invitableRoleSchema = z.enum([
  ...(Object.values(ZONE_ROLES) as [string, ...string[]]),
  ...(Object.values(CHAPTER_ROLES) as [string, ...string[]]),
]);

/** Create an invitation. chapterId required for chapter_* roles, forbidden otherwise. */
export const invitationCreateSchema = z
  .object({
    email: z.string().email(),
    roleCode: invitableRoleSchema,
    chapterId: uuidSchema.optional(),
  })
  .refine(
    (v) =>
      v.roleCode.startsWith("chapter_") ? v.chapterId !== undefined : v.chapterId === undefined,
    { message: "chapterId required for chapter roles, forbidden otherwise", path: ["chapterId"] },
  );
export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;

/** Accepting an invitation — the token comes from the URL, body is the new user's identity. */
export const invitationAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(2).max(120),
  password: z.string().min(12).max(200),
});
export type InvitationAcceptInput = z.infer<typeof invitationAcceptSchema>;

/** Public regions typeahead query. */
export const regionTypeaheadSchema = z.object({
  q: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(50).default(10),
});
export type RegionTypeaheadInput = z.infer<typeof regionTypeaheadSchema>;

// ─── Members ──────────────────────────────────────────────────────────

const genderSchema = z.enum(["M", "F", "U"]);

/** Member create. References to lookup ids and chapter id are tenant-checked in the route. */
export const memberCreateSchema = z.object({
  firstName: z.string().min(1).max(120),
  middleNames: z.string().max(200).nullish(),
  lastName: z.string().max(120).nullish(),
  titleId: uuidSchema.nullish(),
  gender: genderSchema.nullish(),
  email: z.string().email().nullish(),
  dateOfBirth: z.string().date().nullish(),
  mobile: z.string().max(40).nullish(),
  telephone: z.string().max(40).nullish(),
  kingschatUsername: z.string().max(120).nullish(),
  chapterId: uuidSchema.nullish(),
  maritalStatusId: uuidSchema.nullish(),
  memberTypeId: uuidSchema.nullish(),
  dateJoinedMinistry: z.string().date().nullish(),
  foundationSchoolGraduationDate: z.string().date().nullish(),
  isCell: z.boolean().optional(),
  isDepartment: z.boolean().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type MemberCreateInput = z.infer<typeof memberCreateSchema>;

/** Member update — every field optional; route enforces tenant scoping. */
export const memberUpdateSchema = memberCreateSchema.partial();
export type MemberUpdateInput = z.infer<typeof memberUpdateSchema>;

/** Member list/search query. */
export const memberListQuerySchema = z.object({
  q: z.string().max(120).optional(),
  chapterId: uuidSchema.optional(),
  isActive: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

// ─── Member addresses ─────────────────────────────────────────────────

export const memberAddressCreateSchema = z
  .object({
    line1: z.string().max(200).nullish(),
    line2: z.string().max(200).nullish(),
    city: z.string().max(120).nullish(),
    regionText: z.string().max(120).nullish(),
    postcode: z.string().max(20).nullish(),
    countryCode: countryCodeSchema.optional(),
    isPrimary: z.boolean().optional(),
    dateFrom: z.string().date().optional(),
  })
  .refine(
    (v) => Boolean(v.line1 || v.line2 || v.city || v.postcode || v.countryCode),
    { message: "address must have at least one field", path: ["line1"] },
  );
export type MemberAddressCreateInput = z.infer<typeof memberAddressCreateSchema>;

export const memberAddressUpdateSchema = z.object({
  line1: z.string().max(200).nullish(),
  line2: z.string().max(200).nullish(),
  city: z.string().max(120).nullish(),
  regionText: z.string().max(120).nullish(),
  postcode: z.string().max(20).nullish(),
  countryCode: countryCodeSchema.optional(),
  isPrimary: z.boolean().optional(),
  dateTo: z.string().date().nullish(),
});
export type MemberAddressUpdateInput = z.infer<typeof memberAddressUpdateSchema>;

// ─── Lookup tables (titles, marital_statuses, member_types) ───────────

export const lookupCreateSchema = z.object({
  name: z.string().min(1).max(80),
  ordinal: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type LookupCreateInput = z.infer<typeof lookupCreateSchema>;

export const lookupUpdateSchema = lookupCreateSchema.partial();
export type LookupUpdateInput = z.infer<typeof lookupUpdateSchema>;

/** Title-specific create accepts an optional gender hint. */
export const titleCreateSchema = lookupCreateSchema.extend({
  gender: z.enum(["M", "F"]).nullish(),
});
export type TitleCreateInput = z.infer<typeof titleCreateSchema>;

export const titleUpdateSchema = titleCreateSchema.partial();
export type TitleUpdateInput = z.infer<typeof titleUpdateSchema>;

// ─── Member merge proposal ────────────────────────────────────────────

export const memberMergeProposeSchema = z
  .object({
    primaryMemberId: uuidSchema,
    duplicateMemberId: uuidSchema,
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.primaryMemberId !== v.duplicateMemberId, {
    message: "primary and duplicate must differ",
    path: ["duplicateMemberId"],
  });
export type MemberMergeProposeInput = z.infer<typeof memberMergeProposeSchema>;

export const memberMergeApplySchema = z.object({
  proposalId: uuidSchema,
});
export type MemberMergeApplyInput = z.infer<typeof memberMergeApplySchema>;

export const memberMergeProposalListQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "applied"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type MemberMergeProposalListQuery = z.infer<typeof memberMergeProposalListQuerySchema>;

// ─── Giving setup ────────────────────────────────────────────────────

const shortCodeSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9_-]+$/, "shortCode must be uppercase letters, numbers, underscores, or hyphens");

export const givingCategoryCreateSchema = z.object({
  name: z.string().min(1).max(120),
  parentCategoryId: uuidSchema.nullish(),
  shortCode: shortCodeSchema.nullish(),
  ordinal: z.number().int().min(0).max(1000).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().nullish(),
});
export type GivingCategoryCreateInput = z.infer<typeof givingCategoryCreateSchema>;

export const givingCategoryUpdateSchema = givingCategoryCreateSchema.partial();
export type GivingCategoryUpdateInput = z.infer<typeof givingCategoryUpdateSchema>;

export const accountCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  currencyCode: currencyCodeSchema.optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().nullish(),
});
export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

export const accountUpdateSchema = accountCreateSchema.partial();
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;

export const givingTypeCreateSchema = z.object({
  name: z.string().min(1).max(120),
  categoryId: uuidSchema,
  shortCode: shortCodeSchema.nullish(),
  isZonal: z.boolean().optional(),
  isChapter: z.boolean().optional(),
  hasPartnershipTarget: z.boolean().optional(),
  accountId: uuidSchema.nullish(),
  ordinal: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type GivingTypeCreateInput = z.infer<typeof givingTypeCreateSchema>;

export const givingTypeUpdateSchema = givingTypeCreateSchema.partial();
export type GivingTypeUpdateInput = z.infer<typeof givingTypeUpdateSchema>;

export const paymentMethodCreateSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "code must be lowercase snake_case"),
  name: z.string().min(1).max(120),
  isActive: z.boolean().optional(),
  ordinal: z.number().int().min(0).max(1000).optional(),
});
export type PaymentMethodCreateInput = z.infer<typeof paymentMethodCreateSchema>;

export const paymentMethodUpdateSchema = paymentMethodCreateSchema.partial();
export type PaymentMethodUpdateInput = z.infer<typeof paymentMethodUpdateSchema>;

export const serviceTypeCreateSchema = z.object({
  name: z.string().min(1).max(120),
  shortCode: shortCodeSchema.nullish(),
  isActive: z.boolean().optional(),
  ordinal: z.number().int().min(0).max(1000).optional(),
});
export type ServiceTypeCreateInput = z.infer<typeof serviceTypeCreateSchema>;

export const serviceTypeUpdateSchema = serviceTypeCreateSchema.partial();
export type ServiceTypeUpdateInput = z.infer<typeof serviceTypeUpdateSchema>;

export const serviceEventListQuerySchema = z.object({
  chapterId: uuidSchema.optional(),
  serviceTypeId: uuidSchema.optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ServiceEventListQuery = z.infer<typeof serviceEventListQuerySchema>;

export const serviceEventCreateSchema = z.object({
  chapterId: uuidSchema.nullish(),
  serviceTypeId: uuidSchema,
  serviceDate: z.string().date(),
  notes: z.string().max(2000).nullish(),
});
export type ServiceEventCreateInput = z.infer<typeof serviceEventCreateSchema>;

export const serviceEventUpdateSchema = serviceEventCreateSchema.partial();
export type ServiceEventUpdateInput = z.infer<typeof serviceEventUpdateSchema>;
