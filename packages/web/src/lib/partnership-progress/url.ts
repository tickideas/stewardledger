// packages/web/src/lib/partnership-progress/url.ts
// Phase 8 — query-string builder for the partnership-progress
// dashboard. Pulled out of the page so the param hygiene
// (omit-when-empty, no leading "?", no key ordering surprises) is
// covered by unit tests.
// RELEVANT FILES: packages/web/src/routes/zone/partnership-progress/+page.svelte

export interface PartnershipProgressQuery {
  ministryYearId: string;
  chapterId?: string;
  givingTypeId?: string;
}

/**
 * Build the URL query string the dashboard sends to
 * `/api/tenant/reports/partnership-progress/data`.
 *
 * Empty-string filter values are dropped so we don't ship
 * `chapterId=` to the server (Zod would coerce that to an
 * invalid UUID and 400 the request). The order of params is
 * stable so test assertions can match exact strings.
 */
export function buildPartnershipProgressQuery(
  q: PartnershipProgressQuery,
): string {
  const params = new URLSearchParams();
  params.set("ministryYearId", q.ministryYearId);
  if (q.chapterId && q.chapterId !== "") params.set("chapterId", q.chapterId);
  if (q.givingTypeId && q.givingTypeId !== "")
    params.set("givingTypeId", q.givingTypeId);
  return params.toString();
}
