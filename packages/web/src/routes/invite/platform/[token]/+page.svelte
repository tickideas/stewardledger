<!-- packages/web/src/routes/invite/platform/[token]/+page.svelte -->
<!-- Public accept page for platform-admin invitations. -->
<!-- Sibling of /invite/[token] (zone-scope); same visual treatment, distinct copy. -->
<!-- RELEVANT FILES: packages/web/src/routes/invite/platform/[token]/+page.ts, packages/web/src/routes/invite/[token]/+page.svelte -->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$lib/api";
  import { platformInviteLandingPath } from "$lib/session-paths";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let password = $state("");
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  const goneCopy: Record<string, string> = {
    invitation_revoked: "This invitation has been revoked.",
    invitation_already_accepted: "This invitation has already been used.",
    invitation_expired: "This invitation has expired.",
    invitation_gone: "This invitation is no longer valid.",
  };

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!data.invitation) return;
    errorMsg = null;
    submitting = true;
    try {
      const res = await api.post<{
        status: string;
        roleCode: string;
        superAdmin: boolean;
      }>(
        "/api/public/platform-invitations/accept",
        { token: data.token, name: data.invitation.name, password },
      );
      await goto(
        platformInviteLandingPath({
          roleCode: res.roleCode,
          superAdmin: res.superAdmin,
        }),
      );
    } catch (err) {
      errorMsg = err instanceof ApiError ? err.message : "Could not accept the invitation.";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="max-w-md mx-auto px-6 py-16">
  {#if data.gone}
    <h1 class="text-2xl font-semibold tracking-tight">Invitation unavailable</h1>
    <p class="mt-3 text-sm text-slate-600">{goneCopy[data.gone] ?? goneCopy.invitation_gone}</p>
    <p class="mt-6 text-xs text-slate-400">
      Need a new one? Ask a super-admin to re-send it.
    </p>
  {:else if data.invitation}
    <h1 class="text-2xl font-semibold tracking-tight">Welcome aboard, {data.invitation.name}</h1>
    <p class="mt-2 text-sm text-slate-600">
      You've been invited to administer StewardLedger as
      <code class="text-xs bg-slate-100 px-1 py-0.5 rounded">{data.invitation.roleCode}</code>{#if data.invitation.superAdmin}
        with <strong>super-admin</strong>
      {/if}.
      Set a password to finish setting up your account on
      <strong>{data.invitation.email}</strong>.
    </p>
    <form class="mt-6 space-y-4" onsubmit={submit}>
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Password</span>
        <input
          type="password"
          required
          minlength="12"
          maxlength="200"
          autocomplete="new-password"
          bind:value={password}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <p class="mt-1 text-xs text-slate-500">At least 12 characters.</p>
      </label>
      {#if errorMsg}
        <p class="text-sm text-red-600">{errorMsg}</p>
      {/if}
      <button
        type="submit"
        disabled={submitting}
        class="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {submitting ? "Setting up…" : "Accept invitation"}
      </button>
    </form>
  {/if}
</div>
