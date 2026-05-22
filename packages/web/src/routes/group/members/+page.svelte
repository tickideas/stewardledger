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

<h1 class="text-2xl font-bold mb-4">Members in this group</h1>
{#if loading}
  <p class="text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="text-red-600">{error}</p>
{:else if members.length === 0}
  <p class="text-[var(--ink-mute)]">No members visible in this group.</p>
{:else}
  <table class="w-full text-left text-[13px] border-collapse">
    <thead class="border-b border-[var(--rule)]">
      <tr>
        <th class="py-2 pr-4 font-medium">First name</th>
        <th class="py-2 pr-4 font-medium">Last name</th>
        <th class="py-2 pr-4 font-medium">Email</th>
        <th class="py-2 pr-4 font-medium">Chapter</th>
      </tr>
    </thead>
    <tbody>
      {#each members as m (m.id)}
        <tr class="border-b border-[var(--rule)]">
          <td class="py-2 pr-4">{m.firstName}</td>
          <td class="py-2 pr-4">{m.lastName ?? "—"}</td>
          <td class="py-2 pr-4">{m.email ?? "—"}</td>
          <td class="py-2 pr-4 sl-mono">{m.chapterId ?? "—"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
