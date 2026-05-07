// packages/web/src/routes/invite/[token]/+page.ts
// SSR loader for the invitation accept page. Verifies the token server-side
// so the page either renders the form or shows an "expired/used" notice.

import { error } from "@sveltejs/kit";
import { PUBLIC_API_URL } from "$lib/env";
import type { PageLoad } from "./$types";

interface InvitationView {
  email: string;
  roleCode: string;
  zoneSlug: string;
  zoneName: string;
  expiresAt: string;
}

export const load: PageLoad = async ({ params, fetch }) => {
  const res = await fetch(
    `${PUBLIC_API_URL}/api/public/invitations/${encodeURIComponent(params.token)}`,
  );
  if (res.status === 404) error(404, "Invitation not found");
  if (res.status === 410) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { token: params.token, invitation: null, gone: body?.error?.code ?? "invitation_gone" };
  }
  if (!res.ok) error(500, "Could not load invitation");
  const body = (await res.json()) as { invitation: InvitationView };
  return { token: params.token, invitation: body.invitation, gone: null };
};
