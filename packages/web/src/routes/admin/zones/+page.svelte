<script lang="ts">
  import { api, ApiError } from "$lib/api";

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
    postedContributionCount: number;
  };

  let zones = $state<ZoneRow[]>([]);
  let loadError = $state<string | null>(null);
  let query = $state("");

  async function refresh() {
    try {
      const res = await api.get<{ items: ZoneRow[] }>("/api/admin/zones");
      zones = res.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load zones.";
    }
  }
  $effect(() => {
    refresh();
  });

  const filtered = $derived(
    query.trim().length === 0
      ? zones
      : zones.filter((z) => {
          const q = query.trim().toLowerCase();
          return (
            z.name.toLowerCase().includes(q) ||
            z.slug.toLowerCase().includes(q) ||
            (z.regionName ?? z.regionNameUnverified ?? "").toLowerCase().includes(q)
          );
        }),
  );

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

  function fmtMoney(total: string, currency: string): string {
    const n = Number(total);
    if (!Number.isFinite(n)) return total;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(n);
    } catch {
      return `${currency} ${n.toFixed(0)}`;
    }
  }
</script>

<div class="py-8">
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Zones</h1>
      <p class="mt-1 text-sm text-slate-600">
        All tenants on this StewardLedger deployment. Read-only cross-zone view.
      </p>
    </div>
    <input
      type="search"
      bind:value={query}
      placeholder="Search by name, slug, region"
      class="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm"
    />
  </div>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if zones.length === 0}
    <p class="mt-10 text-sm text-slate-500">No zones yet. Run <code>pnpm seed:demo</code> or sign up at <code>/signup</code>.</p>
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
          {#each filtered as z (z.id)}
            <tr class="hover:bg-slate-50">
              <td class="py-3 px-4">
                <a href={`/admin/zones/${z.slug}`} class="font-medium text-slate-900 hover:underline">
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
                <span class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium {statusClass(z.status)}">
                  {z.status.replace("_", " ")}
                </span>
              </td>
              <td class="py-3 px-4 text-right tabular-nums">{z.chapterCount}</td>
              <td class="py-3 px-4 text-right tabular-nums">{z.memberCount}</td>
              <td class="py-3 px-4 text-right tabular-nums">
                {fmtMoney(z.postedContributionTotal, z.defaultCurrencyCode)}
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
  {/if}
</div>
