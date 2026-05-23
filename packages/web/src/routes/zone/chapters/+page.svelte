<!-- packages/web/src/routes/zone/chapters/+page.svelte -->
<!-- Zonal chapter register with chapter creation for zone-level administrators. -->
<!-- Exists as the main zonal dashboard entry point for managing churches in a zone. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/+layout.svelte, packages/api/src/routes/tenant.ts, packages/web/src/routes/church/overview/+page.svelte -->

<script lang="ts">
  import { setActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError } from "$lib/api";
  import { INVITABLE_CHAPTER_ROLE_OPTIONS } from "$lib/role-options";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
    groupId: string | null;
    activeMemberCount: number;
  };
  type GroupRow = { id: string; slug: string; name: string };
  type ChapterInviteRow = {
    id: number;
    email: string;
    roleCode: string;
  };
  type ChapterCreateResponse = {
    chapter: Pick<Chapter, "id" | "referenceCode" | "name">;
  };

  const adminRoles = new Set(["zone_owner", "zone_admin"]);

  let chapters = $state<Chapter[]>([]);
  let groups = $state<GroupRow[]>([]);
  let auth = $state<AuthorizedContext | null>(null);
  let assignGroupSelection = $state<Record<string, string>>({});
  let assignBusyId = $state<string | null>(null);
  let assignErrorById = $state<Record<string, string>>({});
  let createGroupId = $state("");
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let createOpen = $state(false);
  let name = $state("");
  let countryCode = $state("");
  let dateFrom = $state("");
  let inviteRows = $state<ChapterInviteRow[]>([]);
  let nextInviteRowId = $state(1);
  let createdChapter = $state<ChapterCreateResponse["chapter"] | null>(null);
  let creating = $state(false);
  let createError = $state<string | null>(null);
  let createFlash = $state<string | null>(null);

  const canCreate = $derived(
    auth?.isPlatformAdmin === true || auth?.roleCodes.some((role) => adminRoles.has(role)) === true,
  );
  const groupNameById = $derived(new Map(groups.map((g) => [g.id, g.name])));
  const hasGroups = $derived(groups.length > 0);

  async function assignGroup(chapterId: string) {
    const groupId = assignGroupSelection[chapterId];
    if (!groupId) return;
    assignBusyId = chapterId;
    assignErrorById = { ...assignErrorById, [chapterId]: "" };
    try {
      await api.patch(`/api/tenant/chapters/${chapterId}`, { groupId });
      await refresh();
      assignGroupSelection = { ...assignGroupSelection, [chapterId]: "" };
    } catch (err) {
      let msg = err instanceof ApiError ? err.message : "Could not assign group.";
      if (err instanceof ApiError && err.code === "use_move_group") {
        msg = "Groups are enabled — use the move-group action on the chapter detail page.";
      }
      assignErrorById = { ...assignErrorById, [chapterId]: msg };
    } finally {
      assignBusyId = null;
    }
  }

  function addInviteRow() {
    inviteRows = [
      ...inviteRows,
      { id: nextInviteRowId, email: "", roleCode: "chapter_admin" },
    ];
    nextInviteRowId += 1;
  }

  function removeInviteRow(id: number) {
    inviteRows = inviteRows.filter((row) => row.id !== id);
  }

  function resetCreateForm() {
    name = "";
    countryCode = "";
    dateFrom = "";
    createGroupId = "";
    inviteRows = [];
    nextInviteRowId = 1;
    createdChapter = null;
  }

  function toggleCreate() {
    if (createOpen) {
      createOpen = false;
      createError = null;
      createFlash = null;
      resetCreateForm();
      return;
    }
    createOpen = true;
  }

  async function refresh() {
    loading = true;
    try {
      const [chapterRes, meRes, groupsRes] = await Promise.all([
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me"),
        api.get<{ items: GroupRow[] }>("/api/tenant/groups"),
      ]);
      chapters = chapterRes.items;
      auth = meRes.auth;
      groups = groupsRes.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load chapters.";
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
      const result =
        createdChapter === null
          ? await api.post<ChapterCreateResponse>("/api/tenant/chapters", {
              name,
              countryCode: countryCode.trim() ? countryCode.trim().toUpperCase() : undefined,
              dateFrom: dateFrom || undefined,
              groupId: createGroupId || undefined,
            })
          : { chapter: createdChapter };
      createdChapter = result.chapter;
      const invites = inviteRows
        .map((row) => ({ ...row, email: row.email.trim() }))
        .filter((row) => row.email.length > 0);
      let sentInvites = 0;
      for (const row of invites) {
        try {
          await api.post("/api/tenant/invitations", {
            email: row.email,
            roleCode: row.roleCode,
            chapterId: result.chapter.id,
          });
          sentInvites += 1;
          inviteRows = inviteRows.filter((existing) => existing.id !== row.id);
        } catch (err) {
          await refresh();
          createFlash =
            sentInvites > 0
              ? `${sentInvites} ${sentInvites === 1 ? "invitation" : "invitations"} sent.`
              : null;
          createError =
            err instanceof ApiError
              ? `${result.chapter.name} was added, but ${row.email} could not be invited: ${err.message}`
              : `${result.chapter.name} was added, but ${row.email} could not be invited.`;
          return;
        }
      }
      const inviteText =
        sentInvites === 0
          ? "Chapter added."
          : `Chapter added and ${sentInvites} ${sentInvites === 1 ? "invitation" : "invitations"} sent.`;
      resetCreateForm();
      createOpen = false;
      createFlash = inviteText;
      await refresh();
    } catch (err) {
      createError =
        err instanceof ApiError
          ? err.message
          : "Could not add chapter or send administrator invitations.";
    } finally {
      creating = false;
    }
  }

  function openChapterDashboard(event: MouseEvent, chapter: Chapter) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    setActiveChapter(chapter.id);
  }

  function chapterDashboardHref(chapter: Chapter): string {
    const qs = new URLSearchParams({
      chapterId: chapter.id,
      chapterName: chapter.name,
    });
    return `/church/overview?${qs.toString()}`;
  }
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ I · Church administration</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Chapters <span class="sl-serif-italic font-light text-[var(--brass-deep)]">register</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        {#if loading}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {:else}
          {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"} on file
        {/if}
      </p>
    </div>
    {#if canCreate}
      <button type="button" class="sl-btn sl-btn-primary" onclick={toggleCreate}>
        {#if createOpen}
          Cancel
        {:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          </svg>
          New chapter
        {/if}
      </button>
    {/if}
  </div>

  {#if createOpen}
    <form class="sl-reveal sl-card-warm mt-6 grid grid-cols-12 gap-3 p-6" onsubmit={create}>
      {#if createdChapter}
        <p class="col-span-12 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">
          {createdChapter.name} has been added. Fix the remaining invitations and retry.
        </p>
      {/if}
      <label class="col-span-12 sm:col-span-5">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter name</span>
        <input type="text" required minlength="2" maxlength="120" bind:value={name} disabled={createdChapter !== null} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Country</span>
        <input type="text" maxlength="2" bind:value={countryCode} disabled={createdChapter !== null} placeholder="GB" class="sl-input mt-1.5 uppercase" />
      </label>
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Active since</span>
        <input type="date" bind:value={dateFrom} disabled={createdChapter !== null} class="sl-input mt-1.5" />
      </label>
      {#if hasGroups}
        <label class="col-span-12 sm:col-span-5">
          <span class="sl-eyebrow" style="font-size:10.5px">Group</span>
          <select bind:value={createGroupId} disabled={createdChapter !== null} class="sl-select mt-1.5">
            <option value="">(No group)</option>
            {#each groups as g (g.id)}
              <option value={g.id}>{g.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      <div class="col-span-12 flex items-end sm:col-span-2">
        <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">
          {#if creating}
            {createdChapter ? "Retrying…" : "Adding…"}
          {:else}
            {createdChapter ? "Retry invites" : "Add"}
          {/if}
        </button>
      </div>
      <div class="col-span-12 mt-2 border-t border-[var(--rule)] pt-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span class="sl-eyebrow" style="font-size:10.5px">Chapter administrators</span>
            <p class="mt-1 text-[13px] text-[var(--ink-mute)]">
              Send one or more chapter-scoped invitations as soon as this chapter is created.
            </p>
          </div>
          <button type="button" class="sl-btn sl-btn-ghost" onclick={addInviteRow}>+ Add administrator</button>
        </div>
        {#if inviteRows.length > 0}
          <div class="mt-4 space-y-3">
            {#each inviteRows as row (row.id)}
              <div class="grid grid-cols-12 gap-3">
                <label class="col-span-12 sm:col-span-6">
                  <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
                  <input type="email" bind:value={row.email} placeholder="admin@example.com" class="sl-input mt-1.5" />
                </label>
                <label class="col-span-8 sm:col-span-4">
                  <span class="sl-eyebrow" style="font-size:10.5px">Role</span>
                  <select bind:value={row.roleCode} class="sl-select mt-1.5">
                    {#each INVITABLE_CHAPTER_ROLE_OPTIONS as role}
                      <option value={role.value}>{role.label}</option>
                    {/each}
                  </select>
                </label>
                <div class="col-span-4 flex items-end sm:col-span-2">
                  <button type="button" class="sl-btn sl-btn-ghost w-full justify-center" onclick={() => removeInviteRow(row.id)}>
                    Remove
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
      {#if createError}
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
      {/if}
    </form>
  {:else if !loading && !canCreate}
    <p class="mt-6 text-[13px] text-[var(--ink-mute)]">
      Chapter creation is available to zone owners and zone admins.
    </p>
  {/if}

  {#if createFlash}
    <p class="mt-6 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">{createFlash}</p>
  {/if}
  {#if createError && !createOpen}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
  {/if}

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if loading}
    <div class="mt-10 sl-card p-12 text-center text-[var(--ink-mute)]">
      <span class="sl-mono text-[12px]" style="letter-spacing:0.16em">LOADING CHAPTERS…</span>
    </div>
  {:else if chapters.length === 0}
    <div class="sl-reveal mt-10 sl-card flex flex-col items-center justify-center p-16 text-center">
      <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">∅</span>
      <p class="mt-4 sl-display text-[18px] italic text-[var(--ink)]">No chapters yet.</p>
      <p class="mt-2 text-[13px] text-[var(--ink-mute)]">Add the first one above.</p>
    </div>
  {:else}
    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Roster</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {chapters.length} {chapters.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Name</th>
              {#if hasGroups}<th>Group</th>{/if}
              <th>Country</th>
              <th>Members</th>
              <th>Active since</th>
              <th>Created</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {#each chapters as chapter (chapter.id)}
              <tr>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">{chapter.referenceCode}</td>
                <td>
                  <a href={`/zone/chapters/${chapter.id}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                    {chapter.name}
                  </a>
                </td>
                {#if hasGroups}
                  <td class="text-[13px] text-[var(--ink)]">
                    {#if chapter.groupId}
                      {groupNameById.get(chapter.groupId) ?? "—"}
                    {:else if canCreate}
                      <div class="flex flex-wrap items-center gap-2">
                        <select
                          bind:value={assignGroupSelection[chapter.id]}
                          class="sl-select py-1 text-[12px]"
                          disabled={assignBusyId === chapter.id}
                        >
                          <option value="">(Assign group…)</option>
                          {#each groups as g (g.id)}
                            <option value={g.id}>{g.name}</option>
                          {/each}
                        </select>
                        <button
                          type="button"
                          class="sl-btn sl-btn-ghost"
                          disabled={!assignGroupSelection[chapter.id] || assignBusyId === chapter.id}
                          onclick={() => assignGroup(chapter.id)}
                        >
                          {assignBusyId === chapter.id ? "Saving…" : "Assign"}
                        </button>
                        {#if assignErrorById[chapter.id]}
                          <span class="basis-full text-[12px] text-[var(--bad)]">{assignErrorById[chapter.id]}</span>
                        {/if}
                      </div>
                    {:else}
                      —
                    {/if}
                  </td>
                {/if}
                <td class="sl-mono text-[12px] uppercase text-[var(--ink-soft)]">{chapter.countryCode ?? "—"}</td>
                <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{chapter.activeMemberCount}</td>
                <td class="sl-mono text-[12px] text-[var(--ink-soft)]">
                  {new Date(chapter.dateFrom).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  {new Date(chapter.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
                <td class="text-right">
                  <a
                    href={chapterDashboardHref(chapter)}
                    class="sl-btn sl-btn-ghost justify-center"
                    onclick={(event) => openChapterDashboard(event, chapter)}
                  >Dashboard</a>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
