// packages/shared/src/schemas.ts
// Shared Zod schemas for API ↔ web validation.

import { z } from "zod";
import { currencyCodeSchema } from "./money";
import { CHAPTER_ROLES, GROUP_ROLES, ZONE_ROLES } from "./roles";

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

/** Slug for groups: 1–50 chars, lowercase kebab. */
export const groupSlugSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9](-?[a-z0-9])*$/, "slug must be lowercase kebab-case");

/** Create a group. */
export const groupCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: groupSlugSchema,
  })
  .strict();
export type GroupCreateInput = z.infer<typeof groupCreateSchema>;

/** Update a group. All fields optional; an empty body is a no-op. */
export const groupUpdateSchema = groupCreateSchema.partial();
export type GroupUpdateInput = z.infer<typeof groupUpdateSchema>;

/**
 * Group list / search query. Mirrors `memberListQuerySchema` so the
 * "Groups directory" page on the zonal surface can paginate + search by
 * name or slug. Default `limit` is the same as the hard cap (200)
 * because the existing picker call sites (chapter → group, contributions
 * filter, batches) assume "every group I can see comes back in one call"
 * — a zone with more than 200 groups would need a different UX anyway.
 */
export const groupListQuerySchema = z.object({
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type GroupListQuery = z.infer<typeof groupListQuerySchema>;

/** Move a chapter to a different group. effectiveDate defaults to today (zone TZ) at the service layer. */
export const chapterMoveGroupSchema = z
  .object({
    groupId: uuidSchema,
    effectiveDate: z.string().date().optional(),
  })
  .strict();
export type ChapterMoveGroupInput = z.infer<typeof chapterMoveGroupSchema>;

/** Toggle a zone's `groups_enabled` flag. One-way — only `true` is accepted. */
export const zoneEnableGroupsSchema = z
  .object({ enabled: z.literal(true) })
  .strict();
export type ZoneEnableGroupsInput = z.infer<typeof zoneEnableGroupsSchema>;

/** Chapter creation. */
export const chapterCreateSchema = z.object({
  name: z.string().min(2).max(120),
  countryCode: countryCodeSchema.optional(),
  dateFrom: z.string().date().optional(),
  groupId: uuidSchema.optional(),
});
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;

/**
 * Chapter list / search query. Powers the "Chapters directory" page on
 * the zonal surface. `q` matches by reference code, name, and country
 * code; `groupId` filters to a single group. Default `limit` matches
 * the hard cap (200) so the many existing picker call sites — members,
 * contributions, imports, paying-in-books, targets, reports, the church
 * layout switcher, onboarding — keep their "all chapters in one call"
 * behaviour. Paginated directory views pass `limit` explicitly.
 */
export const chapterListQuerySchema = z.object({
  q: z.string().max(120).optional(),
  groupId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ChapterListQuery = z.infer<typeof chapterListQuerySchema>;

/**
 * Chapter banking reference. Free-form per chapter — a chapter typically
 * has 1–3 entries (“Main current”, “Online giving suspense”, etc.). Stored
 * inside `chapters.metadata.banking.references` rather than a dedicated
 * table; the UI only ever reads/writes the whole list, and there's no
 * join target that needs a FK.
 */
export const chapterBankingReferenceSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(200),
    note: z.string().trim().max(280).optional(),
  })
  .strict();
export type ChapterBankingReference = z.infer<typeof chapterBankingReferenceSchema>;

/** Editable chapter banking settings. `primaryCurrency` is independent of the zone default. */
export const chapterBankingSettingsSchema = z
  .object({
    primaryCurrency: currencyCodeSchema.nullable().optional(),
    references: z.array(chapterBankingReferenceSchema).max(20).optional(),
  })
  .strict();
export type ChapterBankingSettings = z.infer<typeof chapterBankingSettingsSchema>;

/** Chapter profile details stored with the chapter registry record. */
export const chapterProfileAddressSchema = z
  .object({
    line1: z.string().trim().max(160).nullable().optional(),
    line2: z.string().trim().max(160).nullable().optional(),
    city: z.string().trim().max(100).nullable().optional(),
    county: z.string().trim().max(100).nullable().optional(),
    postcode: z.string().trim().max(24).nullable().optional(),
    countryCode: countryCodeSchema.nullable().optional(),
  })
  .strict();
export type ChapterProfileAddress = z.infer<typeof chapterProfileAddressSchema>;

const chapterWebsiteSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => {
      if (value === "") return true;
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "website must be an http(s) URL" },
  );

export const chapterProfileSchema = z
  .object({
    address: chapterProfileAddressSchema.optional(),
    pastorName: z.string().trim().max(120).nullable().optional(),
    pastorEmail: z.string().trim().email().nullable().optional(),
    pastorPhone: z.string().trim().max(40).nullable().optional(),
    officeEmail: z.string().trim().email().nullable().optional(),
    officePhone: z.string().trim().max(40).nullable().optional(),
    website: chapterWebsiteSchema.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export type ChapterProfile = z.infer<typeof chapterProfileSchema>;

/**
 * Batch-template payload. Mirrors the chapter-batch create form: the
 * treasurer picks a template, the form prefills these fields, and they
 * fill in the per-Sunday specifics (event, totals, lines).
 *
 * `paymentMethodId` / `serviceTypeId` are stored as ids; the client must
 * tolerate a stale id (binding deleted since template was saved) by
 * silently falling back to the empty select.
 */
// `.strict()`: extra keys are rejected rather than persisted into the jsonb
// column. Otherwise a client could plant arbitrary keys that round-trip out
// of `GET /batch-templates` and into the audit `after` payload.
export const contributionBatchTemplatePayloadSchema = z
  .object({
    sourceType: z.enum(["envelope", "online", "bank_import", "oblation", "manual"]),
    defaultCurrency: currencyCodeSchema.nullable().optional(),
    paymentMethodId: uuidSchema.nullable().optional(),
    serviceTypeId: uuidSchema.nullable().optional(),
    referenceCode: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(4000).optional(),
  })
  .strict();
export type ContributionBatchTemplatePayload = z.infer<
  typeof contributionBatchTemplatePayloadSchema
>;

/** Create a batch template. */
export const contributionBatchTemplateCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    payload: contributionBatchTemplatePayloadSchema,
  })
  .strict();
export type ContributionBatchTemplateCreateInput = z.infer<
  typeof contributionBatchTemplateCreateSchema
>;

/** Role codes that may be granted via an invitation (no platform roles). */
export const invitableRoleSchema = z.enum([
  ...(Object.values(ZONE_ROLES) as [string, ...string[]]),
  ...(Object.values(GROUP_ROLES) as [string, ...string[]]),
  ...(Object.values(CHAPTER_ROLES) as [string, ...string[]]),
]);

/** Create an invitation. chapterId required for chapter_* roles, groupId for group_* roles, neither for zone roles. */
export const invitationCreateSchema = z
  .object({
    email: z.string().email(),
    roleCode: invitableRoleSchema,
    chapterId: uuidSchema.optional(),
    groupId: uuidSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.roleCode.startsWith("chapter_")) {
      if (v.chapterId === undefined) {
        ctx.addIssue({ code: "custom", path: ["chapterId"], message: "chapterId required for chapter roles" });
      }
      if (v.groupId !== undefined) {
        ctx.addIssue({ code: "custom", path: ["groupId"], message: "groupId must be empty for chapter roles" });
      }
      return;
    }
    if (v.roleCode.startsWith("group_")) {
      if (v.groupId === undefined) {
        ctx.addIssue({ code: "custom", path: ["groupId"], message: "groupId required for group roles" });
      }
      if (v.chapterId !== undefined) {
        ctx.addIssue({ code: "custom", path: ["chapterId"], message: "chapterId must be empty for group roles" });
      }
      return;
    }
    if (v.chapterId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["chapterId"], message: "chapterId must be empty for zone roles" });
    }
    if (v.groupId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["groupId"], message: "groupId must be empty for zone roles" });
    }
  });
