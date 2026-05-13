<!-- packages/web/src/routes/church/members/+page.svelte -->
<!-- Chapter-scoped member directory and member creation surface. -->
<!-- Exists so chapter users manage only the active chapter selected in the church shell. -->
<!-- RELEVANT FILES: packages/web/src/routes/church/+layout.svelte, packages/web/src/lib/active-chapter.svelte.ts, packages/api/src/routes/tenant-members.ts -->

<script lang="ts">
  // Chapter-scoped members directory. Forks /zone/members but drops the
  // chapter filter (there's only one chapter in scope) and the create flow's
  // chapter picker (members are created in the active chapter, full stop).
  //
  // Detail pages still live under /zone/members/[id] — those screens render
  // identically regardless of how you arrived, and the back-link header on
  // the detail page handles wherever you came from.

  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";

  type Member = {
    id: string;
    referenceCode: string;
    firstName: string;
    middleNames: string | null;
    lastName: string | null;
    fullName: string | null;
    email: string | null;
    mobile: string | null;
    chapterId: string | null;
    isActive: boolean;
    createdAt: string;
  };

  const chapter = useActiveChapter();

  let q = $state("");
  let items = $state<Member[]>([]);
  let total = $state<number | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let refreshToken = 0;

  let createOpen = $state(false);
  let cFirst = $state("");
  let cLast = $state("");
  let cEmail = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  async function refresh(signal: AbortSignal) {
    const here = chapter();
    if (!here) {
      // No chapter selected yet — the layout's effect will set one as soon
      // as the session resolves. Render the empty state until then.
      items = [];
      total = null;
      return;
    }
    const my = ++refreshToken;
    loading = true;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      params.set("chapterId", here.id);
      const res = await api.get<{ items: Member[] }>(
        `/api/tenant/members?${params.toString()}`,
        signal,
      );
      if (my !== refreshToken) return;
      items = res.items;
      total = res.items.length;
      loadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load members.";
    } finally {
      if (my === refreshToken) loading = false;
    }
  }

  $effect(() => {
    void chapter()?.id;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const here = chapter();
    if (!here) return;
    createError = null;
    creating = true;
    try {
      await api.post("/api/tenant/members", {
        firstName: cFirst,
        lastName: cLast || undefined,
        email: cEmail || undefined,
        chapterId: here.id,
      });
      cFirst = "";
      cLast = "";
      cEmail = "";
      createOpen = false;
      const controller = new AbortController();
      await refresh(controller.signal);
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create member.";
    } finally {
      creating = false;
    }
  }
</script>

<svelte:head><title>Members · {chapter()?.name ?? "Chapter"} · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ Chapter II · People</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        {chapter()?.name ?? "Chapter"} <span class="sl-serif-italic font-light text-[var(--brass-deep)]">members</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        {#if total !== null}
          {total} {total === 1 ? "member" : "members"} in this chapter
        {:else}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {/if}
      </p>
    </div>
    {#if chapter()}
      <button type="button" class="sl-btn sl-btn-primary" onclick={() => (createOpen = !createOpen)}>
        {#if createOpen}Cancel{:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
          </svg>
          New member
        {/if}
      </button>
    {/if}
  </div>

  {#if createOpen && chapter()}
    <form class="sl-reveal sl-card-warm mt-6 grid grid-cols-12 gap-3 p-6" onsubmit={create}>
      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">First name</span>
        <input type="text" required minlength="1" maxlength="120" bind:value={cFirst} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Last name</span>
        <input type="text" maxlength="120" bind:value={cLast} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
        <input type="email" bind:value={cEmail} class="sl-input mt-1.5" />
      </label>
      <div class="col-span-12 flex items-end sm:col-span-1">
        <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">Add</button>
      </div>
      {#if createError}
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
      {/if}
    </form>
  {/if}

  <div class="sl-reveal sl-reveal-2 mt-8 flex flex-wrap items-center gap-3">
    <div class="relative flex-1 min-w-64">
      <svg class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-mute)]" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.25"/>
        <path d="M9 9l3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <input
        type="search"
        bind:value={q}
        placeholder="Search name, email, code…"
        onkeydown={(e) => {
          if (e.key === "Enter") {
            const controller = new AbortController();
            refresh(controller.signal);
          }
        }}
        class="sl-input pl-9"
      />
    </div>
    <button class="sl-btn sl-btn-ghost" onclick={() => { const c = new AbortController(); refresh(c.signal); }}>Search</button>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else}
    <div class="sl-reveal sl-reveal-3 mt-8">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Index of members</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {items.length} {items.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Email</th>
              <th>Mobile</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each items as m (m.id)}
              <tr>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.04em">{m.referenceCode}</td>
                <td>
                  <a href={`/zone/members/${m.id}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                    {m.fullName || `${m.firstName} ${m.lastName ?? ""}`.trim()}
                  </a>
                </td>
                <td class="text-[var(--ink-soft)]">{m.email ?? "—"}</td>
                <td class="text-[var(--ink-soft)] sl-mono text-[12px]">{m.mobile ?? "—"}</td>
                <td>
                  {#if m.isActive}
                    <span class="sl-badge sl-badge-ok">active</span>
                  {:else}
                    <span class="sl-badge sl-badge-mute">inactive</span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if !loading && items.length === 0}
              <tr>
                <td colspan="5" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                  {chapter() ? "No members in this chapter yet." : "Select a chapter to see members."}
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
