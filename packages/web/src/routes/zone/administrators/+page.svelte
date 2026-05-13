<!-- packages/web/src/routes/zone/administrators/+page.svelte -->
<!-- Zone-level administrator invitation and assignment screen. -->
<!-- Exists so zone owners/admins can manage ongoing zone and chapter access outside onboarding. -->
<!-- RELEVANT FILES: packages/web/src/lib/nav.ts, packages/api/src/routes/tenant.ts, packages/web/src/routes/zone/chapters/+page.svelte -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";
  import {
    INVITABLE_CHAPTER_ROLE_OPTIONS,
    INVITABLE_ZONE_ROLE_OPTIONS,
    roleLabel,
  } from "$lib/role-options";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Chapter = { id: string; name: string; referenceCode: string };
  type AdministratorBinding = {
    bindingId: string;
    userId: string;
    email: string;
    name: string | null;
    roleId: string;
    roleCode: string;
    roleName: string;
    roleScope: "zone" | "chapter";
    chapterId: string | null;
    chapterName: string | null;
    chapterReferenceCode: string | null;
    grantedAt: string;
  };
  type Invitation = {
    id: string;
    email: string;
    roleCode: string;
    chapterId: string | null;
    expiresAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  };

  const zoneAdminRoles = new Set(["zone_owner", "zone_admin"]);

  let auth = $state<AuthorizedContext | null>(null);
  let chapters = $state<Chapter[]>([]);
  let administrators = $state<AdministratorBinding[]>([]);
  let invitations = $state<Invitation[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let rosterError = $state<string | null>(null);
  let inviteError = $state<string | null>(null);
  let inviteFlash = $state<string | null>(null);
  let email = $state("");
  let roleCode = $state("zone_admin");
  let chapterId = $state("");
  let inviting = $state(false);
  let revokingId = $state<string | null>(null);
  let revokingBindingId = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const isChapterRole = $derived(roleCode.startsWith("chapter_"));
  const canManage = $derived(
    auth?.isPlatformAdmin === true ||
      auth?.roleCodes.some((role) => zoneAdminRoles.has(role)) === true,
  );

  function chapterName(id: string | null): string {
    if (!id) return "Zone-wide";
    const chapter = chapters.find((c) => c.id === id);
    return chapter ? chapter.name : "Unknown chapter";
  }

  function bindingScope(binding: AdministratorBinding): string {
    if (binding.roleScope === "zone") return "Zone-wide";
    if (binding.chapterName) {
      return `${binding.chapterReferenceCode ?? "Chapter"} · ${binding.chapterName}`;
    }
    return "Unknown chapter";
  }

  function invitationStatus(inv: Invitation): string {
    if (inv.acceptedAt) return "Accepted";
    if (inv.revokedAt) return "Revoked";
    return `Expires ${new Date(inv.expiresAt).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })}`;
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  function flash(message: string) {
    inviteFlash = message;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      inviteFlash = null;
      flashTimer = null;
    }, 4000);
  }

  async function refresh() {
    loading = true;
    try {
      const [chapterRes, meRes] = await Promise.all([
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me"),
      ]);
      chapters = chapterRes.items;
      auth = meRes.auth;
      if (
        meRes.auth.isPlatformAdmin === true ||
        meRes.auth.roleCodes.some((role) => zoneAdminRoles.has(role))
      ) {
        const [adminRes, invitationRes] = await Promise.all([
          api.get<{ items: AdministratorBinding[] }>("/api/tenant/administrators"),
          api.get<{ items: Invitation[] }>("/api/tenant/invitations"),
        ]);
        administrators = adminRes.items;
        invitations = invitationRes.items;
      } else {
        administrators = [];
        invitations = [];
      }
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load administrators.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
  });

  async function revokeBinding(binding: AdministratorBinding) {
    if (!confirm(`Remove ${binding.roleName} access from ${binding.email}?`)) return;
    revokingBindingId = binding.bindingId;
    rosterError = null;
    try {
      await api.delete(`/api/tenant/administrators/${binding.bindingId}`);
      administrators = administrators.filter((row) => row.bindingId !== binding.bindingId);
      flash("Administrator access revoked.");
    } catch (err) {
      rosterError = err instanceof ApiError ? err.message : "Could not revoke administrator access.";
    } finally {
      revokingBindingId = null;
    }
  }

  async function sendInvite(e: SubmitEvent) {
    e.preventDefault();
    inviteError = null;
    inviting = true;
    try {
      await api.post("/api/tenant/invitations", {
        email: email.trim(),
        roleCode,
        chapterId: isChapterRole ? chapterId : undefined,
      });
      email = "";
      flash("Invitation sent.");
      await refresh();
    } catch (err) {
      inviteError = err instanceof ApiError ? err.message : "Could not send invitation.";
    } finally {
      inviting = false;
    }
  }

  async function revoke(inv: Invitation) {
    if (!confirm(`Revoke invitation to ${inv.email}?`)) return;
    revokingId = inv.id;
    inviteError = null;
    try {
      await api.post(`/api/tenant/invitations/${inv.id}/revoke`, {});
      invitations = invitations.map((row) =>
        row.id === inv.id ? { ...row, revokedAt: new Date().toISOString() } : row,
      );
      flash("Invitation revoked.");
    } catch (err) {
      inviteError = err instanceof ApiError ? err.message : "Could not revoke invitation.";
    } finally {
      revokingId = null;
    }
  }
</script>

