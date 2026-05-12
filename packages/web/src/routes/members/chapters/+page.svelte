<script lang="ts">
  import { api, ApiError } from "$lib/api";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
  };

  const adminRoles = new Set(["zone_owner", "zone_admin"]);

  let chapters = $state<Chapter[]>([]);
  let auth = $state<AuthorizedContext | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let createOpen = $state(false);
  let name = $state("");
  let countryCode = $state("");
  let dateFrom = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  const canCreate = $derived(
    auth?.isPlatformAdmin === true || auth?.roleCodes.some((role) => adminRoles.has(role)) === true,
  );

  async function refresh() {
    loading = true;
    try {
      const [chapterRes, meRes] = await Promise.all([
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me"),
      ]);
      chapters = chapterRes.items;
      auth = meRes.auth;
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
    creating = true;
    try {
      await api.post("/api/tenant/chapters", {
        name,
        countryCode: countryCode.trim() ? countryCode.trim().toUpperCase() : undefined,
        dateFrom: dateFrom || undefined,
      });
      name = "";
      countryCode = "";
      dateFrom = "";
      createOpen = false;
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not add chapter.";
    } finally {
      creating = false;
    }
  }
</script>

<div class="py-10">
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
      <button type="button" class="sl-btn sl-btn-primary" onclick={() => (createOpen = !createOpen)}>
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
      <label class="col-span-12 sm:col-span-5">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter name</span>
        <input type="text" required minlength="2" maxlength="120" bind:value={name} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Country</span>
        <input type="text" maxlength="2" bind:value={countryCode} placeholder="GB" class="sl-input mt-1.5 uppercase" />
      </label>
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Active since</span>
        <input type="date" bind:value={dateFrom} class="sl-input mt-1.5" />
      </label>
      <div class="col-span-12 flex items-end sm:col-span-2">
        <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">
          {creating ? "Adding…" : "Add"}
        </button>
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
              <th>Country</th>
              <th>Active since</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {#each chapters as chapter (chapter.id)}
              <tr>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">{chapter.referenceCode}</td>
                <td class="sl-display text-[15px] text-[var(--ink)]">{chapter.name}</td>
                <td class="sl-mono text-[12px] uppercase text-[var(--ink-soft)]">{chapter.countryCode ?? "—"}</td>
                <td class="sl-mono text-[12px] text-[var(--ink-soft)]">
                  {new Date(chapter.dateFrom).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  {new Date(chapter.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
