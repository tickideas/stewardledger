<!--
  packages/web/src/routes/group/administrators/+page.svelte
  Lists administrators (zone-wide; endpoint requires zone-tier access).
  group_admin callers see a 403 message.
  RELEVANT FILES: ../+layout.svelte, /api/tenant/administrators
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";

  type Admin = {
    bindingId: string;
    userId: string;
    email: string;
    name: string | null;
    roleCode: string;
    roleName: string;
    roleScope: "zone" | "group" | "chapter";
    chapterId: string | null;
    chapterName: string | null;
    chapterReferenceCode: string | null;
    groupId: string | null;
    groupName: string | null;
    groupSlug: string | null;
    grantedAt: string;
  };

  let admins = $state<Admin[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      const res = await api.get<{ items: Admin[] }>("/api/tenant/administrators");
      admins = res.items;
      error = null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        error = "Administrator management requires zone-tier access. Contact your zone admin.";
      } else {
        error = err instanceof ApiError ? err.message : "Could not load administrators";
      }
    } finally {
      loading = false;
    }
  }

  onMount(refresh);
</script>

<h1 class="text-2xl font-bold mb-4">Administrators</h1>
{#if loading}
  <p class="text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="text-[var(--ink-mute)]">{error}</p>
{:else if admins.length === 0}
  <p class="text-[var(--ink-mute)]">No administrators found.</p>
{:else}
  <table class="w-full text-left text-[13px] border-collapse">
    <thead class="border-b border-[var(--rule)]">
      <tr>
        <th class="py-2 pr-4 font-medium">Email</th>
        <th class="py-2 pr-4 font-medium">Role</th>
        <th class="py-2 pr-4 font-medium">Scope</th>
        <th class="py-2 pr-4 font-medium">Target</th>
      </tr>
    </thead>
    <tbody>
      {#each admins as a (a.bindingId)}
        <tr class="border-b border-[var(--rule)]">
          <td class="py-2 pr-4">{a.email}</td>
          <td class="py-2 pr-4">{a.roleCode}</td>
          <td class="py-2 pr-4">{a.roleScope}</td>
          <td class="py-2 pr-4">{a.chapterName ?? a.groupName ?? "—"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
