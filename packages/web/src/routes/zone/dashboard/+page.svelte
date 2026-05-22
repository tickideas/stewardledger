<script lang="ts">
  // Zone dashboard. One server-side aggregated payload from
  // GET /api/tenant/dashboard/zone, rendered as a glance view with
  // drill-links into the chapter / member / reports surfaces.

  import { api, ApiError, isAbortError } from "$lib/api";
  import { formatMoney, money } from "@stewardledger/shared";
  import { percentWidth, type PartnershipProgress } from "$lib/dashboard-progress";

  type CurrencyTotal = { currencyCode: string; total: string };
  type DashboardPeriod = {
    periodStart: string;
    periodEnd: string;
    perCurrency: CurrencyTotal[];
  };
  type TopChapter = {
    id: string;
    referenceCode: string;
    name: string;
    currencyCode: string;
    total: string;
  };
  type TopPartner = {
    id: string;
    referenceCode: string;
    name: string;
    chapterReferenceCode: string | null;
    currencyCode: string;
    total: string;
  };
  type RecentImport = {
    id: string;
    fileName: string;
    status: string;
    createdAt: string;
    postedCount: number;
    perCurrency: CurrencyTotal[];
  };
  type Payload = {
    asOf: string;
    timeZone: string;
    chapters: { total: number; active: number };
    members: { total: number; active: number; inactive: number };
    monthlyGiving: DashboardPeriod;
    yearToDateGiving: DashboardPeriod;
    topChapters: TopChapter[];
    topPartners: TopPartner[];
    recentImports: RecentImport[];
    partnershipProgress: PartnershipProgress;
  };

  let data = $state<Payload | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  $effect(() => {
    const controller = new AbortController();
    loading = true;
    api
      .get<Payload>("/api/tenant/dashboard/zone", controller.signal)
      .then((res) => {
        data = res;
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        loadError = err instanceof ApiError ? err.message : "Could not load dashboard.";
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    return () => controller.abort();
  });

  function fmt(t: CurrencyTotal): string {
    return formatMoney(money(t.total, t.currencyCode));
  }


  /**
   * Format a UTC ISO datetime in the zone's timezone with a stable
   * `YYYY-MM-DD HH:mm` shape. We use `Intl.DateTimeFormat` for the
   * TZ conversion only — the field order is fixed by reassembling
   * the named parts, so the output stays identical across locales
   * and remains deterministic on a future SSR path. Returns the raw
   * iso string if either parsing or the formatter rejects.
   */
  function fmtDateTime(iso: string, timeZone: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return iso;
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const grab = (t: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === t)?.value ?? "";
      return `${grab("year")}-${grab("month")}-${grab("day")} ${grab("hour")}:${grab("minute")}`;
    } catch {
      return iso;
    }
  }
</script>

<svelte:head><title>Zone dashboard · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Insight · Dashboard</span>
    <h1 class="mt-3 sl-display text-[52px] leading-[1] text-[var(--ink)]">
      Zone <span class="sl-serif-italic font-light text-[var(--brass-deep)]">dashboard</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[15px] text-[var(--ink-mute)]">
      A glance at the whole zone: chapters, members, what's coming in this month,
      and the most recent imports. Drill into reports for the row-by-row view.
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  {#if loading && !data}
    <!-- Skeleton placeholder so the first paint isn't an empty body. -->
    <div class="sl-reveal sl-reveal-2 mt-10 grid grid-cols-2 gap-0 border-y border-[var(--rule)] bg-[var(--card)] md:grid-cols-4" aria-busy="true">
      {#each Array(4) as _, i (i)}
        <div class="px-6 py-7 {i < 3 ? 'border-r border-[var(--rule)]' : ''}">
          <span class="sl-eyebrow">Loading…</span>
          <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink-faint)]">—</div>
          <p class="mt-2 text-[12px] text-[var(--ink-faint)]">&nbsp;</p>
        </div>
      {/each}
    </div>
  {/if}

  {#if data}
    <!-- Stat tiles. Same grid grammar as /church/overview for visual consistency. -->
    <div class="sl-reveal sl-reveal-2 mt-10 grid grid-cols-2 gap-0 border-y border-[var(--rule)] bg-[var(--card)] md:grid-cols-4">
      <div class="px-6 py-7 border-r border-[var(--rule)]">
        <span class="sl-eyebrow">Chapters</span>
        <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
          {data.chapters.active}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          {data.chapters.total} total · {data.chapters.total - data.chapters.active} archived
        </p>
      </div>
      <div class="px-6 py-7 md:border-r md:border-[var(--rule)]">
        <span class="sl-eyebrow">Members</span>
        <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
          {data.members.active}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          {data.members.total} total · {data.members.inactive} inactive
        </p>
      </div>
      <div class="border-t border-[var(--rule)] px-6 py-7 md:border-r md:border-t-0 md:border-[var(--rule)]">
        <span class="sl-eyebrow">This month</span>
        <div class="mt-3 sl-display sl-num text-[28px] leading-tight text-[var(--brass-deep)]">
          {#if data.monthlyGiving.perCurrency.length === 0}
            <span class="text-[var(--ink-faint)]">—</span>
          {:else}
            {#each data.monthlyGiving.perCurrency as t, i (t.currencyCode)}
              <span class:block={i > 0}>{fmt(t)}</span>
            {/each}
          {/if}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          posted since {data.monthlyGiving.periodStart}
        </p>
      </div>
      <div class="border-t border-[var(--rule)] px-6 py-7 md:border-t-0">
        <span class="sl-eyebrow">Year to date</span>
        <div class="mt-3 sl-display sl-num text-[28px] leading-tight text-[var(--ink)]">
          {#if data.yearToDateGiving.perCurrency.length === 0}
            <span class="text-[var(--ink-faint)]">—</span>
          {:else}
            {#each data.yearToDateGiving.perCurrency as t, i (t.currencyCode)}
              <span class:block={i > 0}>{fmt(t)}</span>
            {/each}
          {/if}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          since {data.yearToDateGiving.periodStart}
        </p>
      </div>
    </div>

    <!-- Top chapters and top partners. -->
    <div class="sl-reveal sl-reveal-3 mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="sl-card p-5">
        <div class="flex items-baseline justify-between">
          <h2 class="sl-display text-[18px] text-[var(--ink)]">Top chapters · this month</h2>
          <a href="/zone/reports/top-chapters" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
            Full report →
          </a>
        </div>
        <div class="mt-4 h-px w-10 bg-[var(--brass)]"></div>
        {#if data.topChapters.length === 0}
          <p class="mt-6 text-[13px] text-[var(--ink-faint)]">No giving recorded this month.</p>
        {:else}
          <table class="mt-4 min-w-full text-[13px]">
            <thead class="text-left text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
              <tr>
                <th class="py-2 pr-2 font-medium">Chapter</th>
                <th class="py-2 pr-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {#each data.topChapters as c (c.id + c.currencyCode)}
                <tr class="border-t border-[var(--rule)]">
                  <td class="py-2 pr-2">
                    <span class="sl-mono text-[11px] text-[var(--ink-mute)]">{c.referenceCode}</span>
                    · {c.name}
                  </td>
                  <td class="py-2 pr-2 text-right font-medium text-[var(--ink)]">
                    {fmt({ currencyCode: c.currencyCode, total: c.total })}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <div class="sl-card p-5">
        <div class="flex items-baseline justify-between">
          <h2 class="sl-display text-[18px] text-[var(--ink)]">Top partners · this month</h2>
          <a href="/zone/reports/top-partners" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
            Full report →
          </a>
        </div>
        <div class="mt-4 h-px w-10 bg-[var(--brass)]"></div>
        {#if data.topPartners.length === 0}
          <p class="mt-6 text-[13px] text-[var(--ink-faint)]">No partner giving recorded this month.</p>
        {:else}
          <table class="mt-4 min-w-full text-[13px]">
            <thead class="text-left text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
              <tr>
                <th class="py-2 pr-2 font-medium">Member</th>
                <th class="py-2 pr-2 font-medium">Chapter</th>
                <th class="py-2 pr-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {#each data.topPartners as p (p.id + p.currencyCode)}
                <tr class="border-t border-[var(--rule)]">
                  <td class="py-2 pr-2">
                    <span class="sl-mono text-[11px] text-[var(--ink-mute)]">{p.referenceCode}</span>
                    · {p.name}
                  </td>
                  <td class="py-2 pr-2 text-[var(--ink-mute)]">
                    {p.chapterReferenceCode ?? "—"}
                  </td>
                  <td class="py-2 pr-2 text-right font-medium text-[var(--ink)]">
                    {fmt({ currencyCode: p.currencyCode, total: p.total })}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>


    <!-- Partnership target progress. -->
    <div class="sl-reveal sl-reveal-4 mt-10 sl-card p-5">
      <div class="flex items-baseline justify-between">
        <h2 class="sl-display text-[18px] text-[var(--ink)]">Partnership progress</h2>
        <a href="/zone/partnership-progress" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
          Open dashboard →
        </a>
      </div>
      <div class="mt-4 h-px w-10 bg-[var(--brass)]"></div>
      {#if !data.partnershipProgress.available}
        <p class="mt-6 text-[13px] text-[var(--ink-faint)]">{data.partnershipProgress.reason}</p>
      {:else}
        <p class="mt-3 text-[12px] text-[var(--ink-mute)]">
          {data.partnershipProgress.ministryYearLabel} · {data.partnershipProgress.periodStart} to {data.partnershipProgress.periodEnd}
        </p>
        <div class="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          {#each data.partnershipProgress.perCurrency as row (row.currencyCode)}
            <div class="rounded-2xl border border-[var(--rule)] bg-[var(--paper-soft)] p-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <span class="sl-eyebrow">{row.currencyCode} · {row.targetCount} target{row.targetCount === 1 ? "" : "s"}</span>
                  <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
                    {formatMoney(money(row.achieved, row.currencyCode))} achieved of {formatMoney(money(row.target, row.currencyCode))}
                  </p>
                </div>
                <div class="sl-display sl-num text-[28px] leading-none text-[var(--brass-deep)]">{row.percentProgress}%</div>
              </div>
              <div class="mt-4 h-2 overflow-hidden rounded-full bg-[var(--rule)]">
                <div class="h-full rounded-full bg-[var(--brass)]" style={`width: ${percentWidth(row.percentProgress)}`}></div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Recent imports. -->
    <div class="sl-reveal sl-reveal-5 mt-10 sl-card p-5">
      <div class="flex items-baseline justify-between">
        <h2 class="sl-display text-[18px] text-[var(--ink)]">Recent imports</h2>
        <a href="/zone/imports" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
          All imports →
        </a>
      </div>
      <div class="mt-4 h-px w-10 bg-[var(--brass)]"></div>
      {#if data.recentImports.length === 0}
        <p class="mt-6 text-[13px] text-[var(--ink-faint)]">No imports yet.</p>
      {:else}
        <table class="mt-4 min-w-full text-[13px]">
          <thead class="text-left text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
            <tr>
              <th class="py-2 pr-2 font-medium">File</th>
              <th class="py-2 pr-2 font-medium">When</th>
              <th class="py-2 pr-2 font-medium">Status</th>
              <th class="py-2 pr-2 font-medium text-right">Posted</th>
              <th class="py-2 pr-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {#each data.recentImports as job (job.id)}
              <tr class="border-t border-[var(--rule)]">
                <td class="py-2 pr-2 text-[var(--ink)]">{job.fileName}</td>
                <td class="py-2 pr-2 text-[var(--ink-mute)]">
                  {fmtDateTime(job.createdAt, data.timeZone)}
                </td>
                <td class="py-2 pr-2">
                  <span class="sl-badge {job.status === 'committed' ? 'sl-badge-accent' : ''}">
                    {job.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td class="py-2 pr-2 text-right">{job.postedCount}</td>
                <td class="py-2 pr-2 text-right">
                  {#if job.perCurrency.length === 0}
                    <span class="text-[var(--ink-faint)]">—</span>
                  {:else}
                    {#each job.perCurrency as t, i (t.currencyCode)}
                      <span class:block={i > 0}>{fmt(t)}</span>
                    {/each}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <p class="sl-reveal sl-reveal-6 mt-10 text-[11px] text-[var(--ink-faint)]">
      Generated {fmtDateTime(data.asOf, data.timeZone)} · {data.timeZone}
    </p>
  {/if}
</div>
