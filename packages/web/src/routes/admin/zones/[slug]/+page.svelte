<script lang="ts">
  import { page } from "$app/state";
  import { api, ApiError } from "$lib/api";

  type ChapterRow = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
    memberCount: number;
  };

  type ZoneDetail = {
    zone: {
      id: string;
      slug: string;
      name: string;
      legalName: string | null;
      status: string;
      countryCode: string;
      defaultCurrencyCode: string;
      defaultTimeZone: string;
      fiscalYearStartMonth: number;
      ministryYearStartMonth: number;
      regionId: string | null;
      regionName: string | null;
      regionNameUnverified: string | null;
      activatedAt: string | null;
      createdAt: string;
    };
    chapters: ChapterRow[];
    totals: {
      members: number;
      unassignedMembers: number;
      postedContributionTotal: string;
      postedContributionCount: number;
    };
  };

  let data = $state<ZoneDetail | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    const slug = page.params.slug;
    if (!slug) return;
    (async () => {
      try {
        data = await api.get<ZoneDetail>(`/api/admin/zones/${slug}`);
        loadError = null;
      } catch (err) {
        loadError = err instanceof ApiError ? err.message : "Could not load zone.";
      }
    })();
  });

  function fmtMoney(total: string, currency: string): string {
    const n = Number(total);
    if (!Number.isFinite(n)) return total;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }).format(n);
    } catch {
      return `${currency} ${n.toFixed(2)}`;
    }
  }
</script>

<div class="py-8">
  <a href="/admin/zones" class="text-xs text-slate-500 hover:text-slate-900">&larr; All zones</a>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if !data}
    <p class="mt-6 text-sm text-slate-500">Loading…</p>
  {:else}
    {@const z = data.zone}
    <div class="mt-3 flex items-baseline justify-between gap-6">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{z.name}</h1>
        <p class="mt-1 text-sm text-slate-600">
          <code>{z.slug}</code> &middot; {z.countryCode} &middot; {z.defaultCurrencyCode} &middot;
          {z.defaultTimeZone}
        </p>
        {#if z.legalName}
          <p class="text-xs text-slate-500">Legal: {z.legalName}</p>
        {/if}
      </div>
      <div class="text-right">
        <div class="text-xs uppercase tracking-wide text-slate-500">Status</div>
        <div class="text-lg font-medium">{z.status.replace("_", " ")}</div>
      </div>
    </div>

    <dl class="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Chapters</dt>
        <dd class="mt-1 text-2xl font-semibold tabular-nums">{data.chapters.length}</dd>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Members</dt>
        <dd class="mt-1 text-2xl font-semibold tabular-nums">{data.totals.members}</dd>
        {#if data.totals.unassignedMembers > 0}
          <div class="text-xs text-slate-500">{data.totals.unassignedMembers} unassigned</div>
        {/if}
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Contributions (posted)</dt>
        <dd class="mt-1 text-2xl font-semibold tabular-nums">
          {fmtMoney(data.totals.postedContributionTotal, z.defaultCurrencyCode)}
        </dd>
        <div class="text-xs text-slate-500">{data.totals.postedContributionCount} records</div>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Region</dt>
        <dd class="mt-1 text-sm font-medium">
          {#if z.regionName}
            {z.regionName}
          {:else if z.regionNameUnverified}
            <span class="text-amber-700">{z.regionNameUnverified}</span>
            <div class="text-xs text-amber-600">unverified</div>
          {:else}
            <span class="text-slate-400">—</span>
          {/if}
        </dd>
      </div>
    </dl>

    <h2 class="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">Chapters</h2>
    {#if data.chapters.length === 0}
      <p class="mt-3 text-sm text-slate-500">No chapters yet.</p>
    {:else}
      <div class="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b bg-slate-50">
            <tr>
              <th class="py-3 px-4">Reference</th>
              <th class="py-3 px-4">Name</th>
              <th class="py-3 px-4">Country</th>
              <th class="py-3 px-4 text-right">Members</th>
              <th class="py-3 px-4">Active since</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            {#each data.chapters as ch (ch.id)}
              <tr>
                <td class="py-3 px-4 text-slate-600 font-mono text-xs">{ch.referenceCode}</td>
                <td class="py-3 px-4 font-medium">{ch.name}</td>
                <td class="py-3 px-4 text-slate-600">{ch.countryCode ?? "—"}</td>
                <td class="py-3 px-4 text-right tabular-nums">{ch.memberCount}</td>
                <td class="py-3 px-4 text-xs text-slate-500">
                  {new Date(ch.dateFrom).toLocaleDateString()}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <h2 class="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">Metadata</h2>
    <dl class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Created</dt>
        <dd>{new Date(z.createdAt).toLocaleString()}</dd>
      </div>
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Activated</dt>
        <dd>{z.activatedAt ? new Date(z.activatedAt).toLocaleString() : "—"}</dd>
      </div>
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Fiscal year starts</dt>
        <dd>Month {z.fiscalYearStartMonth}</dd>
      </div>
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Ministry year starts</dt>
        <dd>Month {z.ministryYearStartMonth}</dd>
      </div>
    </dl>
  {/if}
</div>
