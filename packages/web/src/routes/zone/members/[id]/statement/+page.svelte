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

  function statusBadge(s: string): string {
    switch (s) {
      case "posted":
        return "sl-badge-ok";
      case "voided":
        return "sl-badge-mute";
      case "reversed":
        return "sl-badge-bad";
      default:
        return "sl-badge-mute";
    }
  }
</script>

<svelte:head><title>Member statement · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <a href={`/zone/members/${memberId}`} class="sl-btn sl-btn-ghost">← Back to member</a>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if !member}
    <p class="mt-6 text-[13px] text-[var(--ink-mute)]">Loading…</p>
  {:else}
    <div class="sl-reveal sl-reveal-1 mt-4">
      <span class="sl-eyebrow">§ Output · Member statement</span>
      <p class="mt-3 sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.08em">{member.referenceCode}</p>
      <h1 class="mt-1 sl-display text-[40px] leading-[1] text-[var(--ink)]">
        Statement <span class="sl-serif-italic font-light text-[var(--brass-deep)]">{memberDisplayName(member)}</span>
      </h1>
      <p class="mt-2 max-w-2xl text-[14px] text-[var(--ink-mute)]">
        Preview only. Phase 7 adds the branded PDF and Excel exports.
      </p>
    </div>

    <div class="sl-reveal sl-reveal-2 sl-card-warm mt-8 flex flex-wrap items-end gap-4 p-6">
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">From</span>
        <input type="date" bind:value={dateFrom} onchange={load} class="sl-input mt-1.5" />
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">To</span>
        <input type="date" bind:value={dateTo} onchange={load} class="sl-input mt-1.5" />
      </label>
      <label class="inline-flex items-center gap-2 pb-2 text-[12.5px] text-[var(--ink-soft)]">
        <input type="checkbox" bind:checked={includeVoidedReversed} />
        Show voided / reversed
      </label>
    </div>

    <div class="sl-reveal sl-reveal-3 mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
      {#each totalsByCurrency as t (t.currency)}
        <div class="sl-card p-5">
          <p class="sl-eyebrow" style="font-size:10px">Total ({t.currency})</p>
          <p class="sl-num mt-2 sl-display text-[28px] text-[var(--ink)]">{fmt(t.amount, t.currency)}</p>
        </div>
      {/each}
      {#if totalsByCurrency.length === 0}
        <div class="sl-card p-5 sm:col-span-3">
          <p class="text-[13px] text-[var(--ink-mute)]">No contributions in this window.</p>
        </div>
      {/if}
    </div>

    <div class="sl-reveal sl-reveal-4 mt-8">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Ledger</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {visibleItems.length} {visibleItems.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Source</th>
              <th class="!text-right">Amount</th>
              <th>Status</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {#each visibleItems as i (i.id)}
              <tr>
                <td>
                  <a href={`/zone/contributions/${i.id}`} class="sl-mono text-[12.5px] text-[var(--ink)] hover:text-[var(--brass-deep)]">{i.contributionDate}</a>
                </td>
                <td class="text-[var(--ink-soft)]">{i.sourceType}</td>
                <td class="sl-num text-right text-[var(--ink)]">{fmt(i.totalAmount, i.currencyCode)}</td>
                <td>
                  <span class={`sl-badge ${statusBadge(i.status)}`}>{i.status}</span>
                </td>
                <td class="max-w-md truncate text-[var(--ink-mute)]">{i.description ?? "—"}</td>
              </tr>
            {/each}
            {#if visibleItems.length === 0}
              <tr>
                <td colspan="5" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                  Nothing in this window.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
