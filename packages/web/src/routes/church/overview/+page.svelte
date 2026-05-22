<script lang="ts">
  // Chapter overview. Server-aggregated payload from
  // GET /api/tenant/dashboard/chapter/:chapterId — one round trip
  // produces every card the legacy 3-fetch client-side aggregation
  // tried to derive, plus per-currency money math that correctly
  // honours the reversal sign convention (posted + reversed lines net
  // to zero, DOMAIN-MODEL §6).

  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { session } from "$lib/session.svelte";
  import { formatMoney, money } from "@stewardledger/shared";
  import { percentWidth, type PartnershipProgress } from "$lib/dashboard-progress";

  type CurrencyTotal = { currencyCode: string; total: string };
  type DashboardPeriod = {
    periodStart: string;
    periodEnd: string;
    perCurrency: CurrencyTotal[];
  };
  type Chapter = { id: string; referenceCode: string; name: string };
  type TopGivingType = {
    id: string;
    name: string;
    shortCode: string | null;
    currencyCode: string;
    total: string;
  };
  type TopPartner = {
    id: string;
    referenceCode: string;
    name: string;
    currencyCode: string;
    total: string;
  };
  type RecentContribution = {
    id: string;
    contributionDate: string;
    memberName: string | null;
    currencyCode: string;
    amount: string;
    sourceType: string;
  };
  type PendingBatches = { count: number; perCurrency: CurrencyTotal[] };
  type Payload = {
    asOf: string;
    timeZone: string;
    chapter: Chapter;
    members: { total: number; active: number; inactive: number };
    weeklyGiving: DashboardPeriod;
    monthlyGiving: DashboardPeriod;
    yearToDateGiving: DashboardPeriod;
    pendingBatches: PendingBatches;
    topGivingTypes: TopGivingType[];
    topPartners: TopPartner[];
    recentContributions: RecentContribution[];
    partnershipProgress: PartnershipProgress;
  };

  const chapter = useActiveChapter();

  let data = $state<Payload | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let refreshToken = 0;

  async function refresh(signal: AbortSignal) {
    const here = chapter();
    if (!here) {
      data = null;
      loading = false;
      // Clear any stale error from a previous chapter so switching
      // to "no chapter" doesn't leave an out-of-context banner.
      loadError = null;
      return;
    }
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const res = await api.get<Payload>(
        `/api/tenant/dashboard/chapter/${encodeURIComponent(here.id)}`,
        signal,
      );
      if (my !== refreshToken) return;
      data = res;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load overview.";
    } finally {
      if (my === refreshToken) loading = false;
    }
  }

  $effect(() => {
    void chapter()?.id;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  });

  function fmt(t: CurrencyTotal): string {
    return formatMoney(money(t.total, t.currencyCode));
  }


  /**
   * Format a UTC ISO date / datetime in the zone's timezone with a
   * stable `YYYY-MM-DD HH:mm` shape. See zone dashboard for the
   * rationale (SSR-stable + locale-insensitive). Duplicated from
   * `routes/zone/dashboard/+page.svelte`; once a third caller lands
   * this is a candidate for `packages/web/src/lib/format.ts`.
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

  // User's roles within this chapter — context for "why am I seeing this?"
  const chapterRoleCodes = $derived.by<string[]>(() => {
    const here = chapter();
    if (!here) return [];
    const s = session.current;
    if (s.status !== "authenticated") return [];
    const zone = s.zones.find((z) => z.slug === s.activeZoneSlug);
    if (!zone) return [];
    return [
      ...new Set(
        zone.chapterRoles.filter((r) => r.chapterId === here.id).map((r) => r.roleCode),
      ),
    ];
  });
</script>

<svelte:head><title>{chapter()?.name ?? "Chapter"} overview · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <p class="sl-eyebrow" style="font-size:10.5px">§ Chapter I · Overview</p>
    <h1 class="sl-display mt-2 text-[44px] leading-[1.05] tracking-tight text-[var(--ink)]">
      {#if chapter()}
        {chapter()!.name}
        <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">overview</span>
      {:else}
        Chapter <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">overview</span>
      {/if}
    </h1>
    <p class="mt-3 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Your chapter at a glance — members, what's come in this week and
      this month, top giving types, and the most recent contributions.
      Drill into Contributions or Reports for the row-by-row view.
    </p>
    {#if chapterRoleCodes.length > 0}
      <div class="mt-5 flex flex-wrap items-center gap-2">
        <span class="sl-eyebrow" style="font-size:10px">Your roles</span>
        {#each chapterRoleCodes as code (code)}
          <span class="sl-badge sl-badge-accent">{code.replace(/^chapter_/, "").replace(/_/g, " ")}</span>
        {/each}
      </div>
    {/if}
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  {#if loading && !data}
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
    <!-- Stat tiles. -->
    <div class="sl-reveal sl-reveal-2 mt-10 grid grid-cols-2 gap-0 border-y border-[var(--rule)] bg-[var(--card)] md:grid-cols-4">
      <div class="px-6 py-7 border-r border-[var(--rule)]">
        <span class="sl-eyebrow">Active members</span>
        <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
          {data.members.active}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          {data.members.total} total · {data.members.inactive} inactive
        </p>
      </div>
      <div class="px-6 py-7 md:border-r md:border-[var(--rule)]">
        <span class="sl-eyebrow">Pending batches</span>
        <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
          {data.pendingBatches.count}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          {#if data.pendingBatches.perCurrency.length === 0}
            draft · submitted · approved
          {:else}
            {#each data.pendingBatches.perCurrency as t, i (t.currencyCode)}
              <span class:block={i > 0}>{fmt(t)}</span>
            {/each}
          {/if}
        </p>
      </div>
      <div class="border-t border-[var(--rule)] px-6 py-7 md:border-r md:border-t-0 md:border-[var(--rule)]">
        <span class="sl-eyebrow">This week</span>
        <div class="mt-3 sl-display sl-num text-[28px] leading-tight text-[var(--ink)]">
          {#if data.weeklyGiving.perCurrency.length === 0}
            <span class="text-[var(--ink-faint)]">—</span>
          {:else}
            {#each data.weeklyGiving.perCurrency as t, i (t.currencyCode)}
              <span class:block={i > 0}>{fmt(t)}</span>
            {/each}
          {/if}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
          since {data.weeklyGiving.periodStart}
        </p>
      </div>
      <div class="border-t border-[var(--rule)] px-6 py-7 md:border-t-0">
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
          since {data.monthlyGiving.periodStart}
        </p>
      </div>
    </div>

    <!-- Top giving types and top partners. -->
    <div class="sl-reveal sl-reveal-3 mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="sl-card p-5">
        <div class="flex items-baseline justify-between">
          <h2 class="sl-display text-[18px] text-[var(--ink)]">Top giving types · this month</h2>
          <a href="/church/reports" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
            Full report →
          </a>
        </div>
        <div class="mt-4 h-px w-10 bg-[var(--brass)]"></div>
        {#if data.topGivingTypes.length === 0}
          <p class="mt-6 text-[13px] text-[var(--ink-faint)]">No giving recorded this month.</p>
        {:else}
          <table class="mt-4 min-w-full text-[13px]">
            <thead class="text-left text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
              <tr>
                <th class="py-2 pr-2 font-medium">Giving type</th>
                <th class="py-2 pr-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {#each data.topGivingTypes as g (g.id + g.currencyCode)}
                <tr class="border-t border-[var(--rule)]">
                  <td class="py-2 pr-2">
                    {#if g.shortCode}
                      <span class="sl-mono text-[11px] text-[var(--ink-mute)]">{g.shortCode}</span> ·
                    {/if}
                    {g.name}
                  </td>
                  <td class="py-2 pr-2 text-right font-medium text-[var(--ink)]">
                    {fmt({ currencyCode: g.currencyCode, total: g.total })}
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
          <a href="/church/reports" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
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
        <a href="/church/reports" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
          Reports →
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

    <!-- Recent contributions. -->
    <div class="sl-reveal sl-reveal-5 mt-10 sl-card p-5">
      <div class="flex items-baseline justify-between">
        <h2 class="sl-display text-[18px] text-[var(--ink)]">Recent contributions</h2>
        <a href="/church/contributions" class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]">
          All contributions →
        </a>
      </div>
      <div class="mt-4 h-px w-10 bg-[var(--brass)]"></div>
      {#if data.recentContributions.length === 0}
        <p class="mt-6 text-[13px] text-[var(--ink-faint)]">No contributions posted yet.</p>
      {:else}
        <table class="mt-4 min-w-full text-[13px]">
          <thead class="text-left text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
            <tr>
              <th class="py-2 pr-2 font-medium">Date</th>
              <th class="py-2 pr-2 font-medium">Member</th>
              <th class="py-2 pr-2 font-medium">Source</th>
              <th class="py-2 pr-2 font-medium text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {#each data.recentContributions as c (c.id)}
              <tr class="border-t border-[var(--rule)]">
                <td class="py-2 pr-2 text-[var(--ink)]">{c.contributionDate}</td>
                <td class="py-2 pr-2 text-[var(--ink)]">{c.memberName ?? "Anonymous"}</td>
                <td class="py-2 pr-2 text-[var(--ink-mute)]">{c.sourceType}</td>
                <td class="py-2 pr-2 text-right font-medium text-[var(--ink)]">
                  {fmt({ currencyCode: c.currencyCode, total: c.amount })}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Quick links into the rest of the chapter surface. -->
    <div class="sl-reveal sl-reveal-6 mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
      <a href="/church/members" class="sl-card group block p-5 transition-colors hover:bg-[var(--paper-soft)]">
        <span class="sl-eyebrow">People</span>
        <h2 class="mt-2 sl-display text-[18px] text-[var(--ink)] group-hover:text-[var(--brass-deep)]">Members directory</h2>
        <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">Add and edit the people of {chapter()?.name ?? "your chapter"}.</p>
      </a>
      <a href="/church/contributions" class="sl-card group block p-5 transition-colors hover:bg-[var(--paper-soft)]">
        <span class="sl-eyebrow">Giving</span>
        <h2 class="mt-2 sl-display text-[18px] text-[var(--ink)] group-hover:text-[var(--brass-deep)]">Contributions journal</h2>
        <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">Sunday batches, online gifts, reconciliations.</p>
      </a>
      <a href="/church/reports" class="sl-card group block p-5 transition-colors hover:bg-[var(--paper-soft)]">
        <span class="sl-eyebrow">Output</span>
        <h2 class="mt-2 sl-display text-[18px] text-[var(--ink)] group-hover:text-[var(--brass-deep)]">Reports</h2>
        <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">Statements, member lists, and ledger exports.</p>
      </a>
    </div>

    <p class="sl-reveal sl-reveal-7 mt-10 text-[11px] text-[var(--ink-faint)]">
      Generated {fmtDateTime(data.asOf, data.timeZone)} · {data.timeZone}
    </p>
  {/if}
</div>
