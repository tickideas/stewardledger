<script lang="ts">
  // Batch detail orchestrator. Composition over a long file:
  //   • <MemberTypeahead>      — search input + dropdown + debounced ?q=
  //   • <BatchTotalsCard>      — cash + cheque editor with safe Decimal parse
  //   • <BatchLifecycleCard>   — submit / approve / post / void
  //   • <BatchRowsTable>       — read-only rows + per-row delete affordance
  //
  // The parent owns:
  //   • the data load (with AbortController cleanup on unmount)
  //   • the recent-member cache (used by both typeahead and row-display)
  //   • the add-row form state and mutation
  //   • the resolveMemberSelection call, which is unit-tested in
  //     `src/lib/contributions/member-selection.test.ts`.
  //
  // The Sunday-close hot path (≤ 5 min for a 30-member service) lives
  // here. Each row is one keyboard cycle: type member → Tab → amount →
  // Enter to add. Date and source persist between rows.
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import {
    formatMoney,
    type Money,
    SOURCE_TYPES,
    sourceTypeSchema,
  } from "@stewardledger/shared";
  import Decimal from "decimal.js";
  import {
    resolveMemberSelection,
    type ResolutionMember,
  } from "$lib/contributions/member-selection";
  import MemberTypeahead, {
    type TypeaheadMember,
    memberLabel,
  } from "$lib/contributions/MemberTypeahead.svelte";
  import BatchTotalsCard from "$lib/contributions/BatchTotalsCard.svelte";
  import BatchLifecycleCard, {
    type BatchAction,
  } from "$lib/contributions/BatchLifecycleCard.svelte";
  import BatchRowsTable, {
    type RowsTableContribution,
  } from "$lib/contributions/BatchRowsTable.svelte";

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
    voidReason: string | null;
  };

  type GivingType = {
    id: string;
    name: string;
    isActive: boolean;
  };
  type ServiceEvent = {
    id: string;
    chapterId: string | null;
    serviceTypeId: string;
    serviceDate: string;
  };
  type ServiceType = { id: string; name: string };

  let batch = $state<Batch | null>(null);
  let rows = $state<RowsTableContribution[]>([]);
  // Member cache feeds both row-display and the typeahead's "recent"
  // dropdown. Capped at the API's 200-row max; beyond that, the
  // typeahead's debounced server-side `?q=` lookups carry the load.
  let memberCache = $state<Map<string, TypeaheadMember>>(new Map());
  let memberCacheCapped = $state(false);
  let givingTypes = $state<GivingType[]>([]);
  let serviceEvents = $state<ServiceEvent[]>([]);
  let serviceTypes = $state<ServiceType[]>([]);

  let loadError = $state<string | null>(null);
  let lookupNotice = $state<string | null>(null);
  let busy = $state(false);
  let busyMsg = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  // Add-row form state.
  let memberQuery = $state("");
  let memberId = $state("");
  let typeaheadResults = $state<TypeaheadMember[]>([]);
  let typeaheadResultsForQuery = $state<string | null>(null);
  let contributionDate = $state(new Date().toISOString().slice(0, 10));
  type LineDraft = { givingTypeId: string; amount: string };
  let lines = $state<LineDraft[]>([{ givingTypeId: "", amount: "" }]);
  let rowSourceType = $state<(typeof SOURCE_TYPES)[number]>("envelope");
  let addError = $state<string | null>(null);
  let addingRow = $state(false);

  // Race tokens — last-request-wins for the parallel batch + rows load.
  let loadToken = 0;
  let serviceContextToken = 0;

  const id = $derived(page.params.id ?? "");

  function mergeMembersIntoCache(items: TypeaheadMember[]) {
    if (items.length === 0) return;
    const next = new Map(memberCache);
    for (const m of items) next.set(m.id, m);
    memberCache = next;
  }

  // Whenever the typeahead writes new results, feed them into the cache
  // so subsequent row renders can resolve the display name without a
  // round-trip.
  $effect(() => {
    mergeMembersIntoCache(typeaheadResults);
  });

  async function loadBatch(signal: AbortSignal) {
    const my = ++loadToken;
    try {
      const [b, r] = await Promise.all([
        api.get<{ batch: Batch }>(`/api/tenant/contribution-batches/${id}`, signal),
        api.get<{ items: RowsTableContribution[] }>(
          `/api/tenant/contributions?batchId=${id}&limit=200`,
          signal,
        ),
      ]);
      if (my !== loadToken) return;
      batch = b.batch;
      rows = r.items;
      const parsed = sourceTypeSchema.safeParse(b.batch.sourceType);
      if (parsed.success) rowSourceType = parsed.data;
      loadError = null;
      // Don't carry stale post/void/etc errors past a successful refresh.
      actionError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== loadToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load entry session.";
    }
  }

  async function loadLookups(signal: AbortSignal) {
    try {
      // Cap at the API's documented max (200) so a request never silently
      // 400s. The server now returns `total`, so we know whether to hint
      // that the cache is truncated.
      const [mRes, gtRes] = await Promise.all([
        api.get<{ items: TypeaheadMember[]; total: number }>(
          "/api/tenant/members?limit=200",
          signal,
        ),
        api.get<{ items: GivingType[] }>("/api/tenant/giving/types", signal),
      ]);
      mergeMembersIntoCache(mRes.items);
      memberCacheCapped = mRes.total > mRes.items.length;
      givingTypes = gtRes.items.filter((g) => g.isActive !== false);
      // Pre-fill the first line's giving type so a one-line row is one
      // click away. `||=` keeps the user's previous choice if they
      // already typed one before lookups returned.
      if (givingTypes.length > 0) {
        lines[0].givingTypeId ||= givingTypes[0].id;
      }
      lookupNotice = null;
    } catch (err) {
      if (isAbortError(err)) return;
      lookupNotice =
        err instanceof ApiError
          ? `Could not load lookups: ${err.message}`
          : "Could not load lookups.";
    }
  }

  async function loadServiceContext(current: Batch, signal: AbortSignal) {
    const my = ++serviceContextToken;
    serviceEvents = [];
    serviceTypes = [];
    if (!current.serviceEventId) return;
    try {
      const [eventRes, typeRes] = await Promise.all([
        api.get<{ serviceEvent: ServiceEvent }>(
          `/api/tenant/giving/service-events/${current.serviceEventId}`,
          signal,
        ),
        api.get<{ items: ServiceType[] }>("/api/tenant/giving/service-types", signal),
      ]);
      if (my !== serviceContextToken) return;
      serviceEvents = [eventRes.serviceEvent];
      serviceTypes = typeRes.items;
      contributionDate = eventRes.serviceEvent.serviceDate;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== serviceContextToken) return;
      lookupNotice =
        err instanceof ApiError
          ? `Could not load service context: ${err.message}`
          : "Could not load service context.";
    }
  }

  $effect(() => {
    void id;
    const controller = new AbortController();
    loadBatch(controller.signal);
    loadLookups(controller.signal);
    return () => controller.abort();
  });

  $effect(() => {
    const current = batch;
    if (!current) return;
    const controller = new AbortController();
    loadServiceContext(current, controller.signal);
    return () => controller.abort();
  });

  // ─── Derived totals ────────────────────────────────────────────────

  // "Live" = anything still counted in this batch. Voided + reversed
  // both drop out (a reversal balances itself with a negation row, which
  // we exclude so the displayed sum doesn't double-count). Both KPIs
  // share the same predicate so the "N rows summing to X" line is
  // internally consistent.
  function isLive(r: RowsTableContribution): boolean {
    return r.status !== "voided" && r.status !== "reversed";
  }

  const liveCount = $derived(rows.filter(isLive).length);

  function moneyOf(amount: string, currency: string): Money {
    return { amount, currency };
  }

  const giftsTotal = $derived.by(() => {
    if (!batch) return null;
    const sum = rows
      .filter(isLive)
      .reduce((acc, r) => acc.plus(new Decimal(r.totalAmount)), new Decimal(0));
    return moneyOf(sum.toFixed(4), batch.currencyCode);
  });

  // Slice of the cache shown when the typeahead input is empty.
  const recentMembers = $derived([...memberCache.values()].slice(0, 12));
  const selectedServiceEvent = $derived(
    serviceEvents.find((event) => event.id === batch?.serviceEventId) ?? null,
  );
  const selectedServiceType = $derived(
    serviceTypes.find((type) => type.id === selectedServiceEvent?.serviceTypeId) ?? null,
  );
  const serviceTypeLabel = $derived(selectedServiceType?.name ?? "Service");

  // ─── Mutations ─────────────────────────────────────────────────────

  function selectionInputs(): ResolutionMember[] {
    return typeaheadResults.map((m) => ({ id: m.id, label: memberLabel(m) }));
  }

  async function addRow(e: SubmitEvent) {
    e.preventDefault();
    if (!batch) return;
    if (batch.status !== "draft") {
      addError = "Cannot add contributions once this entry session leaves draft.";
      return;
    }
    if (!batch.serviceEventId) {
      addError = "This entry session needs a service event before contributions can be added.";
      return;
    }
    if (!rowSourceType) {
      addError = "Pick the source for this contribution.";
      return;
    }
    addError = null;

    const resolved = resolveMemberSelection({
      query: memberQuery,
      pickedMemberId: memberId,
      results: selectionInputs(),
      resultsForQuery: typeaheadResultsForQuery,
    });
    if (resolved.kind === "error") {
      addError = resolved.message;
      return;
    }
    const resolvedMemberId = resolved.memberId;
    if (resolved.auto && resolvedMemberId) {
      memberId = resolvedMemberId;
      const sole = typeaheadResults.find((m) => m.id === resolvedMemberId);
      if (sole) memberQuery = memberLabel(sole);
    }

    addingRow = true;
    try {
      const cleanLines = lines
        .filter((l) => l.givingTypeId && l.amount.trim() !== "")
        .map((l) => ({
          givingTypeId: l.givingTypeId,
          amount: new Decimal(l.amount).toFixed(4),
        }));
      if (cleanLines.length === 0) {
        addError = "Add at least one line with a giving type and an amount.";
        addingRow = false;
        return;
      }

      await api.post("/api/tenant/contributions", {
        chapterId: batch.chapterId,
        memberId: resolvedMemberId || undefined,
        batchId: batch.id,
        sourceType: rowSourceType,
        paymentMethodId: batch.paymentMethodId ?? undefined,
        serviceEventId: batch.serviceEventId ?? undefined,
        contributionDate,
        currencyCode: batch.currencyCode,
        lines: cleanLines,
      });

      // Reset for the next row, keep date + source steady so the
      // treasurer is one click away from the next contribution.
      memberId = "";
      memberQuery = "";
      typeaheadResults = [];
      typeaheadResultsForQuery = null;
      lines = [{ givingTypeId: givingTypes[0]?.id ?? "", amount: "" }];
      const controller = new AbortController();
      await loadBatch(controller.signal);
    } catch (err) {
      addError = err instanceof ApiError ? err.message : "Could not add contribution.";
    } finally {
      addingRow = false;
    }
  }

  function addLine() {
    lines = [...lines, { givingTypeId: givingTypes[0]?.id ?? "", amount: "" }];
  }

  function removeLine(i: number) {
    lines = lines.filter((_, idx) => idx !== i);
    if (lines.length === 0) lines = [{ givingTypeId: givingTypes[0]?.id ?? "", amount: "" }];
  }

  // Enter on an amount field submits the row instead of the whole form
  // body — saves the treasurer one Tab + click on every entry.
  function onAmountKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const synthetic = new SubmitEvent("submit");
      addRow(synthetic);
    }
  }

  async function deleteRow(rowId: string) {
    if (!confirm("Delete this draft row?")) return;
    busy = true;
    busyMsg = "Deleting row…";
    try {
      await api.delete(`/api/tenant/contributions/${rowId}`);
      const controller = new AbortController();
      await loadBatch(controller.signal);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not delete row.";
    } finally {
      busy = false;
      busyMsg = null;
    }
  }

  async function onLifecycle(action: BatchAction) {
    if (!batch) return;
    if (action === "void") {
      await voidBatch();
      return;
    }
    busy = true;
    busyMsg = `${action[0].toUpperCase() + action.slice(1)}ting entry session…`;
    actionError = null;
    try {
      await api.post(`/api/tenant/contribution-batches/${batch.id}/${action}`, {});
      const controller = new AbortController();
      await loadBatch(controller.signal);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : `Could not ${action} entry session.`;
    } finally {
      busy = false;
      busyMsg = null;
    }
  }

  async function voidBatch() {
    if (!batch) return;
    const reason = prompt("Reason for voiding this entry session?");
    if (!reason) return;
    busy = true;
    busyMsg = "Voiding entry session…";
    actionError = null;
    try {
      await api.post(`/api/tenant/contribution-batches/${batch.id}/void`, {
        voidReason: reason,
      });
      const controller = new AbortController();
      await loadBatch(controller.signal);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not void entry session.";
    } finally {
      busy = false;
      busyMsg = null;
    }
  }

  async function patchBatchTotal(field: "cashTotal" | "chequeTotal", value: string | null) {
    if (!batch) return;
    actionError = null;
    try {
      await api.patch(`/api/tenant/contribution-batches/${batch.id}`, { [field]: value });
      const controller = new AbortController();
      await loadBatch(controller.signal);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not update counted totals.";
    }
  }

  function fmt(amount: string, currency: string): string {
    return formatMoney({ amount, currency });
  }

  function memberName(mid: string | null): string {
    if (!mid) return "Unattributed";
    const m = memberCache.get(mid);
    if (!m) return mid.slice(0, 8);
    return m.fullName ?? `${m.firstName} ${m.lastName ?? ""}`.trim();
  }
