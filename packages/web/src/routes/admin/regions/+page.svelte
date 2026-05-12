<script lang="ts">
  import { api, ApiError } from "$lib/api";

  type Region = {
    id: string;
    name: string;
    shortCode: string | null;
    countryCode: string | null;
    isActive: boolean;
    createdAt: string;
  };

  let regions = $state<Region[]>([]);
  let loadError = $state<string | null>(null);

  let name = $state("");
  let shortCode = $state("");
  let countryCode = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  async function refresh() {
    try {
      const res = await api.get<{ items: Region[] }>("/api/admin/regions");
      regions = res.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load regions.";
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
      await api.post("/api/admin/regions", {
        name,
        shortCode: shortCode || undefined,
        countryCode: countryCode || undefined,
      });
      name = "";
      shortCode = "";
      countryCode = "";
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create region.";
    } finally {
      creating = false;
    }
  }

  async function toggleActive(r: Region) {
    try {
      await api.patch(`/api/admin/regions/${r.id}`, { isActive: !r.isActive });
      await refresh();
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not update region.";
    }
  }
</script>

<div class="py-10">
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Section II · Reference data</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      Regions <span class="sl-serif-italic font-light text-[var(--brass-deep)]">register</span>
    </h1>
    <p class="mt-2 max-w-xl text-[14px] text-[var(--ink-mute)]">
      Curated reference data. Region names share a global namespace with zone names —
      keep them clean and the inbox empty.
    </p>
  </div>

  <!-- Inline create -->
  <div class="sl-reveal sl-reveal-2 mt-8 sl-card-warm p-6">
    <div class="mb-4 flex items-center gap-3">
      <span class="sl-eyebrow">New entry</span>
      <span class="h-px flex-1 bg-[var(--rule)]"></span>
    </div>
    <form class="grid grid-cols-12 gap-3" onsubmit={create}>
      <label class="col-span-12 sm:col-span-6">
        <span class="sl-eyebrow" style="font-size:10.5px">Name</span>
        <input type="text" required minlength="2" maxlength="120" bind:value={name} placeholder="Region name" class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Short</span>
        <input type="text" maxlength="16" bind:value={shortCode} placeholder="UK-N" class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Country</span>
        <input type="text" maxlength="2" bind:value={countryCode} placeholder="GB" class="sl-input mt-1.5 uppercase" />
      </label>
      <div class="col-span-12 flex items-end sm:col-span-2">
        <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">
          {creating ? "Adding…" : "Add region"}
        </button>
      </div>
    </form>
    {#if createError}
      <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
        {createError}
      </p>
    {/if}
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else}
    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Ledger of regions</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {regions.length} {regions.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Short code</th>
              <th>Country</th>
              <th>Status</th>
              <th class="!text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {#each regions as r}
              <tr>
                <td class="sl-display text-[15px] text-[var(--ink)]">{r.name}</td>
                <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{r.shortCode ?? "—"}</td>
                <td class="sl-mono text-[12px] text-[var(--ink-soft)] uppercase">{r.countryCode ?? "—"}</td>
                <td>
                  {#if r.isActive}
                    <span class="sl-badge sl-badge-ok">active</span>
                  {:else}
                    <span class="sl-badge sl-badge-mute">inactive</span>
                  {/if}
                </td>
                <td class="text-right">
                  <button class="sl-link text-[12px]" onclick={() => toggleActive(r)}>
                    {r.isActive ? "deactivate" : "reactivate"}
                  </button>
                </td>
              </tr>
            {/each}
            {#if regions.length === 0}
              <tr><td colspan="5" class="py-10 text-center text-[13px] text-[var(--ink-mute)]">No regions yet.</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
