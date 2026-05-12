<script lang="ts">
  import { api, ApiError } from "$lib/api";

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

  type Chapter = { id: string; name: string };

  let q = $state("");
  let chapterId = $state("");
  let items = $state<Member[]>([]);
  let chapters = $state<Chapter[]>([]);
  let total = $state<number | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  let createOpen = $state(false);
  let cFirst = $state("");
  let cLast = $state("");
  let cEmail = $state("");
  let cChapter = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  async function refresh() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (chapterId) params.set("chapterId", chapterId);
      const res = await api.get<{ items: Member[] }>(
        `/api/tenant/members?${params.toString()}`,
      );
      items = res.items;
      total = res.items.length;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load members.";
    } finally {
      loading = false;
    }
  }

  async function loadChapters() {
    try {
      const res = await api.get<{ items: Chapter[] }>("/api/tenant/chapters");
      chapters = res.items;
    } catch {
      chapters = [];
    }
  }

  $effect(() => {
    loadChapters();
    refresh();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    createError = null;
    creating = true;
    try {
      await api.post("/api/tenant/members", {
        firstName: cFirst,
        lastName: cLast || undefined,
        email: cEmail || undefined,
        chapterId: cChapter || undefined,
      });
      cFirst = "";
      cLast = "";
      cEmail = "";
      cChapter = "";
      createOpen = false;
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create member.";
    } finally {
      creating = false;
    }
  }
</script>

<div class="py-8">
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Members</h1>
      <p class="mt-1 text-sm text-slate-600">
        {#if total !== null}
          {total} {total === 1 ? "member" : "members"}
        {:else}
          Loading…
        {/if}
      </p>
    </div>
    <button
      class="inline-flex items-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
      onclick={() => (createOpen = !createOpen)}
    >
      {createOpen ? "Cancel" : "New member"}
    </button>
  </div>

  {#if createOpen}
    <form class="mt-6 grid grid-cols-12 gap-3 p-4 border rounded-lg bg-slate-50" onsubmit={create}>
      <input
        type="text"
        required
        minlength="1"
        maxlength="120"
        bind:value={cFirst}
        placeholder="First name"
        class="col-span-12 sm:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        type="text"
        maxlength="120"
        bind:value={cLast}
        placeholder="Last name"
        class="col-span-12 sm:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        type="email"
        bind:value={cEmail}
        placeholder="Email"
        class="col-span-12 sm:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <select
        bind:value={cChapter}
        class="col-span-12 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="">No chapter</option>
        {#each chapters as ch}
          <option value={ch.id}>{ch.name}</option>
        {/each}
      </select>
      <button
        type="submit"
        disabled={creating}
        class="col-span-12 sm:col-span-1 inline-flex items-center justify-center px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        Add
      </button>
      {#if createError}
        <p class="col-span-12 text-sm text-red-600">{createError}</p>
      {/if}
    </form>
  {/if}

  <div class="mt-6 flex gap-3">
    <input
      type="search"
      bind:value={q}
      placeholder="Search name, email, code…"
      onkeydown={(e) => e.key === "Enter" && refresh()}
      class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
    />
    <select
      bind:value={chapterId}
      onchange={refresh}
      class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
    >
      <option value="">All chapters</option>
      {#each chapters as ch}
        <option value={ch.id}>{ch.name}</option>
      {/each}
    </select>
    <button
      class="px-3 py-2 rounded-lg border border-slate-300 text-sm hover:bg-slate-100"
      onclick={refresh}
    >
      Search
    </button>
  </div>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else}
    <table class="mt-6 w-full text-sm">
      <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">Code</th>
          <th class="py-2">Name</th>
          <th class="py-2">Email</th>
          <th class="py-2">Mobile</th>
          <th class="py-2">Status</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each items as m}
          <tr class="hover:bg-slate-50">
            <td class="py-3 font-mono text-xs text-slate-500">{m.referenceCode}</td>
            <td class="py-3 font-medium text-slate-800">
              <a href={`/members/${m.id}`} class="hover:underline">
                {m.fullName || `${m.firstName} ${m.lastName ?? ""}`.trim()}
              </a>
            </td>
            <td class="py-3 text-slate-600">{m.email ?? "—"}</td>
            <td class="py-3 text-slate-600">{m.mobile ?? "—"}</td>
            <td class="py-3">
              {#if m.isActive}
                <span class="text-green-700 text-xs">active</span>
              {:else}
                <span class="text-slate-400 text-xs">inactive</span>
              {/if}
            </td>
          </tr>
        {/each}
        {#if !loading && items.length === 0}
          <tr>
            <td colspan="5" class="py-8 text-center text-sm text-slate-500">
              No members yet. Add one above or import in bulk (coming in Phase 6).
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  {/if}
</div>
