<script lang="ts">
  // Member statement preview (Phase 5).
  //
  // Phase 7 will own the rich PDF/Excel export, but the treasurer needs a
  // way today to eyeball "what has this member given, in what period?"
  // before they post a batch. This page is a thin client-side aggregation
  // over GET /api/tenant/contributions?memberId=…; it deliberately does
  // not hit a new endpoint so it lands inside Phase 5 scope.
  //
  // Voided + reversed rows are hidden by default; the negative-amount
  // reversal lines that DO show up under "include" make the running
  // total tie out (positive original + negative reversal == 0).

  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { formatMoney } from "@stewardledger/shared";
  import Decimal from "decimal.js";
  import { onDestroy } from "svelte";

  type Contribution = {
    id: string;
    chapterId: string | null;
    contributionDate: string;
    totalAmount: string;
    currencyCode: string;
    status: "draft" | "posted" | "voided" | "reversed";
    sourceType: string;
    description: string | null;
    batchId: string | null;
  };

  type Member = {
    id: string;
    referenceCode: string;
    fullName: string | null;
    firstName: string;
    lastName: string | null;
  };

  const memberId = $derived(page.params.id ?? "");

  let member = $state<Member | null>(null);
  let items = $state<Contribution[]>([]);
  let loadError = $state<string | null>(null);

  let dateFrom = $state(`${new Date().getFullYear()}-01-01`);
  let dateTo = $state(new Date().toISOString().slice(0, 10));
  let includeVoidedReversed = $state(false);

  // Last-request-wins token: rapid date changes through the pickers must
  // not let an older response overwrite a newer one. The pickers also
  // fire `change` per arrow click, so we debounce 250ms to avoid a
  // flicker storm during year-by-year nav.
  let loadToken = 0;
  let activeController: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    activeController?.abort();
  });

  async function runLoad() {
    const my = ++loadToken;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    try {
      const params = new URLSearchParams();
      params.set("memberId", memberId);
      params.set("dateFrom", dateFrom);
      params.set("dateTo", dateTo);
      params.set("limit", "200");
      const [m, c] = await Promise.all([
        api.get<{ member: Member }>(
          `/api/tenant/members/${memberId}`,
          controller.signal,
        ),
        api.get<{ items: Contribution[] }>(
          `/api/tenant/contributions?${params.toString()}`,
          controller.signal,
        ),
      ]);
      if (my !== loadToken) return;
      member = m.member;
      items = c.items;
      loadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== loadToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load statement.";
    }
  }

  function load() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runLoad, 250);
  }

  $effect(() => {
    if (memberId) load();
  });

  // Hide voided / reversed unless requested. We always keep posted +
  // (when included) reversed so the running total matches the books.
  const visibleItems = $derived.by(() => {
    return items.filter((i) => {
      if (i.status === "draft") return false;
      if (!includeVoidedReversed && (i.status === "voided" || i.status === "reversed")) {
        return false;
      }
      return true;
    });
  });

  // Group totals by currency — the zone may have multi-currency accounts.
  const totalsByCurrency = $derived.by(() => {
    const map = new Map<string, Decimal>();
    for (const i of visibleItems) {
      const cur = map.get(i.currencyCode) ?? new Decimal(0);
      map.set(i.currencyCode, cur.plus(new Decimal(i.totalAmount)));
    }
    return [...map.entries()].map(([currency, amount]) => ({
      currency,
      amount: amount.toFixed(4),
    }));
  });

  function fmt(amount: string, currency: string): string {
    return formatMoney({ amount, currency });
  }

  function memberDisplayName(m: Member): string {
    return m.fullName ?? `${m.firstName} ${m.lastName ?? ""}`.trim();
  }

  function statusClass(s: string): string {
    switch (s) {
      case "posted":
        return "bg-green-100 text-green-700";
      case "voided":
        return "bg-slate-100 text-slate-500";
      case "reversed":
        return "bg-rose-100 text-rose-700";
      default:
        return "bg-slate-100 text-slate-700";
    }
  }
</script>

<div class="max-w-4xl mx-auto px-6 py-8">
  <a href={`/zone/members/${memberId}`} class="text-sm text-slate-500 hover:underline">← Back to member</a>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if !member}
    <p class="mt-6 text-sm text-slate-500">Loading…</p>
  {:else}
    <div class="mt-2">
      <p class="text-xs font-mono text-slate-500">{member.referenceCode}</p>
      <h1 class="text-2xl font-semibold tracking-tight">Statement — {memberDisplayName(member)}</h1>
      <p class="mt-1 text-sm text-slate-600">
        Preview only. Phase 7 adds the branded PDF and Excel exports.
      </p>
    </div>

    <div class="mt-6 flex flex-wrap items-end gap-3">
      <label class="block text-sm">
        <span class="text-xs text-slate-500">From</span>
        <input
          type="date"
          bind:value={dateFrom}
          onchange={load}
          class="mt-0.5 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label class="block text-sm">
        <span class="text-xs text-slate-500">To</span>
        <input
          type="date"
          bind:value={dateTo}
          onchange={load}
          class="mt-0.5 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label class="text-sm flex items-center gap-2">
        <input type="checkbox" bind:checked={includeVoidedReversed} />
        Show voided / reversed
      </label>
    </div>

    <div class="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
      {#each totalsByCurrency as t (t.currency)}
        <div class="rounded-lg border border-slate-200 p-4 bg-slate-50">
          <p class="text-xs uppercase text-slate-500">Total ({t.currency})</p>
          <p class="mt-1 text-2xl font-mono">{fmt(t.amount, t.currency)}</p>
        </div>
      {/each}
      {#if totalsByCurrency.length === 0}
        <div class="rounded-lg border border-slate-200 p-4 bg-slate-50 sm:col-span-3">
          <p class="text-sm text-slate-500">No contributions in this window.</p>
        </div>
      {/if}
    </div>

    <table class="mt-8 w-full text-sm">
      <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">Date</th>
          <th class="py-2">Source</th>
          <th class="py-2 text-right">Amount</th>
          <th class="py-2">Status</th>
          <th class="py-2">Description</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each visibleItems as i (i.id)}
          <tr class="hover:bg-slate-50">
            <td class="py-2 text-slate-700">
              <a href={`/zone/contributions/${i.id}`} class="hover:underline">{i.contributionDate}</a>
            </td>
            <td class="py-2 text-slate-600">{i.sourceType}</td>
            <td class="py-2 text-right font-mono">{fmt(i.totalAmount, i.currencyCode)}</td>
            <td class="py-2">
              <span class={`inline-block px-2 py-0.5 rounded-full text-xs ${statusClass(i.status)}`}>
                {i.status}
              </span>
            </td>
            <td class="py-2 text-slate-500 truncate max-w-md">{i.description ?? "—"}</td>
          </tr>
        {/each}
        {#if visibleItems.length === 0}
          <tr>
            <td colspan="5" class="py-8 text-center text-sm text-slate-500">
              Nothing in this window.
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  {/if}
</div>
