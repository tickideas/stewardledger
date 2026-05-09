<script lang="ts">
  // Treasurer's home: batches first (the Sunday close), individual
  // contributions tab for one-off / online / bank-import entries.
  import { goto } from "$app/navigation";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { formatMoney } from "@stewardledger/shared";

  type Batch = {
    id: string;
    chapterId: string;
    serviceEventId: string | null;
    paymentMethodId: string | null;
    sourceType: string;
    referenceCode: string | null;
    cashTotal: string | null;
    chequeTotal: string | null;
    currencyCode: string;
    status: "draft" | "submitted" | "approved" | "posted" | "voided";
    notes: string | null;
    createdAt: string;
  };

  type Contribution = {
    id: string;
    chapterId: string | null;
    memberId: string | null;
    contributionDate: string;
    totalAmount: string;
    currencyCode: string;
    status: "draft" | "posted" | "voided" | "reversed";
    sourceType: string;
    description: string | null;
    createdAt: string;
  };

  type Chapter = { id: string; name: string };

  let tab = $state<"batches" | "contributions">("batches");
  let chapters = $state<Chapter[]>([]);
  let chapterId = $state("");
  let status = $state("");

  let batches = $state<Batch[]>([]);
  let batchTotal = $state<number | null>(null);
  let contributions = $state<Contribution[]>([]);
  let contribTotal = $state<number | null>(null);

  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let chaptersError = $state<string | null>(null);

  // Last-request-wins token: if the user clicks chapter A then B faster
  // than the round-trip, A's response must not overwrite B's table.
  let refreshToken = 0;

  // Reset the status filter when the tab changes — the two tabs share a
  // <select> but their valid status sets diverge (batches have
  // "approved", contributions have "reversed"). Without this, switching
  // tabs while a tab-specific value was selected sends an invalid status
  // to the new endpoint.
  function selectTab(next: "batches" | "contributions") {
    if (tab === next) return;
    tab = next;
    status = "";
  }

  async function loadChapters(signal: AbortSignal) {
    try {
      const res = await api.get<{ items: Chapter[] }>("/api/tenant/chapters", signal);
      chapters = res.items;
      chaptersError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      // Surface the failure so a treasurer with no chapter access (or a
      // network blip) doesn't see an empty filter and wonder why.
      chapters = [];
      chaptersError =
        err instanceof ApiError ? `Could not load chapters: ${err.message}` : "Could not load chapters.";
    }
  }

  async function refresh(signal: AbortSignal) {
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const params = new URLSearchParams();
      if (chapterId) params.set("chapterId", chapterId);
      if (status) params.set("status", status);
      if (tab === "batches") {
        const res = await api.get<{ items: Batch[]; total: number }>(
          `/api/tenant/contribution-batches?${params.toString()}`,
          signal,
        );
        if (my !== refreshToken) return;
        batches = res.items;
        batchTotal = res.total;
      } else {
        const res = await api.get<{ items: Contribution[]; total: number }>(
          `/api/tenant/contributions?${params.toString()}`,
          signal,
        );
        if (my !== refreshToken) return;
        contributions = res.items;
        contribTotal = res.total;
      }
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load.";
    } finally {
      if (my === refreshToken) loading = false;
    }
  }

  $effect(() => {
    const controller = new AbortController();
    loadChapters(controller.signal);
    return () => controller.abort();
  });

  // Re-fetch whenever the tab or filters change.
  $effect(() => {
    void tab;
    void chapterId;
    void status;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  });

  function chapterName(chapterIdValue: string | null): string {
    if (!chapterIdValue) return "—";
    return chapters.find((c) => c.id === chapterIdValue)?.name ?? "—";
  }

  function statusBadge(s: string): string {
    switch (s) {
      case "posted":
        return "bg-green-100 text-green-700";
      case "approved":
        return "bg-blue-100 text-blue-700";
      case "submitted":
        return "bg-amber-100 text-amber-700";
      case "voided":
        return "bg-slate-100 text-slate-500";
      case "reversed":
        return "bg-rose-100 text-rose-700";
      case "draft":
      default:
        return "bg-slate-100 text-slate-700";
    }
  }

  function fmt(amount: string, currency: string): string {
    return formatMoney({ amount, currency });
  }

  async function newBatch() {
    await goto("/contributions/batches/new");
  }
</script>

