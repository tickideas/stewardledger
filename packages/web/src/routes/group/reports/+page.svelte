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

<h1 class="text-2xl font-bold mb-4">Reports</h1>
{#if loading}
  <p class="text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="text-red-600">{error}</p>
{:else if reports.length === 0}
  <p class="text-[var(--ink-mute)]">No reports available.</p>
{:else}
  <ul class="space-y-2">
    {#each reports as r (r.id)}
      <li class="border-b border-[var(--rule)] py-2">
        <div class="font-medium">{r.name}</div>
        {#if r.description}
          <div class="text-xs text-[var(--ink-mute)]">{r.description}</div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
