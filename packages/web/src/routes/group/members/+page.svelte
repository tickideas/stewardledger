<!--
  packages/web/src/routes/group/members/+page.svelte
  Lists members visible to the caller (API narrows via visibleChapterIds).
  Skeleton table only — first 50, no pagination yet.
  RELEVANT FILES: ../+layout.svelte, /api/tenant/members
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";

  type Member = {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
    chapterId: string | null;
  };

  let members = $state<Member[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      const res = await api.get<{ items: Member[] }>("/api/tenant/members?limit=50");
      members = res.items;
      error = null;
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not load members";
    } finally {
      loading = false;
    }
  }

  onMount(refresh);
</script>

<svelte:head><title>Group members · StewardLedger</title></svelte:head>

<div class="sl-reveal sl-reveal-1">
  <span class="sl-eyebrow">§ II · Group members</span>
  <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
    Members in this <span class="sl-serif-italic font-light text-[var(--brass-deep)]">group</span>
  </h1>
  <p class="mt-2 text-[14px] text-[var(--ink-mute)]">First 50 members across the chapters bound to your group(s).</p>
</div>

{#if loading}
  <p class="mt-8 text-[13px] text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="mt-8 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{error}</p>
{:else}
  <div class="sl-reveal sl-reveal-2 mt-8">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Index of members</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {members.length} {members.length === 1 ? "row" : "rows"}
      </span>
    </div>
    <div class="sl-card overflow-hidden">
      <table class="sl-table">
        <thead>
          <tr>
            <th>First name</th>
            <th>Last name</th>
            <th>Email</th>
            <th>Chapter</th>
          </tr>
        </thead>
        <tbody>
          {#each members as m (m.id)}
            <tr>
              <td class="text-[var(--ink)]">{m.firstName}</td>
              <td class="text-[var(--ink-soft)]">{m.lastName ?? "—"}</td>
              <td class="text-[var(--ink-soft)]">{m.email ?? "—"}</td>
              <td class="sl-mono text-[12px] text-[var(--ink-mute)]">{m.chapterId ?? "—"}</td>
            </tr>
          {/each}
          {#if members.length === 0}
            <tr><td colspan="4" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">No members visible in this group.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>
{/if}
