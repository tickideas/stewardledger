<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";
  import { fmtMoney } from "$lib/format";
  import InviteZoneModal from "./invite-zone-modal.svelte";

  type Subtotal = { currencyCode: string; total: string; count: number };

  type ZoneRow = {
    id: string;
    slug: string;
    name: string;
    status: string;
    countryCode: string;
    defaultCurrencyCode: string;
    regionId: string | null;
    regionName: string | null;
    regionNameUnverified: string | null;
    activatedAt: string | null;
    createdAt: string;
    chapterCount: number;
    memberCount: number;
    postedContributionTotal: string;
    postedContributionCurrency: string;
    postedContributionCount: number;
    postedContributionSubtotals: Subtotal[];
  };

  type ZonesListResponse = { items: ZoneRow[]; nextCursor: string | null };

  let zones = $state<ZoneRow[]>([]);
  let nextCursor = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let query = $state("");
  let inviteOpen = $state(false);
  let inviteFlash = $state<string | null>(null);

  function onInvited() {
    inviteFlash = "Invitation sent. The new zone is in pending_setup until the contact accepts.";
    // Refresh from the top so the new pending_setup zone shows up.
    refresh();
    // Clear the banner after a few seconds; the table itself is the persistent confirmation.
    setTimeout(() => {
      inviteFlash = null;
    }, 6000);
  }

  // Server-side search via the API. We debounce in-component so typing
  // doesn't fire a request per keystroke.
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  // Bumped on each fresh refresh so a slower previous response can't clobber
  // a newer one (e.g. user types fast, network is flaky).
  let fetchEpoch = 0;

  async function refresh(opts: { append?: boolean; cursor?: string | null } = {}) {
    const epoch = ++fetchEpoch;
    if (opts.append) loadingMore = true;
    else loading = true;
    try {
      const params = new URLSearchParams();
      if (opts.cursor) params.set("cursor", opts.cursor);
      const trimmed = query.trim();
      if (trimmed.length > 0) params.set("q", trimmed);
      const qs = params.toString();
      const path = qs ? `/api/admin/zones?${qs}` : "/api/admin/zones";
      const res = await api.get<ZonesListResponse>(path);
      if (epoch !== fetchEpoch) return; // superseded
      zones = opts.append ? [...zones, ...res.items] : res.items;
      nextCursor = res.nextCursor;
      loadError = null;
    } catch (err) {
      if (epoch !== fetchEpoch) return;
      loadError = err instanceof ApiError ? err.message : "Could not load zones.";
    } finally {
      if (epoch === fetchEpoch) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  onMount(() => {
    refresh();
    return () => {
      if (searchDebounce) clearTimeout(searchDebounce);
    };
  });

  function onQueryInput(value: string) {
    query = value;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => refresh(), 200);
  }

  function statusClass(status: string): string {
    switch (status) {
      case "active":
        return "bg-green-100 text-green-800";
      case "pending_setup":
        return "bg-amber-100 text-amber-800";
      case "past_due":
        return "bg-orange-100 text-orange-800";
      case "suspended":
        return "bg-red-100 text-red-800";
      default:
        return "bg-slate-100 text-slate-700";
    }
  }
</script>

<div class="py-8">
  <div class="flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Zones</h1>
      <p class="mt-1 text-sm text-slate-600">
        All tenants on this StewardLedger deployment. Read-only cross-zone view.
      </p>
    </div>
    <div class="flex items-center gap-3">
      <input
        type="search"
        value={query}
        oninput={(e) => onQueryInput((e.target as HTMLInputElement).value)}
        placeholder="Search by name, slug, region"
        class="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <button
        type="button"
        onclick={() => (inviteOpen = true)}
        class="inline-flex items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Invite zone
      </button>
    </div>
  </div>

  {#if inviteFlash}
    <p
      class="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
    >
      {inviteFlash}
    </p>
  {/if}

  <InviteZoneModal bind:open={inviteOpen} oninvited={onInvited} />

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if loading && zones.length === 0}
    <p class="mt-10 text-sm text-slate-500">Loading…</p>
  {:else if zones.length === 0}
    <p class="mt-10 text-sm text-slate-500">
      {#if query.trim().length > 0}
        No zones match <code>{query}</code>.
      {:else}
        No zones yet. Run <code>pnpm seed:demo</code>, or use
        <strong>Invite zone</strong> to onboard one.
      {/if}
    </p>
  {:else}
    <div class="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b bg-slate-50">
          <tr>
            <th class="py-3 px-4">Zone</th>
            <th class="py-3 px-4">Region</th>
            <th class="py-3 px-4">Status</th>
            <th class="py-3 px-4 text-right">Chapters</th>
            <th class="py-3 px-4 text-right">Members</th>
            <th class="py-3 px-4 text-right">Contributions</th>
            <th class="py-3 px-4">Created</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          {#each zones as z (z.id)}
            <tr class="hover:bg-slate-50">
              <td class="py-3 px-4">
                <a
                  href={`/admin/zones/${z.slug}`}
                  class="font-medium text-slate-900 hover:underline"
                >
                  {z.name}
                </a>
                <div class="text-xs text-slate-500">
                  {z.slug} &middot; {z.countryCode} &middot; {z.defaultCurrencyCode}
                </div>
              </td>
              <td class="py-3 px-4 text-slate-700">
                {#if z.regionName}
                  {z.regionName}
                {:else if z.regionNameUnverified}
                  <span class="text-amber-700">{z.regionNameUnverified}</span>
                  <span class="text-xs text-amber-600"> (unverified)</span>
                {:else}
                  <span class="text-slate-400">—</span>
                {/if}
              </td>
              <td class="py-3 px-4">
                <span
                  class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium {statusClass(
                    z.status,
                  )}"
                >
                  {z.status.replace("_", " ")}
                </span>
              </td>
              <td class="py-3 px-4 text-right tabular-nums">{z.chapterCount}</td>
              <td class="py-3 px-4 text-right tabular-nums">{z.memberCount}</td>
              <td class="py-3 px-4 text-right tabular-nums">
                {fmtMoney(z.postedContributionTotal, z.postedContributionCurrency, 2)}
                {#if z.postedContributionSubtotals.length > 1}
                  <div class="text-xs text-amber-700" title={z.postedContributionSubtotals
                      .map((s) => `${s.currencyCode}: ${s.total}`)
                      .join(", ")}>
                    +{z.postedContributionSubtotals.length - 1} more currenc{z.postedContributionSubtotals.length === 2 ? "y" : "ies"}
                  </div>
                {/if}
                <div class="text-xs text-slate-500">{z.postedContributionCount} posted</div>
              </td>
              <td class="py-3 px-4 text-xs text-slate-500">
                {new Date(z.createdAt).toLocaleDateString()}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if nextCursor}
      <div class="mt-4 flex justify-center">
        <button
          type="button"
          onclick={() => refresh({ append: true, cursor: nextCursor })}
          disabled={loadingMore}
          class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      </div>
    {/if}
  {/if}
</div>