<svelte:head><title>Administrators · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ I · Access control</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Administrators <span class="sl-serif-italic font-light text-[var(--brass-deep)]">and roles</span>
      </h1>
      <p class="mt-2 max-w-2xl text-[14px] leading-6 text-[var(--ink-mute)]">
        Review active access, invite zone administrators, or assign chapter administrators,
        treasurers, bookkeepers, and viewers to a church.
      </p>
    </div>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if loading}
    <div class="mt-10 sl-card p-12 text-center text-[var(--ink-mute)]">
      <span class="sl-mono text-[12px]" style="letter-spacing:0.16em">LOADING ADMINISTRATORS...</span>
    </div>
  {:else if !canManage}
    <p class="mt-6 text-[13px] text-[var(--ink-mute)]">
      Administrator management is available to zone owners and zone admins.
    </p>
  {:else}
    <form class="sl-reveal sl-reveal-2 sl-card-warm mt-8 grid grid-cols-12 gap-3 p-6" onsubmit={sendInvite}>
      <label class="col-span-12 md:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
        <input
          type="email"
          required
          bind:value={email}
          placeholder="administrator@example.com"
          class="sl-input mt-1.5"
        />
      </label>
      <label class="col-span-12 sm:col-span-6 md:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Role</span>
        <select bind:value={roleCode} class="sl-select mt-1.5">
          <optgroup label="Zone-wide">
            {#each INVITABLE_ZONE_ROLE_OPTIONS as role}
              <option value={role.value}>{role.label}</option>
            {/each}
          </optgroup>
          <optgroup label="Chapter">
            {#each INVITABLE_CHAPTER_ROLE_OPTIONS as role}
              <option value={role.value}>{role.label}</option>
            {/each}
          </optgroup>
        </select>
      </label>
      {#if isChapterRole}
        <label class="col-span-12 sm:col-span-6 md:col-span-3">
          <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
          <select required bind:value={chapterId} class="sl-select mt-1.5">
            <option value="" disabled>Select chapter</option>
            {#each chapters as chapter (chapter.id)}
              <option value={chapter.id}>{chapter.referenceCode} · {chapter.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      <div class="col-span-12 flex items-end md:col-span-2">
        <button type="submit" disabled={inviting || (isChapterRole && !chapterId)} class="sl-btn sl-btn-primary w-full justify-center">
          {inviting ? "Sending..." : "Send invite"}
        </button>
      </div>
      {#if inviteError}
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{inviteError}</p>
      {/if}
      {#if inviteFlash}
        <p class="col-span-12 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">{inviteFlash}</p>
      {/if}
    </form>

    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Active access</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {administrators.length} {administrators.length === 1 ? "binding" : "bindings"}
        </span>
      </div>
      {#if rosterError}
        <p class="mb-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{rosterError}</p>
      {/if}
      {#if administrators.length === 0}
        <div class="sl-card p-12 text-center text-[13px] text-[var(--ink-mute)]">
          No active administrator bindings found.
        </div>
      {:else}
        <div class="sl-card overflow-hidden">
          <table class="sl-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Scope</th>
                <th>Granted</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {#each administrators as binding (binding.bindingId)}
                <tr>
                  <td>
                    <p class="text-[13px] text-[var(--ink)]">{binding.email}</p>
                    {#if binding.name}
                      <p class="mt-0.5 text-[12px] text-[var(--ink-mute)]">{binding.name}</p>
                    {/if}
                  </td>
                  <td class="text-[13px] text-[var(--ink-soft)]">{binding.roleName}</td>
                  <td class="text-[13px] text-[var(--ink-soft)]">{bindingScope(binding)}</td>
                  <td class="sl-mono text-[11.5px] uppercase text-[var(--ink-mute)]">{formatDate(binding.grantedAt)}</td>
                  <td class="text-right">
                    <button
                      type="button"
                      class="sl-btn sl-btn-ghost"
                      disabled={revokingBindingId === binding.bindingId}
                      onclick={() => revokeBinding(binding)}
                    >
                      {revokingBindingId === binding.bindingId ? "Removing..." : "Remove"}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <div class="sl-reveal sl-reveal-4 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Invitations</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {invitations.length} {invitations.length === 1 ? "row" : "rows"}
        </span>
      </div>
      {#if invitations.length === 0}
        <div class="sl-card p-12 text-center text-[13px] text-[var(--ink-mute)]">
          No administrator invitations have been sent yet.
        </div>
      {:else}
        <div class="sl-card overflow-hidden">
          <table class="sl-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Scope</th>
                <th>Status</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {#each invitations as inv (inv.id)}
                <tr>
                  <td class="text-[13px] text-[var(--ink)]">{inv.email}</td>
                  <td class="text-[13px] text-[var(--ink-soft)]">{roleLabel(inv.roleCode)}</td>
                  <td class="text-[13px] text-[var(--ink-soft)]">{chapterName(inv.chapterId)}</td>
                  <td class="sl-mono text-[11.5px] uppercase text-[var(--ink-mute)]">{invitationStatus(inv)}</td>
                  <td class="text-right">
                    {#if !inv.acceptedAt && !inv.revokedAt}
                      <button
                        type="button"
                        class="sl-btn sl-btn-ghost"
                        disabled={revokingId === inv.id}
                        onclick={() => revoke(inv)}
                      >
                        {revokingId === inv.id ? "Revoking..." : "Revoke"}
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
  {/if}
</div>
