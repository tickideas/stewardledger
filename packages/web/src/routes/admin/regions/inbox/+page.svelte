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
      rowError[row.zoneId] = err instanceof ApiError ? err.message : "Could not promote.";
    } finally {
      busy[row.zoneId] = false;
    }
  }
</script>

<div class="py-10">
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Section III · Curation</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      Unverified <span class="sl-serif-italic font-light text-[var(--brass-deep)]">inbox</span>
    </h1>
    <p class="mt-2 max-w-xl text-[14px] text-[var(--ink-mute)]">
      Zones whose region name was entered as free text at signup. Promote each to an existing region
      or create a new one.
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if rows.length === 0}
    <div class="sl-reveal sl-reveal-2 mt-10 sl-card flex flex-col items-center justify-center p-16 text-center">
      <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">∅</span>
      <p class="mt-4 sl-display text-[18px] italic text-[var(--ink)]">Inbox is empty.</p>
      <p class="mt-2 text-[13px] text-[var(--ink-mute)]">Nothing to review right now — clean books.</p>
    </div>
  {:else}
    <ul class="sl-reveal sl-reveal-2 mt-10 sl-card divide-y divide-[var(--rule)] overflow-hidden">
      {#each rows as r, i}
        <li class="space-y-4 px-6 py-6">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.1em">№ {String(i + 1).padStart(2, "0")}</span>
              <p class="mt-1 sl-display text-[18px] text-[var(--ink)]">{r.zoneName}</p>
              <p class="mt-0.5 sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">
                {r.zoneSlug}.stewardledger.church · {r.countryCode}
              </p>
            </div>
            <div class="text-right">
              <span class="sl-eyebrow" style="font-size:10px">Submitted as</span>
              <p class="mt-1 sl-display italic text-[var(--ink)]">"{r.regionNameUnverified}"</p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-5 text-[13px]">
            <label class="flex items-center gap-2">
              <input
                type="radio"
                value="existing"
                checked={(mode[r.zoneId] ?? "existing") === "existing"}
                onchange={() => (mode[r.zoneId] = "existing")}
                style="accent-color: var(--brass)"
              />
              <span class="text-[var(--ink-soft)]">Map to existing</span>
            </label>
            <label class="flex items-center gap-2">
              <input
                type="radio"
                value="new"
                checked={mode[r.zoneId] === "new"}
                onchange={() => (mode[r.zoneId] = "new")}
                style="accent-color: var(--brass)"
              />
              <span class="text-[var(--ink-soft)]">Create new region</span>
            </label>
          </div>

          {#if (mode[r.zoneId] ?? "existing") === "existing"}
            <select bind:value={pickRegionId[r.zoneId]} class="sl-select">
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
              class="sl-input"
            />
          {/if}

          {#if rowError[r.zoneId]}
            <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{rowError[r.zoneId]}</p>
          {/if}

          <div class="flex justify-end">
            <button type="button" disabled={busy[r.zoneId]} class="sl-btn sl-btn-accent" onclick={() => promote(r)}>
              {busy[r.zoneId] ? "Promoting…" : "Promote"}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
