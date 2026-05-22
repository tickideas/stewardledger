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
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  onMount(() => {
    refresh();
    return () => {
      if (flashTimer) clearTimeout(flashTimer);
    };
  });
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <!-- Title block -->
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ Section III · Access</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Administrators <span class="sl-serif-italic font-light text-[var(--brass-deep)]">register</span>
      </h1>
      <p class="mt-2 max-w-xl text-[14px] text-[var(--ink-mute)]">
        Platform-scope identities. Super-admins manage everything; support and billing admins
        get the read-only or finance surfaces they need.
      </p>
    </div>
    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={() => (grantOpen = true)}
        class="sl-btn sl-btn-ghost"
      >
        Grant to existing user
      </button>
      <button type="button" onclick={() => (inviteOpen = true)} class="sl-btn sl-btn-primary">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        Invite admin
      </button>
    </div>
  </div>

  {#if flash}
    <p class="sl-reveal mt-6 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-4 py-3 text-[13px] text-[var(--ink-soft)]">
      {flash}
    </p>
  {/if}
  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-4 py-3 text-[13px] text-[var(--bad)]">
      {loadError}
    </p>
  {/if}

  <InviteAdminModal bind:open={inviteOpen} oninvited={onInvited} />
  <GrantExistingModal bind:open={grantOpen} ongranted={onGranted} />

  <!-- Active administrators -->
  <div class="sl-reveal sl-reveal-2 mt-10">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Ledger of administrators</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {admins.length} {admins.length === 1 ? "entry" : "entries"}
      </span>
    </div>

    {#if loading && admins.length === 0}
      <div class="sl-card p-12 text-center text-[13px] text-[var(--ink-mute)]">
        <span class="sl-mono" style="letter-spacing:0.16em">LOADING…</span>
      </div>
    {:else if admins.length === 0}
      <div class="sl-card p-12 text-center text-[14px] text-[var(--ink-mute)]">
        No administrators yet.
      </div>
    {:else}
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Administrator</th>
              <th>Roles</th>
              <th>Joined</th>
              <th class="!text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each admins as admin (admin.userId)}
              <tr>
                <td>
                  <div class="sl-display text-[15px] text-[var(--ink)]">{admin.name ?? "—"}</div>
                  <div class="mt-1 sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">
                    {admin.email}
                  </div>
                </td>
                <td>
                  <div class="flex flex-wrap items-center gap-1.5">
                    {#if admin.isSuperAdmin}
                      <span class="sl-badge sl-badge-accent">super_admin</span>
                    {/if}
                    {#each admin.platformRoles as roleCode (roleCode)}
                      <span class="inline-flex items-center gap-1">
                        <span class="sl-badge sl-badge-info">{roleCode}</span>
                        <button
                          type="button"
                          class="sl-link text-[12px]"
                          aria-label="Remove {roleCode}"
                          onclick={() => revokeRole(admin, roleCode)}
                        >revoke</button>
                      </span>
                    {/each}
                    {#if !admin.isSuperAdmin && admin.platformRoles.length === 0}
                      <span class="text-[var(--ink-faint)] text-[12px]">—</span>
                    {/if}
                  </div>
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  {new Date(admin.createdAt).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </td>
                <td class="text-right">
                  {#if admin.isSuperAdmin}
                    <button class="sl-link text-[12px]" onclick={() => demote(admin)}>
                      demote
                    </button>
                  {:else}
                    <button class="sl-link text-[12px]" onclick={() => elevate(admin)}>
                      promote to super-admin
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <!-- Pending invitations -->
  {#if invitations.length > 0}
    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Pending invitations</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {invitations.length} {invitations.length === 1 ? "open" : "open"}
        </span>
      </div>

      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Invitee</th>
              <th>Role</th>
              <th>Sent</th>
              <th>Expires</th>
              <th class="!text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {#each invitations as inv (inv.id)}
              <tr>
                <td>
                  <div class="sl-display text-[15px] text-[var(--ink)]">{inv.name}</div>
                  <div class="mt-1 sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">
                    {inv.email}
                  </div>
                </td>
                <td>
                  <span class="sl-badge sl-badge-info">{inv.roleCode}</span>
                  {#if inv.superAdmin}
                    <span class="ml-1 sl-badge sl-badge-accent">+ super_admin</span>
                  {/if}
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  {fmtDate(inv.createdAt)}
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  {fmtDate(inv.expiresAt)}
                </td>
                <td class="text-right">
                  <button class="sl-link text-[12px]" onclick={() => revokeInvitation(inv)}>
                    revoke
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
