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

<div class="py-8">
  <h1 class="text-2xl font-semibold tracking-tight">Regions</h1>
  <p class="mt-1 text-sm text-slate-600">
    Curated reference data. Region names share a global namespace with zone names.
  </p>

  <form class="mt-6 grid grid-cols-12 gap-3" onsubmit={create}>
    <input
      type="text"
      required
      minlength="2"
      maxlength="120"
      bind:value={name}
      placeholder="Region name"
      class="col-span-12 sm:col-span-6 rounded-lg border border-slate-300 px-3 py-2 text-sm"
    />
    <input
      type="text"
      maxlength="16"
      bind:value={shortCode}
      placeholder="Short code"
      class="col-span-6 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
    />
    <input
      type="text"
      maxlength="2"
      bind:value={countryCode}
      placeholder="GB"
      class="col-span-6 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
    />
    <button
      type="submit"
      disabled={creating}
      class="col-span-12 sm:col-span-2 inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
    >
      Add
    </button>
  </form>
  {#if createError}
    <p class="mt-2 text-sm text-red-600">{createError}</p>
  {/if}

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else}
    <table class="mt-8 w-full text-sm">
      <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">Name</th>
          <th class="py-2">Short code</th>
          <th class="py-2">Country</th>
          <th class="py-2">Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each regions as r}
          <tr>
            <td class="py-3 font-medium text-slate-800">{r.name}</td>
            <td class="py-3 text-slate-600">{r.shortCode ?? "—"}</td>
            <td class="py-3 text-slate-600">{r.countryCode ?? "—"}</td>
            <td class="py-3">
              {#if r.isActive}
                <span class="text-green-700 text-xs">active</span>
              {:else}
                <span class="text-slate-400 text-xs">inactive</span>
              {/if}
            </td>
            <td class="py-3 text-right">
              <button class="text-xs underline" onclick={() => toggleActive(r)}>
                {r.isActive ? "deactivate" : "reactivate"}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
