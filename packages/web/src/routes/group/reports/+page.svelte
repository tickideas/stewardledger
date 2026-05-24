<!--
  packages/web/src/routes/group/reports/+page.svelte
  Lists report specs available to the caller. Data is narrowed via
  visibleChapterIds when running an individual report.
  RELEVANT FILES: ../+layout.svelte, /api/tenant/reports
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";

  type ReportSpec = { id: string; name: string; description?: string };

  let reports = $state<ReportSpec[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      const res = await api.get<{ items: ReportSpec[] }>("/api/tenant/reports");
      reports = res.items;
      error = null;
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not load reports";
    } finally {
      loading = false;
    }
  }

  onMount(refresh);
</script>

<svelte:head><title>Group reports · StewardLedger</title></svelte:head>

<div class="sl-reveal sl-reveal-1">
  <span class="sl-eyebrow">§ Output · Group reports</span>
  <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
    Group <span class="sl-serif-italic font-light text-[var(--brass-deep)]">reports</span>
  </h1>
  <p class="mt-2 text-[14px] text-[var(--ink-mute)]">Reports narrowed to the chapters bound to your group(s).</p>
</div>

{#if loading}
  <p class="mt-8 text-[13px] text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="mt-8 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{error}</p>
{:else}
  <div class="sl-reveal sl-reveal-2 mt-8">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Available reports</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {reports.length} {reports.length === 1 ? "report" : "reports"}
      </span>
    </div>
    {#if reports.length === 0}
      <div class="sl-card p-10 text-center text-[13px] text-[var(--ink-mute)]">No reports available.</div>
    {:else}
      <ul class="sl-card divide-y divide-[var(--rule)] overflow-hidden">
        {#each reports as r (r.id)}
          <li class="px-5 py-4">
            <div class="sl-display text-[16px] text-[var(--ink)]">{r.name}</div>
            {#if r.description}
              <div class="mt-1 text-[12.5px] text-[var(--ink-mute)]">{r.description}</div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