</script>

<svelte:head><title>Contribution entry · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <a href="/zone/contributions" class="sl-btn sl-btn-ghost">← Back to contributions</a>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if !batch}
    <p class="mt-6 text-[13px] text-[var(--ink-mute)]">Loading…</p>
  {:else}
    <div class="sl-reveal sl-reveal-1 mt-4 flex flex-wrap items-end justify-between gap-6">
      <div>
        <span class="sl-eyebrow">§ Daily ledger · Entry session</span>
        <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
          Entry <span class="sl-mono text-[24px] text-[var(--ink-soft)]" style="letter-spacing:0.04em">{batch.referenceCode ?? batch.id.slice(0, 8)}</span>
        </h1>
        <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
          {batch.sourceType}
          <span class="mx-2">·</span>
          <span class="sl-mono">{batch.currencyCode}</span>
          <span class="mx-2">·</span>
          created {new Date(batch.createdAt).toLocaleString()}
        </p>
      </div>
      <span class={`sl-badge ${
        batch.status === "posted"
          ? "sl-badge-ok"
          : batch.status === "voided"
            ? "sl-badge-mute"
            : batch.status === "approved"
              ? "sl-badge-info"
              : batch.status === "submitted"
                ? "sl-badge-warn"
                : "sl-badge-mute"
      }`}>{batch.status}</span>
    </div>

    {#if batch.notes}
      <p class="mt-4 sl-serif-italic text-[14px] text-[var(--ink-soft)]">{batch.notes}</p>
    {/if}
    {#if batch.status === "voided" && batch.voidReason}
      <p class="mt-3 text-[13px] text-[var(--bad)]">Voided: {batch.voidReason}</p>
    {/if}
    {#if lookupNotice}
      <p class="mt-3 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-[13px] text-[var(--warn)]">{lookupNotice}</p>
    {/if}

    <!-- Totals + lifecycle actions -->
    <div class="sl-reveal sl-reveal-2 mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
      <div class="sl-card p-5">
        <p class="sl-eyebrow" style="font-size:10px">Contributions</p>
        <p class="sl-num mt-2 sl-display text-[32px] text-[var(--ink)]">{liveCount}</p>
        {#if giftsTotal}
          <p class="mt-1 sl-num text-[13px] text-[var(--ink-mute)]">{fmt(giftsTotal.amount, giftsTotal.currency)}</p>
        {/if}
      </div>
      <BatchTotalsCard
        cashTotal={batch.cashTotal}
        chequeTotal={batch.chequeTotal}
        currencyCode={batch.currencyCode}
        editable={batch.status === "draft"}
        onpatch={patchBatchTotal}
        onparseerror={(msg) => (actionError = msg)}
      />
      <BatchLifecycleCard
        status={batch.status}
        {busy}
        {busyMsg}
        {actionError}
        submitDisabled={liveCount === 0}
        onaction={onLifecycle}
      />
    </div>

    <!-- Add-row form -->
    {#if batch.status === "draft"}
      <form class="sl-reveal sl-card-warm mt-10 p-6" onsubmit={addRow}>
        <span class="sl-eyebrow">Add a contribution</span>

        <div class="mt-4 grid grid-cols-12 gap-3">
          <div class="col-span-12 md:col-span-4">
            <span class="sl-eyebrow" style="font-size:10.5px">Member</span>
            <div class="mt-1.5">
              <MemberTypeahead
                bind:memberId
                bind:query={memberQuery}
                bind:results={typeaheadResults}
                bind:resultsForQuery={typeaheadResultsForQuery}
                recent={recentMembers}
                showRecentTruncatedHint={memberCacheCapped}
              />
            </div>
          </div>

          <div class="col-span-6 md:col-span-3">
            <span class="sl-eyebrow" style="font-size:10.5px">Service type</span>
            <input
              type="text"
              readonly
              required
              value={serviceTypeLabel}
              class="sl-input mt-1.5"
            />
          </div>

          <div class="col-span-6 md:col-span-2">
            <span class="sl-eyebrow" style="font-size:10.5px">Date</span>
            <input type="date" required bind:value={contributionDate} class="sl-input mt-1.5" />
          </div>

          <div class="col-span-12 md:col-span-3">
            <span class="sl-eyebrow" style="font-size:10.5px">Source</span>
            <select bind:value={rowSourceType} required class="sl-select mt-1.5">
              {#each SOURCE_TYPES as s (s)}
                <option value={s}>{s}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="mt-5 space-y-2">
          {#each lines as line, i (i)}
            <div class="grid grid-cols-12 items-end gap-2">
              <label class="col-span-7">
                <span class="sl-eyebrow" style="font-size:10.5px">Giving type</span>
                <select bind:value={line.givingTypeId} required class="sl-select mt-1.5">
                  <option value="" disabled>Pick a giving type</option>
                  {#each givingTypes as gt (gt.id)}
                    <option value={gt.id}>{gt.name}</option>
                  {/each}
                </select>
              </label>
              <label class="col-span-4">
                <span class="sl-eyebrow" style="font-size:10.5px">Amount</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  bind:value={line.amount}
                  onkeydown={onAmountKeydown}
                  placeholder="Amount"
                  class="sl-input sl-num mt-1.5 text-right"
                />
              </label>
              <button
                type="button"
                onclick={() => removeLine(i)}
                class="col-span-1 text-[13px] text-[var(--ink-faint)] hover:text-[var(--bad)]"
                aria-label="Remove line"
              >
                ✕
              </button>
            </div>
          {/each}
          <button type="button" onclick={addLine} class="text-[12px] text-[var(--brass-deep)] hover:underline">
            + Split across another giving type
          </button>
        </div>

        {#if addError}
          <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{addError}</p>
        {/if}

        <div class="mt-5 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={addingRow} class="sl-btn sl-btn-primary">
            {addingRow ? "Adding…" : "Add contribution"}
          </button>
          <span class="text-[11.5px] text-[var(--ink-mute)]">
            Tip: Tab through the line, press Enter on the amount to add the row.
          </span>
        </div>
      </form>
    {/if}

    <!-- Rows -->
    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Rows</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {rows.length} total
        </span>
      </div>
      <BatchRowsTable
        {rows}
        batchStatus={batch.status}
        {memberName}
        ondelete={deleteRow}
      />
    </div>
  {/if}
</div>
