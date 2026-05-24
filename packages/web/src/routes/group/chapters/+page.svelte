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

<svelte:head><title>Group chapters · StewardLedger</title></svelte:head>

<div class="sl-reveal sl-reveal-1">
  <span class="sl-eyebrow">§ I · Group chapters</span>
  <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
    Chapters in this <span class="sl-serif-italic font-light text-[var(--brass-deep)]">group</span>
  </h1>
  <p class="mt-2 text-[14px] text-[var(--ink-mute)]">Chapters bound to your group(s).</p>
</div>

{#if loading}
  <p class="mt-8 text-[13px] text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="mt-8 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{error}</p>
{:else}
  <div class="sl-reveal sl-reveal-2 mt-8">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Chapter roster</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {chapters.length} {chapters.length === 1 ? "row" : "rows"}
      </span>
    </div>
    <div class="sl-card overflow-hidden">
      <table class="sl-table">
        <thead>
          <tr>
            <th>Reference</th>
            <th>Name</th>
            <th>Country</th>
            <th>From</th>
          </tr>
        </thead>
        <tbody>
          {#each chapters as c (c.id)}
            <tr>
              <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{c.referenceCode}</td>
              <td class="text-[var(--ink)]">{c.name}</td>
              <td class="text-[var(--ink-soft)]">{c.countryCode ?? "—"}</td>
              <td class="sl-mono text-[12px] text-[var(--ink-mute)]">{c.dateFrom}</td>
            </tr>
          {/each}
          {#if chapters.length === 0}
            <tr><td colspan="4" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">No chapters visible in this group.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>
{/if}