export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;

/** Accepting an invitation — the token comes from the URL, body is the new user's identity. */
export const invitationAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(2).max(120),
  password: z.string().min(12).max(200),
});
export type InvitationAcceptInput = z.infer<typeof invitationAcceptSchema>;

/** Accept a platform-admin invitation. Same shape as the zone variant. */
export const platformInvitationAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(2).max(120),
  password: z.string().min(12).max(200),
});
export type PlatformInvitationAcceptInput = z.infer<
  typeof platformInvitationAcceptSchema
>;

/**
 * Re-issue (resend) a zone-owner invitation. The admin may correct the
 * primary contact's email here — the service revokes the previous open
 * zone-owner invitations for the zone before creating the new one.
 */
export const zoneOwnerInviteResendSchema = z.object({
  email: z.string().email(),
  primaryContactName: z.string().min(2).max(120).optional(),
});
export type ZoneOwnerInviteResendInput = z.infer<typeof zoneOwnerInviteResendSchema>;

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

/**
 * Upsert payload for per-event attendance. Every count is non-
 * negative; treat as the canonical headcount for that occurrence.
 * Replaces any prior attendance row (PUT, not PATCH).
 */
export const serviceEventAttendanceUpsertSchema = z.object({
  men: z.coerce.number().int().min(0).default(0),
  women: z.coerce.number().int().min(0).default(0),
  teens: z.coerce.number().int().min(0).default(0),
  children: z.coerce.number().int().min(0).default(0),
  firstTimers: z.coerce.number().int().min(0).default(0),
  newConverts: z.coerce.number().int().min(0).default(0),
  notes: z.string().max(2000).nullish(),
});
export type ServiceEventAttendanceUpsertInput = z.infer<
  typeof serviceEventAttendanceUpsertSchema
