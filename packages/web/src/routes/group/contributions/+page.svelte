<!--
  packages/web/src/routes/group/contributions/+page.svelte
  Lists contributions visible to the caller (API narrows via visibleChapterIds).
  Skeleton table only — first 50, no pagination yet.
  RELEVANT FILES: ../+layout.svelte, /api/tenant/contributions
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";

  type Contribution = {
    id: string;
    contributionDate: string;
    totalAmount: string;
    chapterId: string;
    status: string;
    sourceType: string;
    currencyCode: string;
  };

  let contributions = $state<Contribution[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      const res = await api.get<{ items: Contribution[] }>("/api/tenant/contributions?limit=50");
      contributions = res.items;
      error = null;
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not load contributions";
    } finally {
      loading = false;
    }
  }

  onMount(refresh);
</script>

<svelte:head><title>Group contributions · StewardLedger</title></svelte:head>

<div class="sl-reveal sl-reveal-1">
  <span class="sl-eyebrow">§ Daily ledger · Group</span>
  <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
    Contributions in this <span class="sl-serif-italic font-light text-[var(--brass-deep)]">group</span>
  </h1>
  <p class="mt-2 text-[14px] text-[var(--ink-mute)]">First 50 contributions across the chapters bound to your group(s).</p>
</div>

{#if loading}
  <p class="mt-8 text-[13px] text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="mt-8 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{error}</p>
{:else}
  <div class="sl-reveal sl-reveal-2 mt-8">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Ledger</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {contributions.length} {contributions.length === 1 ? "row" : "rows"}
      </span>
    </div>
    <div class="sl-card overflow-hidden">
      <table class="sl-table">
        <thead>
          <tr>
            <th>Date</th>
            <th class="!text-right">Total</th>
            <th>Currency</th>
            <th>Chapter</th>
            <th>Status</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {#each contributions as c (c.id)}
            <tr>
              <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{c.contributionDate}</td>
              <td class="sl-num text-right text-[var(--ink)]">{c.totalAmount}</td>
              <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{c.currencyCode}</td>
              <td class="sl-mono text-[12px] text-[var(--ink-mute)]">{c.chapterId}</td>
              <td>
                <span class={`sl-badge ${
                  c.status === "posted" ? "sl-badge-ok" :
                  c.status === "voided" ? "sl-badge-mute" :
                  c.status === "reversed" ? "sl-badge-bad" :
                  "sl-badge-mute"
                }`}>{c.status}</span>
              </td>
              <td class="text-[var(--ink-soft)]">{c.sourceType}</td>
            </tr>
          {/each}
          {#if contributions.length === 0}
            <tr><td colspan="6" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">No contributions visible in this group.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>
{/if}
