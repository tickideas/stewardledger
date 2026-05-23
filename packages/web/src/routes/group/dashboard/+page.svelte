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

<h1 class="text-2xl font-bold mb-4">Group dashboard</h1>
{#if loading}
  <p class="text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="text-red-600">{error}</p>
{:else}
  <pre class="text-xs bg-[var(--paper-soft)] p-3 rounded overflow-x-auto">{JSON.stringify(data, null, 2)}</pre>
{/if}