>;

// ─── Contributions (Phase 5) ─────────────────────────────────────────

/**
 * Decimal money amount on the wire as a string with up to 4dp.
 * Negative values are permitted: positive = inflow / gift, negative =
 * reversal. The service layer is responsible for keeping
 * abs(reversal) === abs(original).
 */
const moneyAmountSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, "amount must be a decimal with up to 4 dp");

export const SOURCE_TYPES = [
  "envelope",
  "online",
  "bank_import",
  "oblation",
  "manual",
] as const;

export const sourceTypeSchema = z.enum(SOURCE_TYPES);

const contributionLineCreateSchema = z.object({
  givingTypeId: uuidSchema,
  accountId: uuidSchema.nullish(),
  amount: moneyAmountSchema,
  note: z.string().max(2000).nullish(),
});
export type ContributionLineCreateInput = z.infer<typeof contributionLineCreateSchema>;

const contributionMemberCreateSchema = z.object({
  memberId: uuidSchema,
  allocationPercent: z
    .union([z.number(), z.string().regex(/^\d+(\.\d{1,2})?$/)])
    .transform((v) => (typeof v === "number" ? v.toFixed(2) : v))
    .nullish(),
});
export type ContributionMemberCreateInput = z.infer<typeof contributionMemberCreateSchema>;

/**
 * Create a draft contribution. `currencyCode` defaults to the zone's
 * `default_currency_code` when omitted. `givingPeriodId` is auto-derived
 * from `contributionDate` when omitted. `totalAmount`, when supplied, must
 * equal the sum of `lines[].amount`; the service computes it otherwise.
 */