<div class="max-w-6xl mx-auto px-6 py-8">
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Contributions</h1>
      <p class="mt-1 text-sm text-slate-600">
        Sunday batches, individual gifts, and online imports.
      </p>
    </div>
    <button
      onclick={newBatch}
      class="inline-flex items-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
    >
      New batch
    </button>
  </div>

  <div class="mt-6 border-b border-slate-200">
    <nav class="flex gap-6 text-sm">
      <button
        type="button"
        onclick={() => selectTab("batches")}
        class={tab === "batches"
          ? "border-b-2 border-slate-900 px-1 py-3 font-medium text-slate-900"
          : "border-b-2 border-transparent px-1 py-3 text-slate-500 hover:text-slate-800"}
      >
        Batches{batchTotal !== null ? ` (${batchTotal})` : ""}
      </button>
      <button
        type="button"
        onclick={() => selectTab("contributions")}
        class={tab === "contributions"
          ? "border-b-2 border-slate-900 px-1 py-3 font-medium text-slate-900"
          : "border-b-2 border-transparent px-1 py-3 text-slate-500 hover:text-slate-800"}
      >
        All contributions{contribTotal !== null ? ` (${contribTotal})` : ""}
      </button>
    </nav>
  </div>

  <div class="mt-4 flex gap-3">
    <select
      bind:value={chapterId}
      class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
    >
      <option value="">All chapters</option>
      {#each chapters as ch (ch.id)}
        <option value={ch.id}>{ch.name}</option>
      {/each}
    </select>
    <select bind:value={status} class="rounded-lg border border-slate-300 px-3 py-2 text-sm">
      <option value="">All statuses</option>
      {#if tab === "batches"}
        <option value="draft">Draft</option>
        <option value="submitted">Submitted</option>
        <option value="approved">Approved</option>
        <option value="posted">Posted</option>
        <option value="voided">Voided</option>
      {:else}
        <option value="draft">Draft</option>
        <option value="posted">Posted</option>
        <option value="voided">Voided</option>
        <option value="reversed">Reversed</option>
      {/if}
    </select>
  </div>

  {#if chaptersError}
    <p class="mt-3 text-sm text-amber-700">{chaptersError}</p>
  {/if}

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if tab === "batches"}
    <table class="mt-6 w-full text-sm">
      <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">Reference</th>
          <th class="py-2">Chapter</th>
          <th class="py-2">Source</th>
          <th class="py-2 text-right">Cash</th>
          <th class="py-2 text-right">Cheque</th>
          <th class="py-2">Status</th>
          <th class="py-2">Created</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each batches as b (b.id)}
          <tr class="hover:bg-slate-50">
            <td class="py-3 font-mono text-xs text-slate-600">
              <a href={`/contributions/batches/${b.id}`} class="hover:underline">
                {b.referenceCode ?? b.id.slice(0, 8)}
              </a>
            </td>
            <td class="py-3 text-slate-700">{chapterName(b.chapterId)}</td>
            <td class="py-3 text-slate-600">{b.sourceType}</td>
            <td class="py-3 text-right font-mono text-slate-700">
              {b.cashTotal ? fmt(b.cashTotal, b.currencyCode) : "—"}
            </td>
            <td class="py-3 text-right font-mono text-slate-700">
              {b.chequeTotal ? fmt(b.chequeTotal, b.currencyCode) : "—"}
            </td>
            <td class="py-3">
              <span class={`inline-block px-2 py-0.5 rounded-full text-xs ${statusBadge(b.status)}`}>
                {b.status}
              </span>
            </td>
            <td class="py-3 text-xs text-slate-500">{new Date(b.createdAt).toLocaleDateString()}</td>
          </tr>
        {/each}
        {#if !loading && batches.length === 0}
          <tr>
            <td colspan="7" class="py-8 text-center text-sm text-slate-500">
              No batches yet. Click <strong>New batch</strong> to record a Sunday close.
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  {:else}
    <table class="mt-6 w-full text-sm">
      <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">Date</th>
          <th class="py-2">Chapter</th>
          <th class="py-2">Source</th>
          <th class="py-2 text-right">Total</th>
          <th class="py-2">Status</th>
          <th class="py-2">Description</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each contributions as c (c.id)}
          <tr class="hover:bg-slate-50">
            <td class="py-3 text-slate-700">
              <a href={`/contributions/${c.id}`} class="hover:underline">{c.contributionDate}</a>
            </td>
            <td class="py-3 text-slate-700">{chapterName(c.chapterId)}</td>
            <td class="py-3 text-slate-600">{c.sourceType}</td>
            <td class="py-3 text-right font-mono text-slate-700">
              {fmt(c.totalAmount, c.currencyCode)}
            </td>
            <td class="py-3">
              <span class={`inline-block px-2 py-0.5 rounded-full text-xs ${statusBadge(c.status)}`}>
                {c.status}
              </span>
            </td>
            <td class="py-3 text-slate-500 truncate max-w-md">{c.description ?? "—"}</td>
          </tr>
        {/each}
        {#if !loading && contributions.length === 0}
          <tr>
            <td colspan="6" class="py-8 text-center text-sm text-slate-500">
              No contributions yet.
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  {/if}
</div>
