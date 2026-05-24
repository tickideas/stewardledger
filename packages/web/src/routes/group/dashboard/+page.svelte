<!--
  packages/web/src/routes/group/dashboard/+page.svelte
  Group-tier dashboard. Renders the zone dashboard payload narrowed to the
  caller's chapters (API narrows via visibleChapterIds).
  RELEVANT FILES: ../+layout.svelte, /api/tenant/dashboard
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";

  let data = $state<unknown>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      data = await api.get("/api/tenant/dashboard/zone");
      error = null;
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not load dashboard";
    } finally {
      loading = false;
    }
  }

  onMount(refresh);
</script>

<svelte:head><title>Group dashboard · StewardLedger</title></svelte:head>

<div class="sl-reveal sl-reveal-1">
  <span class="sl-eyebrow">§ Insight · Group</span>
  <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
    Group <span class="sl-serif-italic font-light text-[var(--brass-deep)]">dashboard</span>
  </h1>
  <p class="mt-2 text-[14px] text-[var(--ink-mute)]">Aggregated view across the chapters bound to this group.</p>
</div>

{#if loading}
  <p class="mt-8 text-[13px] text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="mt-8 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{error}</p>
{:else}
  <pre class="sl-card sl-mono mt-8 max-h-[60vh] overflow-auto p-4 text-[11.5px] text-[var(--ink-soft)]">{JSON.stringify(data, null, 2)}</pre>
{/if}
