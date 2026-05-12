<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { formatMoney } from "@stewardledger/shared";

  type Contribution = {
    id: string;
    chapterId: string | null;
    memberId: string | null;
    batchId: string | null;
    contributionDate: string;
    totalAmount: string;
    currencyCode: string;
    status: "draft" | "posted" | "voided" | "reversed";
    sourceType: string;
    description: string | null;
    voidReason: string | null;
    reversalOfContributionId: string | null;
    postedAt: string | null;
    voidedAt: string | null;
    createdAt: string;
  };
  type Line = {
    id: string;
    givingTypeId: string;
    accountId: string | null;
    amount: string;
    currencyCode: string;
    note: string | null;
  };
  type GivingType = { id: string; name: string };
  type Member = {
    id: string;
    fullName: string | null;
    firstName: string;
    lastName: string | null;
    referenceCode: string;
  };

  const id = $derived(page.params.id ?? "");

  let contribution = $state<Contribution | null>(null);
  let lines = $state<Line[]>([]);
  let givingTypes = $state<GivingType[]>([]);
  let member = $state<Member | null>(null);
  let loadError = $state<string | null>(null);
  let lookupNotice = $state<string | null>(null);
  let busy = $state(false);
  let actionError = $state<string | null>(null);

  // Stale-response token for the main contribution load.
  let loadVersion = 0;

  async function load(signal: AbortSignal) {
    const my = ++loadVersion;
    try {
      const res = await api.get<{
        contribution: Contribution;
        lines: Line[];
      }>(`/api/tenant/contributions/${id}`, signal);
      if (my !== loadVersion) return;
      contribution = res.contribution;
      lines = res.lines;
      loadError = null;
      actionError = null;
      // Fetch the single referenced member inline. One round-trip costs
      // less than the cognitive load of a fan-out token check.
      if (res.contribution.memberId) {
        try {
          const m = await api.get<{ member: Member }>(
            `/api/tenant/members/${res.contribution.memberId}`,
            signal,
          );
          if (my !== loadVersion) return;
          member = m.member;
        } catch (err) {
          if (isAbortError(err)) return;
          // Non-fatal: the page still renders with the raw ID prefix.
          if (my === loadVersion) member = null;
        }
      } else {
        member = null;
      }
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== loadVersion) return;
      loadError = err instanceof ApiError ? err.message : "Could not load.";
    }
  }

  async function loadGivingTypes(signal: AbortSignal) {
    try {
      const res = await api.get<{ items: GivingType[] }>(
        "/api/tenant/giving/types",
        signal,
      );
      givingTypes = res.items;
      lookupNotice = null;
    } catch (err) {
      if (isAbortError(err)) return;
      // Surface the failure: without giving types, line rows show raw IDs.
      lookupNotice =
        err instanceof ApiError
          ? `Could not load giving types: ${err.message}`
          : "Could not load giving types.";
    }
  }

  $effect(() => {
    void id;
    const controller = new AbortController();
    load(controller.signal);
    loadGivingTypes(controller.signal);
    return () => controller.abort();
  });

  function fmt(amount: string, currency: string): string {
    return formatMoney({ amount, currency });
  }

  function memberName(): string {
    if (!contribution?.memberId) return "Unattributed";
    if (!member) return contribution.memberId.slice(0, 8);
    return member.fullName ?? `${member.firstName} ${member.lastName ?? ""}`.trim();
  }

  function givingTypeName(gtId: string): string {
    return givingTypes.find((g) => g.id === gtId)?.name ?? gtId.slice(0, 8);
  }

  async function postRow() {
    if (!contribution) return;
    busy = true;
    actionError = null;
    try {
      await api.post(`/api/tenant/contributions/${contribution.id}/post`, {});
      await load(new AbortController().signal);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not post.";
    } finally {
      busy = false;
    }
  }

  async function voidRow() {
    if (!contribution) return;
    const reason = prompt("Reason for voiding this contribution?");
    if (!reason) return;
    busy = true;
    actionError = null;
    try {
      await api.post(`/api/tenant/contributions/${contribution.id}/void`, {
        voidReason: reason,
      });
      await load(new AbortController().signal);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not void.";
    } finally {
      busy = false;
    }
  }

  async function reverseRow() {
    if (!contribution) return;
    const reason = prompt("Reason for reversing this contribution?");
    if (!reason) return;
    busy = true;
    actionError = null;
    try {
      const res = await api.post<{ contribution: { id: string } }>(
        `/api/tenant/contributions/${contribution.id}/reverse`,
        { reason },
      );
      await goto(`/zone/contributions/${res.contribution.id}`);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not reverse.";
    } finally {
      busy = false;
    }
  }

  async function deleteDraft() {
    if (!contribution) return;
    if (!confirm("Delete this draft? This cannot be undone.")) return;
    busy = true;
    actionError = null;
    try {
      await api.delete(`/api/tenant/contributions/${contribution.id}`);
      if (contribution.batchId) {
        await goto(`/zone/contributions/batches/${contribution.batchId}`);
      } else {
        await goto("/zone/contributions");
      }
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not delete.";
      busy = false;
    }
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

<div class="max-w-3xl mx-auto px-6 py-8">
  <a href="/zone/contributions" class="text-sm text-slate-500 hover:underline">← Back to contributions</a>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if !contribution}
    <p class="mt-6 text-sm text-slate-500">Loading…</p>
  {:else}
    <div class="mt-2 flex items-baseline justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{memberName()}</h1>
        <p class="mt-1 text-sm text-slate-600">
          {contribution.contributionDate} · {contribution.sourceType} · {contribution.currencyCode}
        </p>
      </div>
      <span class={`inline-block px-3 py-1 rounded-full text-xs font-medium ${statusClass(contribution.status)}`}>
        {contribution.status}
      </span>
    </div>

    {#if lookupNotice}
      <p class="mt-3 text-sm text-amber-700">{lookupNotice}</p>
    {/if}
    {#if contribution.batchId}
      <p class="mt-3 text-sm">
        Part of batch
        <a
          href={`/zone/contributions/batches/${contribution.batchId}`}
          class="font-mono text-xs text-slate-700 hover:underline"
        >
          {contribution.batchId.slice(0, 8)}
        </a>
      </p>
    {/if}
    {#if contribution.reversalOfContributionId}
      <p class="mt-1 text-sm text-rose-700">
        Reversal of
        <a
          href={`/zone/contributions/${contribution.reversalOfContributionId}`}
          class="hover:underline"
        >
          {contribution.reversalOfContributionId.slice(0, 8)}
        </a>
      </p>
    {/if}
    {#if contribution.voidReason}
      <p class="mt-1 text-sm text-rose-700">Voided: {contribution.voidReason}</p>
    {/if}
    {#if contribution.description}
      <p class="mt-3 text-sm italic text-slate-600">{contribution.description}</p>
    {/if}

    <!-- Audit affordance: every reviewer wants to see "who did what when". -->
    <p class="mt-3 text-xs text-slate-500">
      Created {new Date(contribution.createdAt).toLocaleString()}
      {#if contribution.postedAt}
        · posted {new Date(contribution.postedAt).toLocaleString()}
      {/if}
      {#if contribution.voidedAt}
        · voided {new Date(contribution.voidedAt).toLocaleString()}
      {/if}
    </p>

    <div class="mt-6 rounded-lg border border-slate-200 p-4 bg-slate-50">
      <p class="text-xs uppercase text-slate-500">Total</p>
      <p class="mt-1 text-3xl font-mono">{fmt(contribution.totalAmount, contribution.currencyCode)}</p>
    </div>

    <h2 class="mt-8 text-lg font-medium">Lines</h2>
    <table class="mt-3 w-full text-sm">
      <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">Giving type</th>
          <th class="py-2 text-right">Amount</th>
          <th class="py-2">Note</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each lines as l (l.id)}
          <tr>
            <td class="py-2 text-slate-700">{givingTypeName(l.givingTypeId)}</td>
            <td class="py-2 text-right font-mono">{fmt(l.amount, l.currencyCode)}</td>
            <td class="py-2 text-slate-500">{l.note ?? "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="mt-8 flex flex-wrap gap-2">
      {#if contribution.status === "draft"}
        <button
          type="button"
          disabled={busy}
          onclick={postRow}
          class="inline-flex items-center px-3 py-1.5 rounded-lg bg-green-700 text-white text-sm hover:bg-green-600 disabled:opacity-50"
        >
          Post
        </button>
        <button
          type="button"
          disabled={busy}
          onclick={deleteDraft}
          class="inline-flex items-center px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 text-sm hover:bg-rose-50 disabled:opacity-50"
        >
          Delete draft
        </button>
      {/if}
      {#if contribution.status === "posted"}
        <button
          type="button"
          disabled={busy}
          onclick={voidRow}
          class="inline-flex items-center px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 text-sm hover:bg-rose-50 disabled:opacity-50"
        >
          Void
        </button>
        <button
          type="button"
          disabled={busy}
          onclick={reverseRow}
          class="inline-flex items-center px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 text-sm hover:bg-amber-50 disabled:opacity-50"
        >
          Reverse
        </button>
      {/if}
      {#if contribution.memberId}
        <a
          href={`/zone/members/${contribution.memberId}/statement`}
          class="inline-flex items-center px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-sm hover:bg-slate-100"
        >
          Member statement
        </a>
      {/if}
    </div>

    {#if actionError}
      <p class="mt-3 text-sm text-red-600">{actionError}</p>
    {/if}
  {/if}
</div>
