// packages/web/src/routes/invite/platform/[token]/+page.ts
// SSR loader for the platform-admin invitation accept page. Mirrors
// the zone-invite loader: verifies the token server-side and renders
// either the accept form or a gone/expired notice.
//
// RELEVANT FILES: packages/web/src/routes/invite/platform/[token]/+page.svelte, packages/api/src/routes/public.ts

import { error } from "@sveltejs/kit";
import { PUBLIC_API_URL } from "$lib/env";
import type { PageLoad } from "./$types";

interface PlatformInvitationView {
  email: string;
  name: string;
  roleCode: string;
  superAdmin: boolean;
  expiresAt: string;
}

export const load: PageLoad = async ({ params, fetch }) => {
  const res = await fetch(
    `${PUBLIC_API_URL}/api/public/platform-invitations/${encodeURIComponent(params.token)}`,
  );
  if (res.status === 404) error(404, "Invitation not found");
  if (res.status === 410) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { token: params.token, invitation: null, gone: body?.error?.code ?? "invitation_gone" };
  }
  if (!res.ok) error(500, "Could not load invitation");
  const body = (await res.json()) as { invitation: PlatformInvitationView };
  return { token: params.token, invitation: body.invitation, gone: null };
};
