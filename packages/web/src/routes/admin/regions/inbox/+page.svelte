<script lang="ts">
  import { api, ApiError } from "$lib/api";

  type InboxRow = {
    zoneId: string;
    zoneSlug: string;
    zoneName: string;
    countryCode: string;
    regionNameUnverified: string;
    createdAt: string;
  };
  type Region = { id: string; name: string; isActive: boolean };

  let rows = $state<InboxRow[]>([]);
  let regions = $state<Region[]>([]);
  let loadError = $state<string | null>(null);

  // Per-row promote selection state.
  let mode = $state<Record<string, "existing" | "new">>({});
  let pickRegionId = $state<Record<string, string>>({});
  let newRegionName = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let rowError = $state<Record<string, string | null>>({});

  async function refresh() {
    try {
      const [inbox, all] = await Promise.all([
        api.get<{ items: InboxRow[] }>("/api/admin/regions/inbox"),
        api.get<{ items: Region[] }>("/api/admin/regions"),
      ]);
      rows = inbox.items;
      regions = all.items.filter((r) => r.isActive);
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load inbox.";
    }
  }
  $effect(() => {
    refresh();
  });

  async function promote(row: InboxRow) {
    const m = mode[row.zoneId] ?? "existing";
    busy[row.zoneId] = true;
    rowError[row.zoneId] = null;
    try {
      const payload =
        m === "existing"
          ? { zoneIds: [row.zoneId], regionId: pickRegionId[row.zoneId] }
          : {
              zoneIds: [row.zoneId],
              regionDraft: { name: newRegionName[row.zoneId] ?? row.regionNameUnverified },
            };
      await api.post("/api/admin/regions/promote", payload);
      await refresh();
    } catch (err) {
      rowError[row.zoneId] =
        err instanceof ApiError ? err.message : "Could not promote.";
    } finally {
      busy[row.zoneId] = false;
    }
  }
</script>

<div class="py-8">
  <h1 class="text-2xl font-semibold tracking-tight">Unverified region inbox</h1>
  <p class="mt-1 text-sm text-slate-600">
    Zones whose region name was entered as free text at signup. Promote each to an existing region or create a new one.
  </p>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if rows.length === 0}
    <p class="mt-8 text-sm text-slate-500">Nothing to review. Inbox is empty.</p>
  {:else}
    <ul class="mt-8 divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
      {#each rows as r}
        <li class="px-4 py-4 space-y-3">
          <div class="flex items-baseline justify-between">
            <div>
              <p class="text-sm font-medium text-slate-800">{r.zoneName}</p>
              <p class="text-xs text-slate-500">
                {r.zoneSlug}.stewardledger.church &middot; {r.countryCode}
              </p>
            </div>
            <p class="text-xs text-slate-500">
              submitted: <strong>{r.regionNameUnverified}</strong>
            </p>
          </div>

          <div class="flex items-center gap-2 text-xs">
            <label class="flex items-center gap-1">
              <input
                type="radio"
                value="existing"
                checked={(mode[r.zoneId] ?? "existing") === "existing"}
                onchange={() => (mode[r.zoneId] = "existing")}
              />
              Existing region
            </label>
            <label class="flex items-center gap-1">
              <input
                type="radio"
                value="new"
                checked={mode[r.zoneId] === "new"}
                onchange={() => (mode[r.zoneId] = "new")}
              />
              Create new
            </label>
          </div>

          {#if (mode[r.zoneId] ?? "existing") === "existing"}
            <select
              bind:value={pickRegionId[r.zoneId]}
              class="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="" disabled selected>Pick a region…</option>
              {#each regions as opt}
                <option value={opt.id}>{opt.name}</option>
              {/each}
            </select>
          {:else}
            <input
              type="text"
              bind:value={newRegionName[r.zoneId]}
              placeholder={r.regionNameUnverified}
              class="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          {/if}

          {#if rowError[r.zoneId]}
            <p class="text-sm text-red-600">{rowError[r.zoneId]}</p>
          {/if}

          <div class="text-right">
            <button
              type="button"
              disabled={busy[r.zoneId]}
              class="inline-flex items-center px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-700 disabled:opacity-50"
              onclick={() => promote(r)}
            >
              {busy[r.zoneId] ? "Promoting…" : "Promote"}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
