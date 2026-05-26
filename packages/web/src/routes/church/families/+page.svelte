<!-- packages/web/src/routes/church/families/+page.svelte -->
<!-- Chapter-scoped household register for the active chapter. -->
<!-- Exists so chapter admins curate households in their assigned chapter only. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/families/+page.svelte, packages/web/src/lib/active-chapter.svelte.ts, packages/api/src/routes/tenant-families.ts -->

<script lang="ts">
  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";

  type FamilyRow = {
    id: string;
    referenceCode: string;
    name: string;
    chapterName: string;
    memberCount: number;
  };

  const chapter = useActiveChapter();

  let q = $state("");
  let items = $state<FamilyRow[]>([]);
  let total = $state<number | null>(null);
  let loadError = $state<string | null>(null);

  let createOpen = $state(false);
  let cName = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  let refreshToken = 0;

  async function refresh(signal: AbortSignal) {
    const here = chapter();
    if (!here) {
      items = [];
      total = null;
      return;
    }
    const my = ++refreshToken;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      params.set("chapterId", here.id);
      const res = await api.get<{ items: FamilyRow[]; total: number }>(
        `/api/tenant/families?${params.toString()}`,
        signal,
      );
      if (my !== refreshToken) return;
      items = res.items;
      total = res.total;
      loadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load families.";
    }
  }

  $effect(() => {
    const ctrl = new AbortController();
    refresh(ctrl.signal);
    return () => ctrl.abort();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const here = chapter();
    if (!here) return;
    createError = null;
    creating = true;
    try {
      await api.post("/api/tenant/families", { chapterId: here.id, name: cName });
      cName = "";
      createOpen = false;
      const ctrl = new AbortController();
      await refresh(ctrl.signal);
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
          {total} {total === 1 ? "household" : "households"} in {chapter()?.name ?? "this chapter"}
        {:else}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {/if}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button type="button" class="sl-btn sl-btn-primary" onclick={() => (createOpen = !createOpen)}>
        {#if createOpen}Cancel{:else}New household{/if}
      </button>
    </div>
  </div>

  {#if createOpen}
    <form class="sl-reveal sl-card-warm mt-6 grid grid-cols-12 gap-3 p-6" onsubmit={create}>
      <label class="col-span-12 sm:col-span-8">
        <span class="sl-eyebrow" style="font-size:10.5px">Household name</span>
        <input type="text" required maxlength="200" bind:value={cName} class="sl-input mt-1.5" />
      </label>
      <div class="col-span-12 flex items-end sm:col-span-4">
        <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">Add</button>
      </div>
      {#if createError}
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
      {/if}
    </form>
  {/if}

  <div class="sl-reveal sl-reveal-2 mt-8 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,1fr)_auto]">
    <input
      type="search"
      bind:value={q}
      placeholder="Search name or code…"
      onkeydown={(e) => {
        if (e.key === "Enter") {
          const ctrl = new AbortController();
          refresh(ctrl.signal);
        }
      }}
      class="sl-input"
    />
    <button class="sl-btn sl-btn-ghost" onclick={() => { const ctrl = new AbortController(); refresh(ctrl.signal); }}>Search</button>
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
                <td class="text-[var(--ink-soft)] sl-mono text-[12px]">{f.memberCount}</td>
              </tr>
            {/each}
            {#if items.length === 0}
              <tr><td colspan="3" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">No households yet. Add one above.</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
