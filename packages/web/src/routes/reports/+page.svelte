<script lang="ts">
  // Phase 7 — reports index. Lists every report the API registers so
  // the SvelteKit picker is server-driven; adding a new report on the
  // API automatically lights up here without a UI change.

  import { api, ApiError, isAbortError } from "$lib/api";

  type Summary = { id: string; title: string; description: string };

  let items = $state<Summary[]>([]);
  let loadError = $state<string | null>(null);

  $effect(() => {
    const controller = new AbortController();
    api
      .get<{ items: Summary[] }>("/api/tenant/reports", controller.signal)
      .then((res) => {
        items = res.items;
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        loadError = err instanceof ApiError ? err.message : "Could not load reports.";
      });
    return () => controller.abort();
  });
</script>

<div class="max-w-5xl mx-auto px-6 py-8">
  <h1 class="text-2xl font-semibold tracking-tight">Reports</h1>
  <p class="mt-1 text-sm text-slate-600">
    Statement, ledger, and member reports. Excel exports for now; PDF lands in a follow-up.
  </p>

  {#if loadError}
    <div class="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
      {loadError}
    </div>
  {/if}

  <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each items as report (report.id)}
      <a
        href={`/reports/${report.id}`}
        class="block rounded-xl border bg-white p-5 shadow-sm hover:border-slate-400"
      >
        <h2 class="text-base font-semibold text-slate-900">{report.title}</h2>
        <p class="mt-2 text-sm text-slate-600">{report.description}</p>
      </a>
    {/each}
  </div>
</div>
