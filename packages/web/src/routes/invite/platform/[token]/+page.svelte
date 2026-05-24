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

<svelte:head><title>Platform invitation · StewardLedger</title></svelte:head>

<div class="mx-auto max-w-md px-6 py-16">
  {#if data.gone}
    <span class="sl-eyebrow">§ Platform invitation</span>
    <h1 class="mt-3 sl-display text-[36px] leading-[1] text-[var(--ink)]">Invitation unavailable</h1>
    <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{goneCopy[data.gone] ?? goneCopy.invitation_gone}</p>
    <p class="mt-6 text-[12px] text-[var(--ink-mute)]">Need a new one? Ask a super-admin to re-send it.</p>
  {:else if data.invitation}
    <span class="sl-eyebrow">§ Platform invitation</span>
    <h1 class="mt-3 sl-display text-[34px] leading-[1] text-[var(--ink)]">
      Welcome <span class="sl-serif-italic font-light text-[var(--brass-deep)]">{data.invitation.name}</span>
    </h1>
    <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
      You've been invited to administer StewardLedger as
      <code class="sl-mono bg-[var(--paper-soft)] px-1.5 py-0.5 text-[11.5px] text-[var(--ink)]">{data.invitation.roleCode}</code>{#if data.invitation.superAdmin} with <strong class="text-[var(--ink)]">super-admin</strong>{/if}.
      Set a password to finish setting up your account on <strong class="text-[var(--ink)]">{data.invitation.email}</strong>.
    </p>
    <form class="sl-card-warm mt-8 space-y-4 p-6" onsubmit={submit}>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Password</span>
        <input type="password" required minlength="12" maxlength="200" autocomplete="new-password" bind:value={password} class="sl-input mt-1.5" />
        <p class="mt-1.5 text-[11.5px] text-[var(--ink-mute)]">At least 12 characters.</p>
      </label>
      {#if errorMsg}
        <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{errorMsg}</p>
      {/if}
      <button type="submit" disabled={submitting} class="sl-btn sl-btn-primary w-full justify-center">
        {submitting ? "Setting up…" : "Accept invitation"}
      </button>
    </form>
  {/if}
</div>