export const contributionCreateSchema = z.object({
  chapterId: uuidSchema,
  memberId: uuidSchema.nullish(),
  batchId: uuidSchema.nullish(),
  sourceType: sourceTypeSchema,
  paymentMethodId: uuidSchema.nullish(),
  serviceEventId: uuidSchema.nullish(),
  givingPeriodId: uuidSchema.nullish(),
  contributionDate: z.string().date(),
  currencyCode: currencyCodeSchema.optional(),
  totalAmount: moneyAmountSchema.optional(),
  externalTransactionId: z.string().max(120).nullish(),
  description: z.string().max(2000).nullish(),
  lines: z.array(contributionLineCreateSchema).min(1, "at least one line is required"),
  members: z.array(contributionMemberCreateSchema).optional(),
});
export type ContributionCreateInput = z.infer<typeof contributionCreateSchema>;

/**
 * Patch a draft contribution. `lines` and `members`, when present, REPLACE
 * the existing rows atomically (the service issues delete + insert in a tx).
 */
export const contributionUpdateSchema = z.object({
  memberId: uuidSchema.nullish(),
  batchId: uuidSchema.nullish(),
  paymentMethodId: uuidSchema.nullish(),
  serviceEventId: uuidSchema.nullish(),
  givingPeriodId: uuidSchema.nullish(),
  contributionDate: z.string().date().optional(),
  currencyCode: currencyCodeSchema.optional(),
  totalAmount: moneyAmountSchema.optional(),
  externalTransactionId: z.string().max(120).nullish(),
  description: z.string().max(2000).nullish(),
  lines: z.array(contributionLineCreateSchema).min(1).optional(),
  members: z.array(contributionMemberCreateSchema).optional(),
});
export type ContributionUpdateInput = z.infer<typeof contributionUpdateSchema>;

