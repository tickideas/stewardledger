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

<svelte:head><title>Group administrators · StewardLedger</title></svelte:head>

<div class="sl-reveal sl-reveal-1">
  <span class="sl-eyebrow">§ Settings · Group access</span>
  <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
    Group <span class="sl-serif-italic font-light text-[var(--brass-deep)]">administrators</span>
  </h1>
  <p class="mt-2 text-[14px] text-[var(--ink-mute)]">Read-only view of zone administrators visible to this group.</p>
</div>

{#if loading}
  <p class="mt-8 text-[13px] text-[var(--ink-mute)]">Loading…</p>
{:else if error}
  <p class="mt-8 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-[13px] text-[var(--warn)]">{error}</p>
{:else}
  <div class="sl-reveal sl-reveal-2 mt-8">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Roster</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {admins.length} {admins.length === 1 ? "row" : "rows"}
      </span>
    </div>
    <div class="sl-card overflow-hidden">
      <table class="sl-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Scope</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {#each admins as a (a.bindingId)}
            <tr>
              <td class="text-[var(--ink)]">{a.email}</td>
              <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{a.roleCode}</td>
              <td class="text-[var(--ink-soft)]">{a.roleScope}</td>
              <td class="text-[var(--ink-soft)]">{a.chapterName ?? a.groupName ?? "—"}</td>
            </tr>
          {/each}
          {#if admins.length === 0}
            <tr><td colspan="4" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">No administrators found.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>
{/if}
