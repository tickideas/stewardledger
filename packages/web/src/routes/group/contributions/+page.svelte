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

<h1 class="text-2xl font-bold mb-4">Contributions in this group</h1>
{#if loading}
  <p class="text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="text-red-600">{error}</p>
{:else if contributions.length === 0}
  <p class="text-[var(--ink-mute)]">No contributions visible in this group.</p>
{:else}
  <table class="w-full text-left text-[13px] border-collapse">
    <thead class="border-b border-[var(--rule)]">
      <tr>
        <th class="py-2 pr-4 font-medium">Date</th>
        <th class="py-2 pr-4 font-medium">Total</th>
        <th class="py-2 pr-4 font-medium">Currency</th>
        <th class="py-2 pr-4 font-medium">Chapter</th>
        <th class="py-2 pr-4 font-medium">Status</th>
        <th class="py-2 pr-4 font-medium">Source</th>
      </tr>
    </thead>
    <tbody>
      {#each contributions as c (c.id)}
        <tr class="border-b border-[var(--rule)]">
          <td class="py-2 pr-4">{c.contributionDate}</td>
          <td class="py-2 pr-4 sl-mono">{c.totalAmount}</td>
          <td class="py-2 pr-4">{c.currencyCode}</td>
          <td class="py-2 pr-4 sl-mono">{c.chapterId}</td>
          <td class="py-2 pr-4">{c.status}</td>
          <td class="py-2 pr-4">{c.sourceType}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
