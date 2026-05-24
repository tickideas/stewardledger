<!-- packages/web/src/routes/zone/groups/+page.svelte -->
<!-- Zonal "Groups directory" — searchable, paginated register with inline create + soft-delete. -->
<!-- Mirrors /zone/chapters for shape; admin-only writes are gated client-side and server-side. -->
<!-- RELEVANT FILES: packages/api/src/routes/tenant-groups.ts, packages/web/src/routes/zone/chapters/+page.svelte, packages/web/src/lib/ConfirmDialog.svelte -->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { page as pageState } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import ConfirmDialog from "$lib/ConfirmDialog.svelte";
  import { DIRECTORY_PAGE_SIZE } from "$lib/ui";
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
  type ZoneInfo = { id: string; slug: string; name: string; groupsEnabled: boolean };
  type ChapterRow = { id: string; name: string; groupId: string | null };

  const adminRoles = new Set(["zone_owner", "zone_admin"]);

  // URL-backed filter state (see /zone/chapters for the same shape).
  const initialUrl = new URL(pageState.url);
  let q = $state(initialUrl.searchParams.get("q") ?? "");
  let page = $state(Math.max(0, Number(initialUrl.searchParams.get("page") ?? "0") | 0));

  let groups = $state<Group[]>([]);
  let auth = $state<AuthorizedContext | null>(null);
  let zone = $state<ZoneInfo | null>(null);
  let unassignedChapters = $state<ChapterRow[]>([]);
  let total = $state<number | null>(null);
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
  let pendingDelete = $state<Group | null>(null);
  let enabling = $state(false);
  let enableError = $state<string | null>(null);
  let enableConfirmOpen = $state(false);

  let refreshToken = 0;
  let activeController: AbortController | null = null;

  const canManage = $derived(
    auth?.isPlatformAdmin === true || auth?.roleCodes.some((role) => adminRoles.has(role)) === true,
  );
  const isZoneOwner = $derived(
    auth?.isPlatformAdmin === true || auth?.roleCodes.includes("zone_owner") === true,
  );
  const pageCount = $derived(
    total === null ? 0 : Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE)),
  );
  const fromRow = $derived(total === null || total === 0 ? 0 : page * DIRECTORY_PAGE_SIZE + 1);
  const toRow = $derived(
    total === null ? 0 : Math.min(total, page * DIRECTORY_PAGE_SIZE + groups.length),
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

  function pushFiltersToUrl() {
    const next = new URL(pageState.url);
    if (q.trim()) next.searchParams.set("q", q.trim());
    else next.searchParams.delete("q");
    if (page > 0) next.searchParams.set("page", String(page));
    else next.searchParams.delete("page");
    if (next.search !== pageState.url.search) {
      void goto(`${next.pathname}${next.search}`, {
        replaceState: true,
        keepFocus: true,
        noScroll: true,
      });
    }
  }

  /**
   * Reload the paginated group list. `resetPage` is true on search
   * submissions; inline mutations (delete, enable-groups) and page
   * navigation keep the current page. Stale responses are dropped via
   * the `refreshToken` monotonic counter so a rapid Enter doesn't let
   * an older response overwrite a newer one.
   */
  async function refresh(resetPage = false) {
    if (resetPage) page = 0;
    pushFiltersToUrl();
    const my = ++refreshToken;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    loading = true;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", String(DIRECTORY_PAGE_SIZE));
      params.set("offset", String(page * DIRECTORY_PAGE_SIZE));
      const res = await api.get<{ items: Group[]; total: number }>(
        `/api/tenant/groups?${params.toString()}`,
        controller.signal,
      );
      if (my !== refreshToken) return;
      groups = res.items;
      total = res.total;
      loadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load groups.";
    } finally {
      if (my === refreshToken) loading = false;
    }
  }

  /**
   * One-shot load of /me, zone status, and the unassigned-chapter list
   * for the enable-groups banner. The chapters call passes no limit so
   * the API returns every chapter in scope — the banner's invariant
   * (every chapter has a group) is only honest if we see all of them.
   */
  async function loadSupporting(signal: AbortSignal) {
    try {
      const [meRes, zoneRes, chapterRes] = await Promise.all([
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me", signal),
        api.get<{ zone: ZoneInfo }>("/api/tenant/zone", signal),
        api.get<{ items: ChapterRow[]; total: number }>("/api/tenant/chapters", signal),
      ]);
      auth = meRes.auth;
      zone = zoneRes.zone;
      unassignedChapters = chapterRes.items.filter((c) => c.groupId === null);
    } catch (err) {
      if (isAbortError(err)) return;
      loadError = err instanceof ApiError ? err.message : "Could not load supporting data.";
    }
  }

  function requestEnableGroups() {
    enableError = null;
    enableConfirmOpen = true;
  }

  async function confirmEnableGroups() {
    enableConfirmOpen = false;
    enabling = true;
    try {
      await api.post("/api/tenant/zones/groups-enabled", { enabled: true });
      // Re-load both the directory and the supporting state — the zone
      // flag flipped, which changes how the banner renders.
      const controller = new AbortController();
      await loadSupporting(controller.signal);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          enableError = "Only zone_owner can enable groups.";
        } else if (err.status === 409) {
          const ids = Array.isArray(err.details?.unassignedChapterIds) ? err.details.unassignedChapterIds : null;
          enableError = ids
            ? `Cannot enable: ${ids.length} chapter(s) without a group.`
            : `Cannot enable: ${unassignedChapters.length} chapter(s) without a group.`;
        } else {
          enableError = err.message;
        }
      } else {
        enableError = "Could not enable groups.";
      }
    } finally {
      enabling = false;
    }
  }

  $effect(() => {
    const controller = new AbortController();
    void loadSupporting(controller.signal);
    void refresh();
    return () => controller.abort();
  });

  function gotoPage(next: number) {
    const target = Math.max(0, Math.min(pageCount - 1, next));
    if (target === page) return;
    page = target;
    void refresh();
  }

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
      // Clear search so the new row is guaranteed to appear on page 1.
      q = "";
      await refresh(true);
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create group.";
    } finally {
      creating = false;
    }
  }

  function requestDelete(group: Group) {
    if (group.chapterCount > 0) return;
    rowError = null;
    pendingDelete = group;
  }

  function cancelDelete() {
    if (deletingId) return;
    pendingDelete = null;
  }

  async function confirmDelete() {
    const group = pendingDelete;
    if (!group) return;
    deletingId = group.id;
    try {
      await api.delete(`/api/tenant/groups/${group.id}`);
      pendingDelete = null;
      await refresh();
    } catch (err) {
      pendingDelete = null;
      if (err instanceof ApiError && err.code === "group_not_empty") {
        const count = typeof err.details?.chapterCount === "number" ? err.details.chapterCount : group.chapterCount;
        rowError = `Cannot delete group: ${count} chapter(s) still belong to it.`;
      } else {
        rowError = err instanceof ApiError ? err.message : "Could not delete group.";
      }
    } finally {
      deletingId = null;
    }
  }
