<!-- packages/web/src/routes/admin/administrators/invite-admin-modal.svelte -->
<!-- Modal that POSTs /api/admin/administrators/invite to create a platform-admin invitation. -->
<!-- Used by /admin/administrators to onboard a new platform admin by email. -->
<!-- RELEVANT FILES: packages/web/src/routes/admin/administrators/+page.svelte, packages/api/src/routes/admin-administrators.ts -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";

  let { open = $bindable(false), oninvited } = $props<{
    open?: boolean;
    oninvited?: (invitationId: string) => void;
  }>();

  type RoleCode = "support_admin" | "billing_admin" | "region_curator";

  let name = $state("");
  let email = $state("");
  let roleCode = $state<RoleCode>("support_admin");
  let superAdmin = $state(false);
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

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

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    submitting = true;
    errorMsg = null;
    try {
      const res = await api.post<{ invitationId: string }>(
        "/api/admin/administrators/invite",
        { name, email, roleCode, superAdmin },
      );
      open = false;
      oninvited?.(res.invitationId);
    } catch (err) {
      errorMsg = err instanceof ApiError ? err.message : "Could not send the invitation.";
    } finally {
      submitting = false;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
    <div class="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
      <div class="flex items-start justify-between">
        <h2 class="text-lg font-semibold text-slate-900">Invite administrator</h2>
        <button
          type="button"
          class="text-slate-400 hover:text-slate-700"
          aria-label="Close"
          onclick={() => (open = false)}
        >×</button>
      </div>
      <p class="mt-1 text-sm text-slate-500">
        The invitee will receive a link to set their password and accept the role.
      </p>
      <form class="mt-4 space-y-3" onsubmit={submit}>
        <label class="block">
          <span class="text-sm font-medium text-slate-700">Name</span>
          <input
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            type="text"
            required
            minlength="2"
            maxlength="120"
            bind:value={name}
          />
        </label>
        <label class="block">
          <span class="text-sm font-medium text-slate-700">Email</span>
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
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={superAdmin} />
          <span>Also promote to <strong>super-admin</strong> on accept</span>
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
            {submitting ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
