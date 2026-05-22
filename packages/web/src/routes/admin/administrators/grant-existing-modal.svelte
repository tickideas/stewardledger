<!-- packages/web/src/routes/admin/administrators/grant-existing-modal.svelte -->
<!-- Grant a platform role to an existing user by email (no invitation). -->
<!-- Used by /admin/administrators alongside invite-admin-modal.svelte. -->
<!-- RELEVANT FILES: packages/web/src/routes/admin/administrators/+page.svelte, packages/api/src/routes/admin-administrators.ts -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";

  let { open = $bindable(false), ongranted } = $props<{
    open?: boolean;
    ongranted?: () => void;
  }>();

  type RoleCode = "support_admin" | "billing_admin" | "region_curator";

  let email = $state("");
  let roleCode = $state<RoleCode>("support_admin");
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  function close() {
    if (submitting) return;
    open = false;
  }

  $effect(() => {
    if (!open) {
      email = "";
      roleCode = "support_admin";
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
      await api.post("/api/admin/administrators/grant", { email, roleCode });
      open = false;
      ongranted?.();
    } catch (err) {
      errorMsg = err instanceof ApiError ? err.message : "Could not grant the role.";
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
      class="sl-card w-full max-w-lg"
      style="box-shadow: var(--shadow-lift)"
      role="dialog"
      aria-modal="true"
      aria-labelledby="grant-admin-title"
    >
      <div class="flex items-start justify-between border-b border-[var(--rule)] px-7 py-5">
        <div>
          <span class="sl-eyebrow">Grant role</span>
          <h2 id="grant-admin-title" class="mt-2 sl-display text-[24px] text-[var(--ink)]">
            Grant to <span class="sl-serif-italic text-[var(--brass-deep)]">existing user</span>
          </h2>
          <p class="mt-2 max-w-md text-[12px] text-[var(--ink-mute)]">
            Adds a platform role to a user who already has an account. The change takes effect
            at their next sign-in.
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
          <span class="sl-eyebrow" style="font-size:10.5px">User email</span>
          <input
            type="email"
            required
            maxlength="254"
            bind:value={email}
            placeholder="user@example.org"
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
            {submitting ? "Granting…" : "Grant role"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
