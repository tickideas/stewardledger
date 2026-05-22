<!-- packages/web/src/routes/zone/groups/+page.svelte -->
<!-- Zonal group register: list, inline create, soft-delete. -->
<!-- Mirrors /zone/chapters for styling; admin-only writes are gated client-side and server-side. -->
<!-- RELEVANT FILES: packages/api/src/routes/tenant-groups.ts, packages/web/src/routes/zone/chapters/+page.svelte -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Group = {
    id: string;
    slug: string;
    name: string;
    createdAt: string;
    chapterCount: number;
  };
  type GroupCreateResponse = {
    group: { id: string; slug: string; name: string; createdAt: string };
  };

  const adminRoles = new Set(["zone_owner", "zone_admin"]);

  let groups = $state<Group[]>([]);
  let auth = $state<AuthorizedContext | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let createOpen = $state(false);
  let name = $state("");
  let slug = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);
  let createFlash = $state<string | null>(null);
  let rowError = $state<string | null>(null);
  let deletingId = $state<string | null>(null);

  const canManage = $derived(
    auth?.isPlatformAdmin === true || auth?.roleCodes.some((role) => adminRoles.has(role)) === true,
  );

  function toggleCreate() {
    if (createOpen) {
      createOpen = false;
      createError = null;
      name = "";
      slug = "";
      return;
    }
    createOpen = true;
  }

  async function refresh() {
    loading = true;
    try {
      const [groupRes, meRes] = await Promise.all([
        api.get<{ items: Group[] }>("/api/tenant/groups"),
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me"),
      ]);
      groups = groupRes.items;
      auth = meRes.auth;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load groups.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    createError = null;
    createFlash = null;
    creating = true;
    try {
      const result = await api.post<GroupCreateResponse>("/api/tenant/groups", {
        name: name.trim(),
        slug: slug.trim(),
      });
      createFlash = `${result.group.name} added.`;
      name = "";
      slug = "";
      createOpen = false;
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create group.";
    } finally {
      creating = false;
    }
  }

  async function remove(group: Group) {
    if (group.chapterCount > 0) return;
    if (!confirm(`Delete group "${group.name}"?`)) return;
    rowError = null;
    deletingId = group.id;
    try {
      await api.delete(`/api/tenant/groups/${group.id}`);
      await refresh();
    } catch (err) {
      rowError = err instanceof ApiError ? err.message : "Could not delete group.";
    } finally {
      deletingId = null;
    }
  }
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ I · Church administration</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Groups <span class="sl-serif-italic font-light text-[var(--brass-deep)]">register</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        {#if loading}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {:else}
          {groups.length} {groups.length === 1 ? "group" : "groups"} on file
        {/if}
      </p>
    </div>
    {#if canManage}
      <button type="button" class="sl-btn sl-btn-primary" onclick={toggleCreate}>
        {#if createOpen}
          Cancel
        {:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          </svg>
          New group
        {/if}
      </button>
    {/if}
  </div>

  {#if createOpen}
    <form class="sl-reveal sl-card-warm mt-6 grid grid-cols-12 gap-3 p-6" onsubmit={create}>
      <label class="col-span-12 sm:col-span-6">
        <span class="sl-eyebrow" style="font-size:10.5px">Group name</span>
        <input type="text" required minlength="2" maxlength="120" bind:value={name} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Slug</span>
        <input type="text" required minlength="2" maxlength="64" bind:value={slug} placeholder="north-region" class="sl-input mt-1.5" />
      </label>
      <div class="col-span-12 flex items-end sm:col-span-2">
        <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">
          {creating ? "Adding…" : "Create"}
        </button>
      </div>
      {#if createError}
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
      {/if}
    </form>
  {:else if !loading && !canManage}
    <p class="mt-6 text-[13px] text-[var(--ink-mute)]">
      Group management is available to zone owners and zone admins.
    </p>
  {/if}

  {#if createFlash}
    <p class="mt-6 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">{createFlash}</p>
  {/if}
  {#if rowError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{rowError}</p>
  {/if}

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if loading}
    <div class="mt-10 sl-card p-12 text-center text-[var(--ink-mute)]">
      <span class="sl-mono text-[12px]" style="letter-spacing:0.16em">LOADING GROUPS…</span>
    </div>
  {:else if groups.length === 0}
    <div class="sl-reveal mt-10 sl-card flex flex-col items-center justify-center p-16 text-center">
      <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">∅</span>
      <p class="mt-4 sl-display text-[18px] italic text-[var(--ink)]">No groups yet.</p>
      <p class="mt-2 text-[13px] text-[var(--ink-mute)]">Create the first one above.</p>
    </div>
  {:else}
    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Roster</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {groups.length} {groups.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Chapters</th>
              <th>Created</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {#each groups as group (group.id)}
              <tr>
                <td>
                  <a href={`/zone/groups/${group.id}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                    {group.name}
                  </a>
                </td>
                <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{group.slug}</td>
                <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{group.chapterCount}</td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  {new Date(group.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
                <td class="text-right">
                  {#if canManage}
                    <button
                      type="button"
                      class="sl-btn sl-btn-ghost justify-center"
                      disabled={group.chapterCount > 0 || deletingId === group.id}
                      title={group.chapterCount > 0 ? "Group still has chapters" : undefined}
                      onclick={() => remove(group)}
                    >
                      {deletingId === group.id ? "Deleting…" : "Delete"}
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
