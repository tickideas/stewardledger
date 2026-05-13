<!-- packages/web/src/routes/zone/members/+page.svelte -->
<!-- Zonal member directory with chapter filtering and member creation. -->
<!-- Exists so zone-level users can search and manage identities across every chapter. -->
<!-- RELEVANT FILES: packages/web/src/routes/church/members/+page.svelte, packages/api/src/routes/tenant-members.ts, packages/web/src/routes/zone/chapters/+page.svelte -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";
  import { page } from "$app/state";
  import MemberBulkAdd from "./member-bulk-add.svelte";
  import MemberProfileFields from "./member-profile-fields.svelte";

  type Member = {
    id: string;
    referenceCode: string;
    firstName: string;
    middleNames: string | null;
    lastName: string | null;
    fullName: string | null;
    titleName: string | null;
    email: string | null;
    mobile: string | null;
    chapterId: string | null;
    isActive: boolean;
    createdAt: string;
  };

  type Chapter = { id: string; name: string };
  type Lookup = { id: string; name: string; isActive: boolean; gender?: string | null };

  let q = $state("");
  let chapterId = $state("");
  let items = $state<Member[]>([]);
  let chapters = $state<Chapter[]>([]);
  let titles = $state<Lookup[]>([]);
  let total = $state<number | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  let createOpen = $state(false);
  let bulkOpen = $state(false);
  let profileFieldsOpen = $state(false);
  let cTitle = $state("");
  let cFirst = $state("");
  let cLast = $state("");
  let cEmail = $state("");
  let cChapter = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  function memberDisplayName(member: Member): string {
    const name = member.fullName || `${member.firstName} ${member.lastName ?? ""}`.trim();
    return member.titleName ? `${member.titleName} ${name}` : name;
  }

  async function refresh() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (chapterId) params.set("chapterId", chapterId);
      const res = await api.get<{ items: Member[] }>(`/api/tenant/members?${params.toString()}`);
      items = res.items;
      total = res.items.length;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load members.";
    } finally {
      loading = false;
    }
  }

  async function loadChapters() {
    try {
      const res = await api.get<{ items: Chapter[] }>("/api/tenant/chapters");
      chapters = res.items;
    } catch {
      chapters = [];
    }
  }

  async function loadTitles() {
    try {
      const res = await api.get<{ items: Lookup[] }>("/api/tenant/lookups/titles");
      titles = res.items.filter((title) => title.isActive);
    } catch {
      titles = [];
    }
  }

  $effect(() => {
    loadChapters();
    loadTitles();
    refresh();
  });

  $effect(() => {
    if (page.url.searchParams.get("panel") === "profile-fields") {
      profileFieldsOpen = true;
    }
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    createError = null;
    creating = true;
    try {
      await api.post("/api/tenant/members", {
        titleId: cTitle || undefined,
        firstName: cFirst,
        lastName: cLast || undefined,
        email: cEmail || undefined,
        chapterId: cChapter || undefined,
      });
      cTitle = "";
      cFirst = "";
      cLast = "";
      cEmail = "";
      cChapter = "";
      createOpen = false;
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create member.";
    } finally {
      creating = false;
    }
  }
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ II · Identities</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Members <span class="sl-serif-italic font-light text-[var(--brass-deep)]">directory</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        {#if total !== null}
          {total} {total === 1 ? "member" : "members"} indexed across all chapters
        {:else}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {/if}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button type="button" class="sl-btn sl-btn-ghost" onclick={() => (profileFieldsOpen = !profileFieldsOpen)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 4h8M3 7h8M3 10h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        Profile fields
      </button>
      <button type="button" class="sl-btn sl-btn-ghost" onclick={() => (bulkOpen = !bulkOpen)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 3.5h8M3 7h8M3 10.5h5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        Bulk add
      </button>
      <button type="button" class="sl-btn sl-btn-primary" onclick={() => (createOpen = !createOpen)}>
        {#if createOpen}Cancel{:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          </svg>
          New member
        {/if}
      </button>
    </div>
  </div>

  {#if profileFieldsOpen}
    <MemberProfileFields onClose={() => (profileFieldsOpen = false)} />
  {/if}

  {#if bulkOpen}
    <MemberBulkAdd
      {chapters}
      {titles}
      onComplete={refresh}
      onClose={() => (bulkOpen = false)}
    />
  {/if}

  {#if createOpen}
    <form class="sl-reveal sl-card-warm mt-6 grid grid-cols-12 gap-3 p-6" onsubmit={create}>
      <label class="col-span-12 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Title</span>
        <select bind:value={cTitle} class="sl-select mt-1.5">
          <option value="">None</option>
          {#each titles as title (title.id)}
            <option value={title.id}>{title.name}{title.gender ? ` (${title.gender})` : ""}</option>
          {/each}
        </select>
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">First name</span>
        <input type="text" required minlength="1" maxlength="120" bind:value={cFirst} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Last name</span>
        <input type="text" maxlength="120" bind:value={cLast} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
        <input type="email" bind:value={cEmail} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
        <select bind:value={cChapter} class="sl-select mt-1.5">
          <option value="">None</option>
          {#each chapters as ch}<option value={ch.id}>{ch.name}</option>{/each}
        </select>
      </label>
      <div class="col-span-12 flex items-end sm:col-span-1">
        <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">Add</button>
      </div>
      {#if createError}
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
      {/if}
    </form>
  {/if}

  <!-- Filters -->
  <div class="sl-reveal sl-reveal-2 mt-8 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,1fr)_14rem_auto] lg:items-center">
    <div class="relative min-w-0">
      <svg class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ink-mute)]" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.25"/>
        <path d="M9 9l3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <input
        type="search"
        bind:value={q}
        placeholder="Search name, email, code…"
        onkeydown={(e) => e.key === "Enter" && refresh()}
        class="sl-input pr-9"
      />
    </div>
    <select bind:value={chapterId} onchange={refresh} class="sl-select">
      <option value="">All chapters</option>
      {#each chapters as ch}<option value={ch.id}>{ch.name}</option>{/each}
    </select>
    <button class="sl-btn sl-btn-ghost justify-center" onclick={refresh}>Search</button>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else}
    <div class="sl-reveal sl-reveal-3 mt-8">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Index of members</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {items.length} {items.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Email</th>
              <th>Mobile</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each items as m}
              <tr>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">{m.referenceCode}</td>
                <td>
                  <a href={`/zone/members/${m.id}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                    {memberDisplayName(m)}
                  </a>
                </td>
                <td class="text-[var(--ink-soft)]">{m.email ?? "—"}</td>
                <td class="text-[var(--ink-soft)] sl-mono text-[12px]">{m.mobile ?? "—"}</td>
                <td>
                  {#if m.isActive}
                    <span class="sl-badge sl-badge-ok">active</span>
                  {:else}
                    <span class="sl-badge sl-badge-mute">inactive</span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if !loading && items.length === 0}
              <tr>
                <td colspan="5" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                  No members yet. Add one above or import in bulk.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
