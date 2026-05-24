// packages/web/src/routes/zone/merge/+page.ts
// Redirects the renamed merge-proposals page to its new home at /zone/duplicates.
// Exists so existing bookmarks, saved links, and audit-log URLs keep working after the rename.
// RELEVANT FILES: packages/web/src/routes/zone/duplicates/+page.svelte, packages/web/src/routes/zone/lookups/+page.ts, packages/web/src/lib/nav.ts

import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ url }) => {
  // Preserve any query string the caller arrived with (e.g. `?zone=…`)
  // so a deep link from another tab keeps its tenant context.
  redirect(303, `/zone/duplicates${url.search}`);
};
