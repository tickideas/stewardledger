<!-- packages/web/src/routes/admin/administrators/invite-admin-modal.svelte -->
<!-- Modal that POSTs /api/admin/administrators/invite to create a platform-admin invitation. -->
<!-- Used by /admin/administrators to onboard a new platform admin by email. -->
<!-- RELEVANT FILES: packages/web/src/routes/admin/administrators/+page.svelte, packages/api/src/routes/admin-administrators.ts -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";

  let { open = $bindable(false), oninvited } = $props<{
    open?: boolean;
    oninvited?: (result: { invitationId: string; emailSent: boolean; emailError: string | null }) => void;
  }>();

  type RoleCode = "support_admin" | "billing_admin" | "region_curator";

  let name = $state("");
  let email = $state("");
  let roleCode = $state<RoleCode>("support_admin");
  let superAdmin = $state(false);
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  function close() {
    if (submitting) return;
    open = false;
  }

  $effect(() => {
    if (!open) {
      name = "";
      email = "";
      roleCode = "support_admin";
      superAdmin = false;
      submitting = false;
      errorMsg = null;
    }
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) close();
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    submitting = true;
    errorMsg = null;
    try {
      const res = await api.post<{
        invitationId: string;
        emailSent: boolean;
        emailError: string | null;
      }>("/api/admin/administrators/invite", { name, email, roleCode, superAdmin });
      open = false;
      oninvited?.({
        invitationId: res.invitationId,
        emailSent: res.emailSent,
        emailError: res.emailError,
      });
    } catch (err) {
      errorMsg = err instanceof ApiError ? err.message : "Could not send the invitation.";
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
    style="background: rgba(21,22,26,0.45); backdrop-filter: blur(2px)"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div
      class="sl-card w-full max-w-xl"
      style="box-shadow: var(--shadow-lift)"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-admin-title"
    >
      <div class="flex items-start justify-between border-b border-[var(--rule)] px-7 py-5">
        <div>
          <span class="sl-eyebrow">New administrator</span>
          <h2 id="invite-admin-title" class="mt-2 sl-display text-[24px] text-[var(--ink)]">
            Invite an <span class="sl-serif-italic text-[var(--brass-deep)]">administrator</span>
          </h2>
          <p class="mt-2 max-w-md text-[12px] text-[var(--ink-mute)]">
            Sends an email with a magic link. The invitee sets their password and accepts the
            role; the link expires in 7 days.
          </p>
        </div>
        <button
          type="button"
          onclick={close}
          class="ml-4 text-[var(--ink-mute)] hover:text-[var(--ink)] text-lg leading-none"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <form class="space-y-5 px-7 py-6" onsubmit={submit}>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Name</span>
          <input
            type="text"
            required
            minlength="2"
            maxlength="120"
            bind:value={name}
            placeholder="e.g. Pat Treasurer"
            class="sl-input mt-2"
          />
        </label>

        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
          <input
            type="email"
            required
            maxlength="254"
            bind:value={email}
            placeholder="pat@example.org"
            class="sl-input mt-2"
          />
        </label>

        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Role</span>
          <select bind:value={roleCode} class="sl-select mt-2">
            <option value="support_admin">support_admin — read-only across tenants</option>
            <option value="billing_admin">billing_admin — Stripe / subscriptions (Phase 10)</option>
            <option value="region_curator">region_curator — regions reference list</option>
          </select>
        </label>

        <label class="flex items-start gap-3 rounded-md border border-[var(--rule)] bg-[var(--paper-soft)] px-3 py-2.5">
          <input type="checkbox" bind:checked={superAdmin} class="mt-0.5" />
          <span class="text-[13px] text-[var(--ink-soft)]">
            Also promote to <strong class="text-[var(--ink)]">super-admin</strong> on accept.
            <span class="block text-[11.5px] text-[var(--ink-mute)]">
              Use sparingly — super-admin sees everything across every tenant.
            </span>
          </span>
        </label>

        {#if errorMsg}
          <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
            {errorMsg}
          </p>
        {/if}

        <div class="flex justify-end gap-2 border-t border-[var(--rule)] pt-5">
          <button type="button" onclick={close} disabled={submitting} class="sl-btn sl-btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={submitting} class="sl-btn sl-btn-primary">
            {submitting ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
