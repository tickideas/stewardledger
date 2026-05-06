// packages/shared/src/schemas.ts
// Shared Zod schemas for API ↔ web validation.

import { z } from "zod";
import { currencyCodeSchema } from "./money";

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

/** Chapter creation. */
export const chapterCreateSchema = z.object({
  name: z.string().min(2).max(120),
  countryCode: countryCodeSchema.optional(),
  dateFrom: z.string().date().optional(),
});
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;