</script>

<div class="pt-2 pb-10 lg:pt-0">
  {#if zone && !zone.groupsEnabled}
    <section class="sl-card-warm mb-8 p-6">
      <h2 class="sl-display text-[20px] text-[var(--ink)]">Enable groups</h2>
      <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
        Groups let you organise chapters into administrative units. Once enabled, this cannot be undone.
      </p>
      <p class="mt-3 sl-mono text-[12px] text-[var(--ink-soft)]">
        {unassignedChapters.length} chapter(s) without a group.
      </p>
      {#if unassignedChapters.length > 0}
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          Assign every chapter to a group first. Currently {unassignedChapters.length} chapter(s) without a group: {unassignedChapters.map((c) => c.name).join(", ")}
        </p>
      {/if}
      {#if !isZoneOwner}
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">Only zone_owner can enable groups.</p>
      {/if}
      <div class="mt-4">
        <button
          type="button"
          class="sl-btn sl-btn-primary"
          disabled={enabling || unassignedChapters.length > 0 || !isZoneOwner}
          onclick={requestEnableGroups}
        >
          {enabling ? "Enabling…" : "Enable groups"}
        </button>
      </div>
      {#if enableError}
        <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{enableError}</p>
      {/if}
    </section>
  {:else if zone && zone.groupsEnabled}
    <section class="sl-card mb-8 p-6">
      <h2 class="sl-display text-[20px] text-[var(--ink)]">Groups are enabled</h2>
      <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
        All chapters in this zone are organised by group. Use the move-group action on a chapter detail page to reassign chapters between groups.
      </p>
    </section>
  {/if}

  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ I · Church administration</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Groups <span class="sl-serif-italic font-light text-[var(--brass-deep)]">directory</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        {#if total === null}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {:else}
          {total} {total === 1 ? "group" : "groups"} on file
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

  <!-- Search bar. Single text field is enough — groups have no
       chapter/group secondary axis to filter by. -->
  <div class="sl-reveal sl-reveal-2 mt-8 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,1fr)_auto] lg:items-center">
    <div class="relative min-w-0">
      <svg class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ink-mute)]" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.25"/>
        <path d="M9 9l3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <input
        type="search"
        bind:value={q}
        placeholder="Search group name or slug…"
        onkeydown={(e) => e.key === "Enter" && refresh(true)}
        class="sl-input pr-9"
      />
    </div>
    <button class="sl-btn sl-btn-ghost justify-center" onclick={() => refresh(true)}>Search</button>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if loading && groups.length === 0}
    <div class="mt-10 sl-card p-12 text-center text-[var(--ink-mute)]">
      <span class="sl-mono text-[12px]" style="letter-spacing:0.16em">LOADING GROUPS…</span>
    </div>
  {:else if total === 0 && !q}
    <div class="sl-reveal mt-10 sl-card flex flex-col items-center justify-center p-16 text-center">
      <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">∅</span>
      <p class="mt-4 sl-display text-[18px] italic text-[var(--ink)]">No groups yet.</p>
      <p class="mt-2 text-[13px] text-[var(--ink-mute)]">Create the first one above.</p>
    </div>
  {:else}
    <div class="sl-reveal sl-reveal-3 mt-8">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Index of groups</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {#if total !== null && total > 0}
            {fromRow}–{toRow} of {total}
          {:else}
            0 results
          {/if}
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
                      class="sl-btn sl-btn-danger-ghost justify-center"
                      disabled={group.chapterCount > 0 || deletingId === group.id}
                      title={group.chapterCount > 0 ? "Group still has chapters" : undefined}
                      onclick={() => requestDelete(group)}
                    >
                      {deletingId === group.id ? "Deleting…" : "Delete"}
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if !loading && groups.length === 0}
              <tr>
                <td colspan="5" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                  No groups match this search.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>

      {#if pageCount > 1}
        <div class="mt-4 flex items-center justify-between text-[12px] text-[var(--ink-mute)]">
          <span class="sl-mono" style="letter-spacing:0.06em">Page {page + 1} of {pageCount}</span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="sl-btn sl-btn-ghost"
              disabled={page === 0 || loading}
              onclick={() => gotoPage(page - 1)}
            >Previous</button>
            <button
              type="button"
              class="sl-btn sl-btn-ghost"
              disabled={page >= pageCount - 1 || loading}
              onclick={() => gotoPage(page + 1)}
            >Next</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={pendingDelete !== null}
  title={pendingDelete ? `Delete group "${pendingDelete.name}"?` : "Delete group?"}
  body="Soft-deletes the group. It will no longer appear in pickers, but historical chapter-group history is preserved in the audit log."
  confirmLabel="Delete"
  cancelLabel="Keep"
  tone="danger"
  submitting={deletingId !== null}
  onconfirm={confirmDelete}
  oncancel={cancelDelete}
/>

<ConfirmDialog
  open={enableConfirmOpen}
  title="Enable groups for this zone?"
  body="Enabling groups is one-way — once on, every new chapter requires a group. Existing chapters keep their assignment."
  confirmLabel="Enable groups"
  cancelLabel="Cancel"
  tone="danger"
  submitting={enabling}
  onconfirm={confirmEnableGroups}
  oncancel={() => (enableConfirmOpen = false)}
/>
