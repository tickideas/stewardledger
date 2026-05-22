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

  $effect(() => {
    if (!open) {
      email = "";
      roleCode = "support_admin";
      submitting = false;
      errorMsg = null;
    }
  });

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

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
    <div class="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
      <div class="flex items-start justify-between">
        <h2 class="text-lg font-semibold text-slate-900">Grant role to existing user</h2>
        <button
          type="button"
          class="text-slate-400 hover:text-slate-700"
          aria-label="Close"
          onclick={() => (open = false)}
        >×</button>
      </div>
      <p class="mt-1 text-sm text-slate-500">
        Adds a platform role to a user who already has an account. The change takes effect at
        their next sign-in.
      </p>
      <form class="mt-4 space-y-3" onsubmit={submit}>
        <label class="block">
          <span class="text-sm font-medium text-slate-700">User email</span>
          <input
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            type="email"
            required
            maxlength="254"
            bind:value={email}
          />
        </label>
        <label class="block">
          <span class="text-sm font-medium text-slate-700">Role</span>
          <select
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            bind:value={roleCode}
          >
            <option value="support_admin">support_admin (read-only across tenants)</option>
            <option value="billing_admin">billing_admin (Stripe / subscriptions — Phase 10)</option>
            <option value="region_curator">region_curator (regions reference list)</option>
          </select>
        </label>
        {#if errorMsg}
          <p class="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-sm text-rose-700">
            {errorMsg}
          </p>
        {/if}
        <div class="mt-2 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            onclick={() => (open = false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={submitting}
          >
            {submitting ? "Granting…" : "Grant role"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
