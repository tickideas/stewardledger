<!-- packages/web/src/routes/zone/groups/[id]/+page.svelte -->
<!-- Group detail: shows group metadata + chapters assigned to the group. -->
<!-- Chapters list endpoint is zone-wide so we filter client-side by groupId. -->
<!-- RELEVANT FILES: ../+page.svelte, packages/api/src/routes/tenant-groups.ts -->

<script lang="ts">
  import { page } from "$app/stores";
  import { api, ApiError } from "$lib/api";

  type GroupDetail = {
    id: string;
    slug: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    chapterCount: number;
  };
  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    groupId: string | null;
    dateFrom: string;
    activeMemberCount: number;
  };

  const id = $derived($page.params.id);
  let group = $state<GroupDetail | null>(null);
  let chapters = $state<Chapter[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);

  async function load() {
    loading = true;
    notFound = false;
    loadError = null;
    try {
      const [groupRes, chaptersRes] = await Promise.all([
        api.get<{ group: GroupDetail }>(`/api/tenant/groups/${id}`),
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
      ]);
      group = groupRes.group;
      chapters = chaptersRes.items.filter((c) => c.groupId === id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        notFound = true;
      } else {
        loadError = err instanceof ApiError ? err.message : "Could not load group.";
      }
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (id) load();
  });
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <a href="/zone/groups" class="sl-mono text-[12px] text-[var(--ink-mute)] hover:text-[var(--brass-deep)]" style="letter-spacing:0.08em">
    ← BACK TO GROUPS
  </a>

  {#if loading}
    <div class="mt-10 sl-card p-12 text-center text-[var(--ink-mute)]">
      <span class="sl-mono text-[12px]" style="letter-spacing:0.16em">LOADING…</span>
    </div>
  {:else if notFound}
    <div class="sl-reveal mt-10 sl-card flex flex-col items-center justify-center p-16 text-center">
      <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">∅</span>
      <p class="mt-4 sl-display text-[18px] italic text-[var(--ink)]">Group not found.</p>
    </div>
  {:else if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if group}
    <div class="sl-reveal sl-reveal-1 mt-4">
      <span class="sl-eyebrow">§ I · Church administration</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">{group.name}</h1>
      <p class="mt-2 sl-mono text-[12px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">
        {group.slug} · {group.chapterCount} {group.chapterCount === 1 ? "chapter" : "chapters"}
      </p>
    </div>

    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Chapters</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {chapters.length} {chapters.length === 1 ? "row" : "rows"}
        </span>
      </div>
      {#if chapters.length === 0}
        <div class="sl-card p-12 text-center text-[var(--ink-mute)]">
          <p class="sl-display text-[16px] italic text-[var(--ink)]">No chapters in this group.</p>
        </div>
      {:else}
        <div class="sl-card overflow-hidden">
          <table class="sl-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Name</th>
                <th>Country</th>
                <th>Members</th>
                <th>Active since</th>
              </tr>
            </thead>
            <tbody>
              {#each chapters as chapter (chapter.id)}
                <tr>
                  <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">{chapter.referenceCode}</td>
                  <td>
                    <a href={`/zone/chapters/${chapter.id}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                      {chapter.name}
                    </a>
                  </td>
                  <td class="sl-mono text-[12px] uppercase text-[var(--ink-soft)]">{chapter.countryCode ?? "—"}</td>
                  <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{chapter.activeMemberCount}</td>
                  <td class="sl-mono text-[12px] text-[var(--ink-soft)]">
                    {new Date(chapter.dateFrom).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>
