<!-- packages/web/src/routes/admin/administrators/+page.svelte -->
<!-- Platform admin management: list current administrators, grant/revoke roles, promote/demote super-admins, invite new admins. -->
<!-- Exists so super-admins can delegate platform-scope rights (support_admin, billing_admin, region_curator) without opening the DB. -->
<!-- RELEVANT FILES: packages/api/src/routes/admin-administrators.ts, packages/web/src/routes/admin/administrators/invite-admin-modal.svelte, packages/web/src/routes/admin/administrators/grant-existing-modal.svelte -->

<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";
  import InviteAdminModal from "./invite-admin-modal.svelte";
  import GrantExistingModal from "./grant-existing-modal.svelte";

  type Administrator = {
    userId: string;
    email: string;
    name: string | null;
    isSuperAdmin: boolean;
    platformRoles: string[];
    createdAt: string;
  };
  type Invitation = {
    id: string;
    email: string;
    name: string;
    roleCode: string;
    superAdmin: boolean;
    createdAt: string;
    expiresAt: string;
  };
  type ListResponse = { items: Administrator[]; invitations: Invitation[] };

  const ROLE_LABELS: Record<string, string> = {
    super_admin: "Super admin",
    support_admin: "Support admin",
    billing_admin: "Billing admin",
    region_curator: "Region curator",
  };

  let admins = $state<Administrator[]>([]);
  let invitations = $state<Invitation[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let flash = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  let inviteOpen = $state(false);
  let grantOpen = $state(false);

  async function refresh() {
    loading = true;
    try {
      const res = await api.get<ListResponse>("/api/admin/administrators");
      admins = res.items;
      invitations = res.invitations;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load administrators.";
    } finally {
      loading = false;
    }
  }

  function showFlash(msg: string) {
    flash = msg;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      flashTimer = null;
    }, 5_000);
  }

  function onInvited() {
    showFlash("Invitation sent. The invitee can accept via the link in their email.");
    refresh();
  }
  function onGranted() {
    showFlash("Role granted. The change takes effect at the user's next sign-in.");
    refresh();
  }

  async function revokeRole(admin: Administrator, roleCode: string): Promise<void> {
    if (!confirm(`Remove the ${ROLE_LABELS[roleCode] ?? roleCode} role from ${admin.email}?`))
      return;
    try {
      await api.delete(
        `/api/admin/administrators/${encodeURIComponent(admin.userId)}/roles/${encodeURIComponent(roleCode)}`,
      );
      showFlash("Role revoked.");
      refresh();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not revoke role.");
    }
  }

  async function elevate(admin: Administrator): Promise<void> {
    if (
      !confirm(
        `Promote ${admin.email} to super-admin? They will gain full platform access.`,
      )
    )
      return;
    try {
      await api.post(
        `/api/admin/administrators/${encodeURIComponent(admin.userId)}/super-admin`,
        {},
      );
      showFlash("Promoted to super-admin.");
      refresh();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not promote.");
    }
  }

  async function demote(admin: Administrator): Promise<void> {
    if (
      !confirm(
        `Demote ${admin.email}? They will lose super-admin privileges. ` +
          `The system refuses if they are the only remaining super-admin.`,
      )
    )
      return;
    try {
      await api.delete(
        `/api/admin/administrators/${encodeURIComponent(admin.userId)}/super-admin`,
      );
      showFlash("Demoted from super-admin.");
      refresh();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not demote.");
    }
  }

  async function revokeInvitation(inv: Invitation): Promise<void> {
    if (!confirm(`Revoke the invitation to ${inv.email}?`)) return;
    try {
      await api.delete(
        `/api/admin/administrators/invitations/${encodeURIComponent(inv.id)}`,
      );
      showFlash("Invitation revoked.");
      refresh();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not revoke invitation.");
    }
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  onMount(() => {
    refresh();
    return () => {
      if (flashTimer) clearTimeout(flashTimer);
    };
  });
</script>

<div class="space-y-6">
  <header class="flex items-end justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight text-slate-900">Administrators</h1>
      <p class="mt-1 text-sm text-slate-500">
        Platform-scope identities. Super-admins manage everything; support and billing admins
        get the read-only or finance surfaces they need.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
        onclick={() => (grantOpen = true)}
      >
        Grant role to existing user
      </button>
      <button
        type="button"
        class="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        onclick={() => (inviteOpen = true)}
      >
        + Invite admin
      </button>
    </div>
  </header>

  {#if flash}
    <div class="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
      {flash}
    </div>
  {/if}
  {#if loadError}
    <div class="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
      {loadError}
    </div>
  {/if}

  <section>
    <h2 class="text-sm font-medium uppercase tracking-wide text-slate-500">Active administrators</h2>
    <div class="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table class="min-w-full divide-y divide-slate-200 text-sm">
        <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th class="px-3 py-2 font-medium">Email</th>
            <th class="px-3 py-2 font-medium">Name</th>
            <th class="px-3 py-2 font-medium">Roles</th>
            <th class="px-3 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          {#if loading && admins.length === 0}
            <tr><td class="px-3 py-4 text-slate-400" colspan="4">Loading…</td></tr>
          {:else if admins.length === 0}
            <tr><td class="px-3 py-4 text-slate-400" colspan="4">No administrators yet.</td></tr>
          {:else}
            {#each admins as admin (admin.userId)}
              <tr>
                <td class="px-3 py-2 font-mono text-[12px]">{admin.email}</td>
                <td class="px-3 py-2">{admin.name ?? "—"}</td>
                <td class="px-3 py-2">
                  <div class="flex flex-wrap gap-1">
                    {#if admin.isSuperAdmin}
                      <span class="rounded-full bg-slate-900 px-2 py-[1px] text-[11px] font-medium text-white">super_admin</span>
                    {/if}
                    {#each admin.platformRoles as roleCode (roleCode)}
                      <span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-[1px] text-[11px] text-slate-700">
                        {roleCode}
                        <button
                          type="button"
                          class="text-slate-400 hover:text-rose-700"
                          aria-label="Remove {roleCode}"
                          onclick={() => revokeRole(admin, roleCode)}
                        >×</button>
                      </span>
                    {/each}
                  </div>
                </td>
                <td class="px-3 py-2 text-right text-[12px]">
                  {#if admin.isSuperAdmin}
                    <button class="text-slate-600 hover:text-rose-700" onclick={() => demote(admin)}>
                      Demote
                    </button>
                  {:else}
                    <button class="text-slate-600 hover:text-slate-900" onclick={() => elevate(admin)}>
                      Promote to super-admin
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </section>

  {#if invitations.length > 0}
    <section>
      <h2 class="text-sm font-medium uppercase tracking-wide text-slate-500">Pending invitations</h2>
      <div class="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="px-3 py-2 font-medium">Email</th>
              <th class="px-3 py-2 font-medium">Name</th>
              <th class="px-3 py-2 font-medium">Role</th>
              <th class="px-3 py-2 font-medium">Sent</th>
              <th class="px-3 py-2 font-medium">Expires</th>
              <th class="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            {#each invitations as inv (inv.id)}
              <tr>
                <td class="px-3 py-2 font-mono text-[12px]">{inv.email}</td>
                <td class="px-3 py-2">{inv.name}</td>
                <td class="px-3 py-2">
                  {inv.roleCode}{#if inv.superAdmin} + super_admin{/if}
                </td>
                <td class="px-3 py-2 text-slate-500 text-[12px]">{fmtDate(inv.createdAt)}</td>
                <td class="px-3 py-2 text-slate-500 text-[12px]">{fmtDate(inv.expiresAt)}</td>
                <td class="px-3 py-2 text-right text-[12px]">
                  <button class="text-rose-700 hover:underline" onclick={() => revokeInvitation(inv)}>
                    Revoke
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>

<InviteAdminModal bind:open={inviteOpen} oninvited={onInvited} />
<GrantExistingModal bind:open={grantOpen} ongranted={onGranted} />
