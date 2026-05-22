<!--
  packages/web/src/routes/group/chapters/+page.svelte
  Lists chapters visible to the caller (API narrows via visibleChapterIds).
  Skeleton table only — polish pass later.
  RELEVANT FILES: ../+layout.svelte, /api/tenant/chapters
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";

  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    groupId?: string | null;
  };

  let chapters = $state<Chapter[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      const res = await api.get<{ items: Chapter[] }>("/api/tenant/chapters");
      chapters = res.items;
      error = null;
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not load chapters";
    } finally {
      loading = false;
    }
  }

  onMount(refresh);
</script>

<h1 class="text-2xl font-bold mb-4">Chapters in this group</h1>
{#if loading}
  <p class="text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="text-red-600">{error}</p>
{:else if chapters.length === 0}
  <p class="text-[var(--ink-mute)]">No chapters visible in this group.</p>
{:else}
  <table class="w-full text-left text-[13px] border-collapse">
    <thead class="border-b border-[var(--rule)]">
      <tr>
        <th class="py-2 pr-4 font-medium">Reference</th>
        <th class="py-2 pr-4 font-medium">Name</th>
        <th class="py-2 pr-4 font-medium">Country</th>
        <th class="py-2 pr-4 font-medium">From</th>
      </tr>
    </thead>
    <tbody>
      {#each chapters as c (c.id)}
        <tr class="border-b border-[var(--rule)]">
          <td class="py-2 pr-4 sl-mono">{c.referenceCode}</td>
          <td class="py-2 pr-4">{c.name}</td>
          <td class="py-2 pr-4">{c.countryCode ?? "—"}</td>
          <td class="py-2 pr-4">{c.dateFrom}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
