// packages/api/src/services/giving-setup-seed.ts
// Seeds a practical starting chart for giving setup in each new zone.

import {
  accounts,
  givingCategories,
  givingTypeAccounts,
  givingTypes,
  paymentMethods,
  serviceTypes,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

const CATEGORY_SEEDS = [
  { key: "tithes", name: "Tithes", shortCode: "TITHE" },
  { key: "offerings", name: "Offerings", shortCode: "OFFERING" },
  { key: "partnership", name: "Partnership", shortCode: "PARTNER" },
  { key: "special", name: "Special Giving", shortCode: "SPECIAL" },
] as const;

const PAYMENT_METHOD_SEEDS = [
  { code: "cash", name: "Cash" },
  { code: "cheque", name: "Cheque" },
  { code: "card", name: "Card" },
  { code: "bank_transfer", name: "Bank transfer" },
  { code: "online", name: "Online" },
  { code: "mobile_money", name: "Mobile money" },
] as const;

const SERVICE_TYPE_SEEDS = [
  { name: "Sunday Service", shortCode: "SUN" },
  { name: "Midweek Service", shortCode: "MID" },
  { name: "Partnership Service", shortCode: "PARTNER" },
] as const;

/** Seed giving setup tables for a freshly-created zone. */
export async function seedZoneGivingSetup(
  database: Db,
  zoneId: string,
  defaultCurrencyCode: string,
): Promise<void> {
  const insertedCategories = await database
    .insert(givingCategories)
    .values(
      CATEGORY_SEEDS.map((seed, ordinal) => ({
        zoneId,
        name: seed.name,
        shortCode: seed.shortCode,
        ordinal,
      })),
    )
    .returning({ id: givingCategories.id, shortCode: givingCategories.shortCode });

  const categoryByCode = new Map(insertedCategories.map((category) => [category.shortCode, category.id]));

  const insertedAccounts = await database
    .insert(accounts)
    .values([
      {
        zoneId,
        name: "General Fund",
        description: "Default account for tithes, offerings, and general giving.",
        currencyCode: defaultCurrencyCode,
      },
      {
        zoneId,
        name: "Partnership Fund",
        description: "Default account for partnership giving and targets.",
        currencyCode: defaultCurrencyCode,
      },
    ])
    .returning({ id: accounts.id, name: accounts.name });

  const accountByName = new Map(insertedAccounts.map((account) => [account.name, account.id]));
  const generalFundId = required(accountByName.get("General Fund"), "General Fund");
  const partnershipFundId = required(accountByName.get("Partnership Fund"), "Partnership Fund");

  const insertedGivingTypes = await database
    .insert(givingTypes)
    .values([
      {
        zoneId,
        categoryId: required(categoryByCode.get("TITHE"), "TITHE category"),
        name: "Tithe",
        shortCode: "TITHE",
        accountId: generalFundId,
        ordinal: 0,
      },
      {
        zoneId,
        categoryId: required(categoryByCode.get("OFFERING"), "OFFERING category"),
        name: "Offering",
        shortCode: "OFFERING",
        accountId: generalFundId,
        ordinal: 1,
      },
      {
        zoneId,
        categoryId: required(categoryByCode.get("PARTNER"), "PARTNER category"),
        name: "Partnership Seed",
        shortCode: "PARTNER",
        hasPartnershipTarget: true,
        accountId: partnershipFundId,
        ordinal: 2,
      },
      {
        zoneId,
        categoryId: required(categoryByCode.get("SPECIAL"), "SPECIAL category"),
        name: "Special Seed",
        shortCode: "SPECIAL",
        accountId: generalFundId,
        ordinal: 3,
      },
    ])
    .returning({ id: givingTypes.id, accountId: givingTypes.accountId });

  await database.insert(givingTypeAccounts).values(
    insertedGivingTypes.map((givingType) => ({
      zoneId,
      givingTypeId: givingType.id,
      accountId: required(givingType.accountId, "giving type account"),
    })),
  );

  await database.insert(paymentMethods).values(
    PAYMENT_METHOD_SEEDS.map((seed, ordinal) => ({
      zoneId,
      code: seed.code,
      name: seed.name,
      ordinal,
    })),
  );

  await database.insert(serviceTypes).values(
    SERVICE_TYPE_SEEDS.map((seed, ordinal) => ({
      zoneId,
      name: seed.name,
      shortCode: seed.shortCode,
      ordinal,
    })),
  );
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing seeded ${label}`);
  return value;
}
