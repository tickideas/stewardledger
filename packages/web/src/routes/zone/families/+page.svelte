<!-- packages/web/src/routes/zone/families/+page.svelte -->
<!-- Zonal household register with chapter filter and create form. -->
<!-- Exists so zone-level admins can list and create households across chapters. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/families/[id]/+page.svelte, packages/web/src/routes/church/families/+page.svelte, packages/api/src/routes/tenant-families.ts -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";

  type FamilyRow = {
    id: string;
    referenceCode: string;
    name: string;
    chapterId: string;
    chapterName: string;
    memberCount: number;
  };
  type Chapter = { id: string; name: string };

  let items = $state<FamilyRow[]>([]);
  let chapters = $state<Chapter[]>([]);
  let q = $state("");
  let chapterId = $state("");
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let total = $state<number | null>(null);

  let createOpen = $state(false);
  let cName = $state("");
  let cChapter = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (chapterId) params.set("chapterId", chapterId);
      const res = await api.get<{ items: FamilyRow[]; total: number }>(
        `/api/tenant/families?${params.toString()}`,
      );
      items = res.items;
      total = res.total;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load families.";
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

  $effect(() => {
    loadChapters();
    refresh();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    createError = null;
    creating = true;
    try {
      await api.post("/api/tenant/families", { chapterId: cChapter, name: cName });
      cName = "";
      cChapter = "";
      createOpen = false;
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create family.";
    } finally {
      creating = false;
    }
  }
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ II · Households</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Families <span class="sl-serif-italic font-light text-[var(--brass-deep)]">register</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        {#if total !== null}
          {total} {total === 1 ? "household" : "households"} across all chapters
        {:else}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {/if}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button type="button" class="sl-btn sl-btn-primary" onclick={() => (createOpen = !createOpen)}>
        {#if createOpen}Cancel{:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          </svg>
          New household
        {/if}
      </button>
    </div>
  </div>

  {#if createOpen}
    <form class="sl-reveal sl-card-warm mt-6 grid grid-cols-12 gap-3 p-6" onsubmit={create}>
      <label class="col-span-12 sm:col-span-6">
        <span class="sl-eyebrow" style="font-size:10.5px">Household name</span>
        <input type="text" required minlength="1" maxlength="200" bind:value={cName} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
        <select required bind:value={cChapter} class="sl-select mt-1.5">
          <option value="">Select chapter</option>
          {#each chapters as ch}<option value={ch.id}>{ch.name}</option>{/each}
        </select>
      </label>
      <div class="col-span-12 flex items-end sm:col-span-2">
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
        placeholder="Search name or code…"
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
        <span class="sl-eyebrow">Index of households</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {items.length} {items.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Household</th>
              <th>Chapter</th>
              <th>Members</th>
            </tr>
          </thead>
          <tbody>
            {#each items as f}
              <tr>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">{f.referenceCode}</td>
                <td>
                  <a href={`/zone/families/${f.id}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                    {f.name}
                  </a>
                </td>
                <td class="text-[var(--ink-soft)]">{f.chapterName}</td>
                <td class="text-[var(--ink-soft)] sl-mono text-[12px]">{f.memberCount}</td>
              </tr>
            {/each}
            {#if !loading && items.length === 0}
              <tr>
                <td colspan="4" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                  No households yet. Add one above.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
