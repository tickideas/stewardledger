<script lang="ts">
  import { api, ApiError } from "$lib/api";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
  };

  const adminRoles = new Set(["zone_owner", "zone_admin"]);

  let chapters = $state<Chapter[]>([]);
  let auth = $state<AuthorizedContext | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let createOpen = $state(false);
  let name = $state("");
  let countryCode = $state("");
  let dateFrom = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  const canCreate = $derived(
    auth?.isPlatformAdmin === true || auth?.roleCodes.some((role) => adminRoles.has(role)) === true,
  );

  async function refresh() {
    loading = true;
    try {
      const [chapterRes, meRes] = await Promise.all([
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me"),
      ]);
      chapters = chapterRes.items;
      auth = meRes.auth;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load chapters.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    createError = null;
    creating = true;
    try {
      await api.post("/api/tenant/chapters", {
        name,
        countryCode: countryCode.trim() ? countryCode.trim().toUpperCase() : undefined,
        dateFrom: dateFrom || undefined,
      });
      name = "";
      countryCode = "";
      dateFrom = "";
      createOpen = false;
      await refresh();
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not add chapter.";
    } finally {
      creating = false;
    }
  }
</script>

<div class="py-8">
  <div class="flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Chapters</h1>
      <p class="mt-1 text-sm text-slate-600">
        {#if loading}
          Loading…
        {:else}
          {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"}
        {/if}
      </p>
    </div>
    {#if canCreate}
      <button
        type="button"
        class="inline-flex items-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
        onclick={() => (createOpen = !createOpen)}
      >
        {createOpen ? "Cancel" : "New chapter"}
      </button>
    {/if}
  </div>

  {#if createOpen}
    <form class="mt-6 grid grid-cols-12 gap-3 p-4 border rounded-lg bg-slate-50" onsubmit={create}>
      <input
        type="text"
        required
        minlength="2"
        maxlength="120"
        bind:value={name}
        placeholder="Chapter name"
        class="col-span-12 sm:col-span-5 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        type="text"
        maxlength="2"
        bind:value={countryCode}
        placeholder="Country"
        class="col-span-6 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
      />
      <input
        type="date"
        bind:value={dateFrom}
        class="col-span-6 sm:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={creating}
        class="col-span-12 sm:col-span-2 inline-flex items-center justify-center px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {creating ? "Adding…" : "Add"}
      </button>
      {#if createError}
        <p class="col-span-12 text-sm text-red-600">{createError}</p>
      {/if}
    </form>
  {:else if !loading && !canCreate}
    <p class="mt-4 text-sm text-slate-500">
      Chapter creation is available to zone owners and zone admins.
    </p>
  {/if}

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if loading}
    <p class="mt-6 text-sm text-slate-500">Loading chapters…</p>
  {:else if chapters.length === 0}
    <p class="mt-6 text-sm text-slate-500">No chapters yet.</p>
  {:else}
    <div class="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b bg-slate-50">
          <tr>
            <th class="py-3 px-4">Reference</th>
            <th class="py-3 px-4">Name</th>
            <th class="py-3 px-4">Country</th>
            <th class="py-3 px-4">Active since</th>
            <th class="py-3 px-4">Created</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          {#each chapters as chapter (chapter.id)}
            <tr class="hover:bg-slate-50">
              <td class="py-3 px-4 font-mono text-xs text-slate-500">
                {chapter.referenceCode}
              </td>
              <td class="py-3 px-4 font-medium text-slate-800">{chapter.name}</td>
              <td class="py-3 px-4 text-slate-600">{chapter.countryCode ?? "—"}</td>
              <td class="py-3 px-4 text-slate-600">
                {new Date(chapter.dateFrom).toLocaleDateString()}
              </td>
              <td class="py-3 px-4 text-slate-500">
                {new Date(chapter.createdAt).toLocaleDateString()}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
