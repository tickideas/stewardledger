<script lang="ts">
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

  let refreshToken = 0;

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

  function statusBadgeClass(s: string): string {
    switch (s) {
      case "posted":    return "sl-badge sl-badge-ok";
      case "approved":  return "sl-badge sl-badge-info";
      case "submitted": return "sl-badge sl-badge-warn";
      case "voided":    return "sl-badge sl-badge-mute";
      case "reversed":  return "sl-badge sl-badge-bad";
      case "draft":
      default:          return "sl-badge sl-badge-mute";
    }
  }

  function fmt(amount: string, currency: string): string {
    return formatMoney({ amount, currency });
  }

  async function newBatch() {
    await goto("/contributions/batches/new");
  }

  // Derived headline: posted totals, grouped by currency.
  const postedByCurrency = $derived.by(() => {
    if (tab !== "contributions") return [] as { currency: string; total: number; count: number }[];
    const acc = new Map<string, { total: number; count: number }>();
    for (const c of contributions) {
      if (c.status !== "posted") continue;
      const cur = acc.get(c.currencyCode) ?? { total: 0, count: 0 };
      cur.total += parseFloat(c.totalAmount);
      cur.count += 1;
      acc.set(c.currencyCode, cur);
    }
    return [...acc.entries()].map(([currency, v]) => ({ currency, ...v }));
  });

  const batchCashTotal = $derived.by(() => {
    const acc = new Map<string, number>();
    for (const b of batches) {
      if (!b.cashTotal) continue;
      acc.set(b.currencyCode, (acc.get(b.currencyCode) ?? 0) + parseFloat(b.cashTotal));
    }
    return [...acc.entries()];
  });
</script>

