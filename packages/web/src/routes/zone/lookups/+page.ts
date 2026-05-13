// packages/web/src/routes/zone/lookups/+page.ts
// Redirects the retired member lookup page to the Members page profile-field panel.
// Exists so old bookmarks keep working after lookup management moved into Members.
// RELEVANT FILES: packages/web/src/routes/zone/members/+page.svelte, packages/web/src/routes/zone/members/member-profile-fields.svelte, packages/web/src/lib/nav.ts

import { redirect } from "@sveltejs/kit";

export function load(): never {
  redirect(303, "/zone/members?panel=profile-fields");
}
