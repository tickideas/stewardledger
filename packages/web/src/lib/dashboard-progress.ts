// packages/web/src/lib/dashboard-progress.ts
// Shared dashboard progress-card types and presentation helpers.
// Keeps zone and chapter dashboard target-progress rendering aligned.
// RELEVANT FILES: packages/web/src/routes/zone/dashboard/+page.svelte, packages/web/src/routes/church/overview/+page.svelte, packages/api/src/services/dashboards/partnership-progress.ts

export type PartnershipCurrencyProgress = {
  currencyCode: string;
  target: string;
  achieved: string;
  percentProgress: string;
  targetCount: number;
};

export type PartnershipProgress =
  | { available: false; reason: string }
  | {
      available: true;
      ministryYearId: string;
      ministryYearLabel: string;
      periodStart: string;
      periodEnd: string;
      scope: "zone" | "chapter";
      perCurrency: PartnershipCurrencyProgress[];
    };

export function percentWidth(percentProgress: string): string {
  const value = Number.parseFloat(percentProgress);
  if (!Number.isFinite(value)) return "0%";
  return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
}
