// packages/web/src/lib/ui.ts
// Shared presentation helpers for the Svelte web app.
// Keeps repeated UI mapping logic consistent across redesigned dashboards.
// RELEVANT FILES: ../app.css, ../routes/admin/zones/+page.svelte, ../routes/contributions/+page.svelte, ../routes/imports/+page.svelte

/**
 * Default page size for paginated directory views (members, chapters,
 * groups). Kept here so the three pages stay in lockstep and any future
 * directory page picks up the same default without re-deriving it.
 */
export const DIRECTORY_PAGE_SIZE = 25;

export function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
    case "posted":
    case "committed":
      return "sl-badge sl-badge-ok";
    case "approved":
    case "scheduled":
      return "sl-badge sl-badge-info";
    case "pending_setup":
    case "past_due":
    case "submitted":
    case "matched":
      return "sl-badge sl-badge-warn";
    case "suspended":
    case "reversed":
    case "failed":
      return "sl-badge sl-badge-bad";
    default:
      return "sl-badge sl-badge-mute";
  }
}