export const contributionListQuerySchema = z.object({
  chapterId: uuidSchema.optional(),
  memberId: uuidSchema.optional(),
  batchId: uuidSchema.optional(),
  status: z.enum(["draft", "posted", "voided", "reversed"]).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ContributionListQuery = z.infer<typeof contributionListQuerySchema>;

export const contributionVoidSchema = z.object({
  voidReason: z.string().min(1).max(2000),
});
export type ContributionVoidInput = z.infer<typeof contributionVoidSchema>;

export const contributionReverseSchema = z.object({
  reason: z.string().min(1).max(2000),
  contributionDate: z.string().date().optional(),
});
export type ContributionReverseInput = z.infer<typeof contributionReverseSchema>;

// ─── Contribution batches ────────────────────────────────────────────

export const contributionBatchCreateSchema = z.object({
  chapterId: uuidSchema,
  serviceEventId: uuidSchema.nullish(),
  paymentMethodId: uuidSchema.nullish(),
  sourceType: sourceTypeSchema,
  referenceCode: z.string().max(80).nullish(),
  cashTotal: moneyAmountSchema.nullish(),
  chequeTotal: moneyAmountSchema.nullish(),
  currencyCode: currencyCodeSchema.optional(),
  notes: z.string().max(4000).nullish(),
});
export type ContributionBatchCreateInput = z.infer<typeof contributionBatchCreateSchema>;

export const contributionBatchUpdateSchema = z.object({
  serviceEventId: uuidSchema.nullish(),
  paymentMethodId: uuidSchema.nullish(),
  referenceCode: z.string().max(80).nullish(),
  cashTotal: moneyAmountSchema.nullish(),
  chequeTotal: moneyAmountSchema.nullish(),
  notes: z.string().max(4000).nullish(),
});
export type ContributionBatchUpdateInput = z.infer<typeof contributionBatchUpdateSchema>;

export const contributionBatchListQuerySchema = z.object({
  chapterId: uuidSchema.optional(),
  status: z.enum(["draft", "submitted", "approved", "posted", "voided"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ContributionBatchListQuery = z.infer<typeof contributionBatchListQuerySchema>;

export const contributionBatchVoidSchema = z.object({
  voidReason: z.string().min(1).max(2000),
});
export type ContributionBatchVoidInput = z.infer<typeof contributionBatchVoidSchema>;

// ─── Imports (Phase 6) ───────────────────────────────────────────────

export const IMPORT_FILE_TYPES = ["statement"] as const;
export const importFileTypeSchema = z.enum(IMPORT_FILE_TYPES);

export const IMPORT_SOURCE_TYPES = [
  "generic_csv",
  "bank_csv",
  "online_giving",
] as const;
export const importSourceTypeSchema = z.enum(IMPORT_SOURCE_TYPES);

/**
 * Initiate an import. The file is uploaded as multipart/form-data with the
 * binary body and these fields. Service-layer hashes the bytes and applies
 * the zone/checksum/file-type/source-type/chapter-scope re-upload guard.
 */
export const importCreateSchema = z.object({
  fileType: importFileTypeSchema.default("statement"),
  sourceType: importSourceTypeSchema.default("generic_csv"),
  chapterId: uuidSchema.nullish(),
});
export type ImportCreateInput = z.infer<typeof importCreateSchema>;

export const importListQuerySchema = z.object({
  status: z
    .enum([
      "received",
      "parsing",
      "parsed",
      "matching",
      "matched",
      "scheduled",
      "committing",
      "committed",
      "failed",
      "rolled_back",
    ])
    .optional(),
  // Optional chapter filter for the `/church/*` surface. Server validates
  // the id against the caller's zone + bindings; cross-zone ids return
  // 404, chapter-only users requesting another chapter return 403.
  chapterId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ImportListQuery = z.infer<typeof importListQuerySchema>;

export const importRowListQuerySchema = z.object({
  matchStatus: z.enum(["pending", "matched", "partial", "unmatched"]).optional(),
  validationStatus: z.enum(["pending", "valid", "invalid"]).optional(),
  isDuplicate: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ImportRowListQuery = z.infer<typeof importRowListQuerySchema>;

export const importRollbackSchema = z.object({
  reason: z.string().min(1).max(2000),
});
export type ImportRollbackInput = z.infer<typeof importRollbackSchema>;

// ─── Financial targets (Phase 8) ────────────────────────

/**
 * Non-negative money on the wire: same `numeric(19,4)` shape as
 * `moneyAmountSchema` but rejects negative values. Targets are
 * goal amounts; they don't carry the reversal sign convention.
 */
const nonNegativeMoneySchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "amount must be a non-negative decimal with up to 4 dp");

export const financialTargetCreateSchema = z.object({
  /** Null = zone-wide target (every chapter aggregates against it). */
  chapterId: uuidSchema.nullish(),
  givingTypeId: uuidSchema,
  ministryYearId: uuidSchema,
  fullTarget: nonNegativeMoneySchema,
  monthlyTarget: nonNegativeMoneySchema.nullish(),
  weeklyBreakdown: nonNegativeMoneySchema.nullish(),
  fullTargetCopies: z.coerce.number().int().min(0).nullish(),
  numberOfPartners: z.coerce.number().int().min(0).nullish(),
  currencyCode: currencyCodeSchema,
});
export type FinancialTargetCreateInput = z.infer<typeof financialTargetCreateSchema>;

/**
 * Update payload. The tuple columns (chapter / giving_type /
 * ministry_year) are immutable post-create — a different tuple is
 * a different target — so only the money + count fields are
 * patchable. `currencyCode` is also immutable: a target's currency
 * is part of its identity.
 */
export const financialTargetUpdateSchema = z.object({
  fullTarget: nonNegativeMoneySchema.optional(),
  monthlyTarget: nonNegativeMoneySchema.nullish(),
  weeklyBreakdown: nonNegativeMoneySchema.nullish(),
  fullTargetCopies: z.coerce.number().int().min(0).nullish(),
  numberOfPartners: z.coerce.number().int().min(0).nullish(),
});
export type FinancialTargetUpdateInput = z.infer<typeof financialTargetUpdateSchema>;

export const financialTargetListQuerySchema = z
  .object({
    chapterId: uuidSchema.optional(),
    givingTypeId: uuidSchema.optional(),
    ministryYearId: uuidSchema.optional(),
    /** When true, include only zone-wide rows (chapter_id is null). */
    zoneWideOnly: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((v) => (typeof v === "boolean" ? v : v === "true"))
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => !(v.chapterId && v.zoneWideOnly), {
    message: "chapterId and zoneWideOnly are mutually exclusive",
    path: ["zoneWideOnly"],
  });
export type FinancialTargetListQuery = z.infer<typeof financialTargetListQuerySchema>;

// ─── Paying-in books (Phase 8) ──────────────────────────────

/**
 * Reference codes are stored and compared as text — see the schema
 * module's comment for the rationale. The validator surfaces a
 * clear "not in range" message rather than try to parse the code.
 */
export const payingInBookCreateSchema = z
  .object({
    chapterId: uuidSchema,
    referenceCodeStart: z.string().trim().min(1).max(64),
    referenceCodeEnd: z.string().trim().min(1).max(64),
    dateFrom: z.string().date(),
    dateTo: z.string().date().nullish(),
  })
  // Equal-width start/end is the precondition for lexicographic
  // text ordering to mean what a treasurer expects. Without it,
  // start="0001" + end="100" would lexicographically accept
  // "0050" (correct) AND "002" (a 3-digit code that probably
  // wasn't supposed to fall inside a 4-digit pad).
  .refine((v) => v.referenceCodeStart.length === v.referenceCodeEnd.length, {
    message: "referenceCodeStart and referenceCodeEnd must be the same length",
    path: ["referenceCodeEnd"],
  })
  .refine((v) => v.referenceCodeStart <= v.referenceCodeEnd, {
    message: "referenceCodeStart must be lexicographically <= referenceCodeEnd",
    path: ["referenceCodeEnd"],
  })
  .refine((v) => !v.dateTo || v.dateTo >= v.dateFrom, {
    message: "dateTo must be on or after dateFrom",
    path: ["dateTo"],
  });
export type PayingInBookCreateInput = z.infer<typeof payingInBookCreateSchema>;

export const payingInBookUpdateSchema = z
  .object({
    chapterId: uuidSchema.optional(),
    referenceCodeStart: z.string().trim().min(1).max(64).optional(),
    referenceCodeEnd: z.string().trim().min(1).max(64).optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().nullish(),
  })
  // We can't cross-validate `start <= end` here without knowing the
  // existing values; the service layer reads the row and re-checks
  // before writing. The DB CHECK is the canonical guard.
  .refine((v) => v.dateTo == null || !v.dateFrom || v.dateTo >= v.dateFrom, {
    message: "dateTo must be on or after dateFrom",
    path: ["dateTo"],
  });
export type PayingInBookUpdateInput = z.infer<typeof payingInBookUpdateSchema>;

export const payingInBookListQuerySchema = z.object({
  chapterId: uuidSchema.optional(),
  /** When set, include only books active (covering) the given date. */
  activeOn: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PayingInBookListQuery = z.infer<typeof payingInBookListQuerySchema>;

/**
 * Saved report-filter payload. `filters` is a free-shape object
 * because each report's filter contract is owned by its `ReportSpec`
 * — the API route re-validates against the spec's schema before
 * persisting. The schema here only enforces the wrapper.
 */
export const savedReportFilterCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filters: z.record(z.string(), z.unknown()).default({}),
});
export type SavedReportFilterCreateInput = z.infer<
  typeof savedReportFilterCreateSchema
>;

export const savedReportFilterUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.name !== undefined || v.filters !== undefined, {
    message: "At least one of `name` or `filters` must be provided",
  });
export type SavedReportFilterUpdateInput = z.infer<
  typeof savedReportFilterUpdateSchema
>;
