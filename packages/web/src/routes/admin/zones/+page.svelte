<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";
  import { fmtMoney } from "$lib/format";
  import { statusBadgeClass } from "$lib/ui";
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
  let inviteFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function onInvited() {
    inviteFlash = "Invitation sent. The new zone is in pending_setup until the contact accepts.";
    refresh();
    if (inviteFlashTimer) clearTimeout(inviteFlashTimer);
    inviteFlashTimer = setTimeout(() => {
      inviteFlash = null;
      inviteFlashTimer = null;
    }, 6000);
  }

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
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
      if (epoch !== fetchEpoch) return;
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
      if (inviteFlashTimer) clearTimeout(inviteFlashTimer);
    };
  });

  function onQueryInput(value: string) {
    query = value;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => refresh(), 200);
  }

  // Aggregate KPIs across the loaded page — gives the dashboard headline numbers
  const kpiActive = $derived(zones.filter((z) => z.status === "active").length);
  const kpiPending = $derived(zones.filter((z) => z.status === "pending_setup").length);
  const kpiChapters = $derived(zones.reduce((s, z) => s + z.chapterCount, 0));
  const kpiMembers = $derived(zones.reduce((s, z) => s + z.memberCount, 0));
</script>

<div class="py-10">
  <!-- Title block -->
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ Section I · Tenants</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Zones <span class="sl-serif-italic font-light text-[var(--brass-deep)]">register</span>
      </h1>
      <p class="mt-2 max-w-xl text-[14px] text-[var(--ink-mute)]">
        Every tenant on this StewardLedger deployment. Read-only cross-zone view —
        every figure below ties back to a posted journal entry.
      </p>
    </div>
    <div class="flex items-center gap-3">
      <div class="relative">
        <svg class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-mute)]" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.25"/>
          <path d="M9 9l3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        <input
          type="search"
          value={query}
          oninput={(e) => onQueryInput((e.target as HTMLInputElement).value)}
          placeholder="Search by name, slug, region…"
          class="sl-input w-72 pl-9"
        />
      </div>
      <button type="button" onclick={() => (inviteOpen = true)} class="sl-btn sl-btn-primary">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        Invite zone
      </button>
    </div>
  </div>

  <!-- KPI strip -->
  <div class="sl-reveal sl-reveal-2 mt-10 grid grid-cols-2 gap-0 border-y border-[var(--rule)] bg-[var(--card)] md:grid-cols-4">
    {#each [
      { label: "Active",      value: kpiActive,    sub: "zones in production" },
      { label: "Pending",     value: kpiPending,   sub: "awaiting acceptance" },
      { label: "Chapters",    value: kpiChapters,  sub: "across all zones" },
      { label: "Members",     value: kpiMembers,   sub: "indexed identities" },
    ] as kpi, i}
      <div class="px-6 py-7 md:border-r md:border-[var(--rule)] md:last:border-r-0" class:border-b={i < 2} class:md:border-b-0={i < 2} style="border-color:var(--rule)">
        <span class="sl-eyebrow">{kpi.label}</span>
        <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
          {kpi.value.toLocaleString()}
        </div>
        <p class="mt-2 text-[12px] text-[var(--ink-mute)]">{kpi.sub}</p>
      </div>
    {/each}
  </div>

  {#if inviteFlash}
    <p class="sl-reveal mt-6 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-4 py-3 text-[13px] text-[var(--ink-soft)]">
      {inviteFlash}
    </p>
  {/if}

  <InviteZoneModal bind:open={inviteOpen} oninvited={onInvited} />

  <!-- Table -->
  <div class="sl-reveal sl-reveal-3 mt-10">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Ledger of zones</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {zones.length} {zones.length === 1 ? "row" : "rows"}{nextCursor ? " · more available" : ""}
      </span>
    </div>

    {#if loadError}
      <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-4 py-3 text-[13px] text-[var(--bad)]">{loadError}</p>
    {:else if loading && zones.length === 0}
      <div class="sl-card p-12 text-center text-[13px] text-[var(--ink-mute)]">
        <span class="sl-mono" style="letter-spacing:0.16em">LOADING…</span>
      </div>
    {:else if zones.length === 0}
      <div class="sl-card p-12 text-center text-[14px] text-[var(--ink-mute)]">
        {#if query.trim().length > 0}
          No zones match <code class="sl-mono text-[var(--ink)]">{query}</code>.
        {:else}
          No zones yet. Run <code class="sl-mono text-[var(--ink)]">pnpm seed:demo</code>, or use
          <strong class="text-[var(--ink)]">Invite zone</strong> to onboard one.
        {/if}
      </div>
    {:else}
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Zone</th>
              <th>Region</th>
              <th>Status</th>
              <th class="!text-right">Chapters</th>
              <th class="!text-right">Members</th>
              <th class="!text-right">Contributions</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {#each zones as z (z.id)}
              <tr>
                <td>
                  <a href={`/admin/zones/${z.slug}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                    {z.name}
                  </a>
                  <div class="mt-1 flex items-center gap-2 sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">
                    <span>{z.slug}</span>
                    <span class="text-[var(--rule-strong)]">·</span>
                    <span>{z.countryCode}</span>
                    <span class="text-[var(--rule-strong)]">·</span>
                    <span>{z.defaultCurrencyCode}</span>
                  </div>
                </td>
                <td class="text-[var(--ink-soft)]">
                  {#if z.regionName}
                    {z.regionName}
                  {:else if z.regionNameUnverified}
                    <span class="text-[var(--warn)]">{z.regionNameUnverified}</span>
                    <span class="ml-1 sl-mono text-[10px] text-[var(--warn)]">(unverified)</span>
                  {:else}
                    <span class="text-[var(--ink-faint)]">—</span>
                  {/if}
                </td>
                <td>
                  <span class={statusBadgeClass(z.status)}>{z.status.replace("_", " ")}</span>
                </td>
                <td class="text-right sl-mono sl-num text-[var(--ink)]">{z.chapterCount}</td>
                <td class="text-right sl-mono sl-num text-[var(--ink)]">{z.memberCount}</td>
                <td class="text-right">
                  <div class="sl-mono sl-num text-[var(--ink)]">
                    {fmtMoney(z.postedContributionTotal, z.postedContributionCurrency, 2)}
                  </div>
                  {#if z.postedContributionSubtotals.length > 1}
                    <div class="mt-0.5 text-[11px] text-[var(--warn)]" title={z.postedContributionSubtotals.map((s) => `${s.currencyCode}: ${s.total}`).join(", ")}>
                      +{z.postedContributionSubtotals.length - 1} more {z.postedContributionSubtotals.length === 2 ? "currency" : "currencies"}
                    </div>
                  {/if}
                  <div class="mt-0.5 sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">
                    {z.postedContributionCount} posted
                  </div>
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  {new Date(z.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if nextCursor}
      <div class="mt-6 flex justify-center">
        <button
          type="button"
          onclick={() => refresh({ append: true, cursor: nextCursor })}
          disabled={loadingMore}
          class="sl-btn sl-btn-ghost"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      </div>
    {/if}
  </div>
</div>