<div class="mx-auto max-w-7xl px-8 py-10">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ Daily ledger · Treasurer</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Contributions <span class="sl-serif-italic font-light text-[var(--brass-deep)]">journal</span>
      </h1>
      <p class="mt-2 max-w-xl text-[14px] text-[var(--ink-mute)]">
        Sunday batches, individual gifts, and online imports — all reconciled into a single
        traceable ledger.
      </p>
    </div>
    <button onclick={newBatch} class="sl-btn sl-btn-primary">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      New batch
    </button>
  </div>

  <!-- KPI strip -->
  <div class="sl-reveal sl-reveal-2 mt-10 grid grid-cols-2 gap-0 border-y border-[var(--rule)] bg-[var(--card)] md:grid-cols-4">
    <div class="px-6 py-7 border-r border-[var(--rule)]">
      <span class="sl-eyebrow">Batches shown</span>
      <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
        {batchTotal ?? batches.length}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">{batches.filter((b) => b.status === "posted").length} posted · {batches.filter((b) => b.status === "submitted").length} pending</p>
    </div>
    <div class="px-6 py-7 md:border-r md:border-[var(--rule)]">
      <span class="sl-eyebrow">Contributions</span>
      <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
        {contribTotal ?? contributions.length}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">across filters in view</p>
    </div>
    <div class="border-t border-[var(--rule)] px-6 py-7 md:border-r md:border-t-0 md:border-[var(--rule)]">
      <span class="sl-eyebrow">Cash on hand · batches</span>
      <div class="mt-3 sl-display sl-num text-[28px] leading-tight text-[var(--ink)]">
        {#if batchCashTotal.length === 0}
          <span class="text-[var(--ink-faint)]">—</span>
        {:else}
          {#each batchCashTotal as [cur, total], i}
            <span class:block={i > 0}>{fmt(total.toFixed(2), cur)}</span>
          {/each}
        {/if}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">unposted physical cash</p>
    </div>
    <div class="border-t border-[var(--rule)] px-6 py-7 md:border-t-0">
      <span class="sl-eyebrow">Posted · this view</span>
      <div class="mt-3 sl-display sl-num text-[28px] leading-tight text-[var(--brass-deep)]">
        {#if tab === "contributions" && postedByCurrency.length > 0}
          {#each postedByCurrency as p, i}
            <span class:block={i > 0}>{fmt(p.total.toFixed(2), p.currency)}</span>
          {/each}
        {:else}
          <span class="text-[var(--ink-faint)]">—</span>
        {/if}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">tab: {tab}</p>
    </div>
  </div>

  <!-- Tabs -->
  <div class="sl-reveal sl-reveal-3 mt-10 border-b border-[var(--rule)]">
    <nav class="flex gap-8">
      <button
        type="button"
        onclick={() => selectTab("batches")}
        class="relative -mb-px py-3"
        style={tab === "batches" ? "color:var(--ink)" : "color:var(--ink-mute)"}
      >
        <span class="sl-display text-[16px]">Batches</span>
        {#if batchTotal !== null}
          <span class="ml-2 sl-mono text-[11px] text-[var(--ink-mute)]">({batchTotal})</span>
        {/if}
        {#if tab === "batches"}
          <span class="absolute inset-x-0 -bottom-px h-px bg-[var(--brass)]"></span>
        {/if}
      </button>
      <button
        type="button"
        onclick={() => selectTab("contributions")}
        class="relative -mb-px py-3"
        style={tab === "contributions" ? "color:var(--ink)" : "color:var(--ink-mute)"}
      >
        <span class="sl-display text-[16px]">All contributions</span>
        {#if contribTotal !== null}
          <span class="ml-2 sl-mono text-[11px] text-[var(--ink-mute)]">({contribTotal})</span>
        {/if}
        {#if tab === "contributions"}
          <span class="absolute inset-x-0 -bottom-px h-px bg-[var(--brass)]"></span>
        {/if}
      </button>
    </nav>
  </div>

  <!-- Filters -->
  <div class="mt-5 flex flex-wrap items-center gap-3">
    <select bind:value={chapterId} class="sl-select w-56">
      <option value="">All chapters</option>
      {#each chapters as ch (ch.id)}<option value={ch.id}>{ch.name}</option>{/each}
    </select>
    <select bind:value={status} class="sl-select w-48">
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
    <p class="mt-4 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-[13px] text-[var(--ink-soft)]">{chaptersError}</p>
  {/if}

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if tab === "batches"}
    <div class="sl-reveal mt-6 sl-card overflow-hidden">
      <table class="sl-table">
        <thead>
          <tr>
            <th>Reference</th>
            <th>Chapter</th>
            <th>Source</th>
            <th class="!text-right">Cash</th>
            <th class="!text-right">Cheque</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {#each batches as b (b.id)}
            <tr>
              <td>
                <a href={`/contributions/batches/${b.id}`} class="sl-mono text-[12px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                  {b.referenceCode ?? b.id.slice(0, 8)}
                </a>
              </td>
              <td class="text-[var(--ink-soft)]">{chapterName(b.chapterId)}</td>
              <td class="sl-mono text-[11.5px] text-[var(--ink-mute)] uppercase" style="letter-spacing:0.06em">{b.sourceType}</td>
              <td class="text-right sl-mono sl-num text-[var(--ink)]">
                {b.cashTotal ? fmt(b.cashTotal, b.currencyCode) : "—"}
              </td>
              <td class="text-right sl-mono sl-num text-[var(--ink)]">
                {b.chequeTotal ? fmt(b.chequeTotal, b.currencyCode) : "—"}
              </td>
              <td><span class={statusBadgeClass(b.status)}>{b.status}</span></td>
              <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                {new Date(b.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
              </td>
            </tr>
          {/each}
          {#if !loading && batches.length === 0}
            <tr>
              <td colspan="7" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                No batches yet. Click <strong class="text-[var(--ink)]">New batch</strong> to record a Sunday close.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="sl-reveal mt-6 sl-card overflow-hidden">
      <table class="sl-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Chapter</th>
            <th>Source</th>
            <th class="!text-right">Total</th>
            <th>Status</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {#each contributions as c (c.id)}
            <tr>
              <td class="sl-mono text-[12px] text-[var(--ink)]">
                <a href={`/contributions/${c.id}`} class="hover:text-[var(--brass-deep)]">{c.contributionDate}</a>
              </td>
              <td class="text-[var(--ink-soft)]">{chapterName(c.chapterId)}</td>
              <td class="sl-mono text-[11.5px] text-[var(--ink-mute)] uppercase" style="letter-spacing:0.06em">{c.sourceType}</td>
              <td class="text-right sl-mono sl-num text-[var(--ink)]">{fmt(c.totalAmount, c.currencyCode)}</td>
              <td><span class={statusBadgeClass(c.status)}>{c.status}</span></td>
              <td class="max-w-md truncate text-[var(--ink-mute)]">{c.description ?? "—"}</td>
            </tr>
          {/each}
          {#if !loading && contributions.length === 0}
            <tr><td colspan="6" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">No contributions yet.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
