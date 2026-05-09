// packages/web/src/lib/contributions/types.ts
//
// Wire-shape types for the contribution tenant API. These mirror the
// JSON the server actually emits — dates and decimals come over the
// wire as strings, not as `Date`/`Decimal`. They are intentionally
// hand-written rather than inferred from `@stewardledger/db` to avoid
// pulling drizzle into the web bundle; a Phase 6 cleanup will replace
// these with a thin `@stewardledger/shared/wire` module that derives
// from the same sources as the API responses.
//
// Keep this file in sync with:
//   • packages/db/src/schema/contributions.ts (`Contribution`, `ContributionBatch`, `ContributionLine`)
//   • packages/api/src/routes/tenant-contributions.ts (response shapes)
//   • packages/api/src/routes/tenant-members.ts (member list/get response shape)

export type ContributionStatus = "draft" | "posted" | "voided" | "reversed";
export type BatchStatus = "draft" | "submitted" | "approved" | "posted" | "voided";

export interface Contribution {
  id: string;
  zoneId: string;
  regionId: string | null;
  batchId: string | null;
  chapterId: string | null;
  memberId: string | null;
  sourceType: string;
  paymentMethodId: string | null;
  serviceEventId: string | null;
  givingPeriodId: string | null;
  contributionDate: string;
  totalAmount: string;
  currencyCode: string;
  externalTransactionId: string | null;
  description: string | null;
  status: ContributionStatus;
  voidReason: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  postedAt: string | null;
  postedByUserId: string | null;
  reversalOfContributionId: string | null;
  parentContributionId: string | null;
  createdAt: string;
  createdByUserId: string | null;
  updatedAt: string;
  updatedByUserId: string | null;
}

export interface ContributionLine {
  id: string;
  zoneId: string;
  contributionId: string;
  givingTypeId: string;
  accountId: string | null;
  amount: string;
  currencyCode: string;
  note: string | null;
}

export interface ContributionBatch {
  id: string;
  zoneId: string;
  chapterId: string;
  serviceEventId: string | null;
  paymentMethodId: string | null;
  sourceType: string;
  referenceCode: string | null;
  cashTotal: string | null;
  chequeTotal: string | null;
  currencyCode: string;
  status: BatchStatus;
  submittedAt: string | null;
  submittedByUserId: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  postedAt: string | null;
  postedByUserId: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  notes: string | null;
  createdAt: string;
  createdByUserId: string | null;
  updatedAt: string;
  updatedByUserId: string | null;
}

export interface MemberSummary {
  id: string;
  referenceCode: string;
  firstName: string;
  middleNames: string | null;
  lastName: string | null;
  fullName: string | null;
  gender: string | null;
  email: string | null;
  mobile: string | null;
  chapterId: string | null;
  isActive: boolean;
  createdAt: string;
}
