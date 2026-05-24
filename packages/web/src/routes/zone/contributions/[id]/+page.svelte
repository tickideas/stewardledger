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

<svelte:head><title>Contribution · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <a href="/zone/contributions" class="sl-btn sl-btn-ghost">← Back to contributions</a>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if !contribution}
    <p class="mt-6 text-[13px] text-[var(--ink-mute)]">Loading…</p>
  {:else}
    <div class="sl-reveal sl-reveal-1 mt-4 flex flex-wrap items-end justify-between gap-6">
      <div>
        <span class="sl-eyebrow">§ Daily ledger · Contribution</span>
        <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">{memberName()}</h1>
        <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
          <span class="sl-mono">{contribution.contributionDate}</span>
          <span class="mx-2">·</span>
          {contribution.sourceType}
          <span class="mx-2">·</span>
          <span class="sl-mono">{contribution.currencyCode}</span>
        </p>
      </div>
      <span class={`sl-badge ${statusBadge(contribution.status)}`}>{contribution.status}</span>
    </div>

    {#if lookupNotice}
      <p class="mt-4 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-[13px] text-[var(--warn)]">{lookupNotice}</p>
    {/if}
    {#if contribution.batchId}
      <p class="mt-4 text-[13px] text-[var(--ink-soft)]">
        Part of batch
        <a href={`/zone/contributions/batches/${contribution.batchId}`} class="sl-mono text-[12px] text-[var(--brass-deep)] hover:underline">
          {contribution.batchId.slice(0, 8)}
        </a>
      </p>
    {/if}
    {#if contribution.reversalOfContributionId}
      <p class="mt-1 text-[13px] text-[var(--bad)]">
        Reversal of
        <a href={`/zone/contributions/${contribution.reversalOfContributionId}`} class="sl-mono text-[12px] hover:underline">
          {contribution.reversalOfContributionId.slice(0, 8)}
        </a>
      </p>
    {/if}
    {#if contribution.voidReason}
      <p class="mt-1 text-[13px] text-[var(--bad)]">Voided: {contribution.voidReason}</p>
    {/if}
    {#if contribution.description}
      <p class="mt-3 sl-serif-italic text-[14px] text-[var(--ink-soft)]">{contribution.description}</p>
    {/if}

    <!-- Audit affordance: every reviewer wants to see "who did what when". -->
    <p class="mt-3 text-[11.5px] text-[var(--ink-mute)]">
      Created {new Date(contribution.createdAt).toLocaleString()}
      {#if contribution.postedAt}
        · posted {new Date(contribution.postedAt).toLocaleString()}
      {/if}
      {#if contribution.voidedAt}
        · voided {new Date(contribution.voidedAt).toLocaleString()}
      {/if}
    </p>

    <div class="sl-reveal sl-reveal-2 sl-card mt-8 p-6">
      <p class="sl-eyebrow" style="font-size:10px">Total</p>
      <p class="sl-num mt-2 sl-display text-[36px] text-[var(--ink)]">{fmt(contribution.totalAmount, contribution.currencyCode)}</p>
    </div>

    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Lines</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {lines.length} {lines.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Giving type</th>
              <th class="!text-right">Amount</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {#each lines as l (l.id)}
              <tr>
                <td>{givingTypeName(l.givingTypeId)}</td>
                <td class="sl-num text-right text-[var(--ink)]">{fmt(l.amount, l.currencyCode)}</td>
                <td class="text-[var(--ink-mute)]">{l.note ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div class="mt-8 flex flex-wrap gap-2">
      {#if contribution.status === "draft"}
        <button type="button" disabled={busy} onclick={postRow} class="sl-btn sl-btn-primary">
          Post
        </button>
        <button type="button" disabled={busy} onclick={deleteDraft} class="sl-btn sl-btn-ghost" style="color:var(--bad)">
          Delete draft
        </button>
      {/if}
      {#if contribution.status === "posted"}
        <button type="button" disabled={busy} onclick={voidRow} class="sl-btn sl-btn-ghost" style="color:var(--bad)">
          Void
        </button>
        <button type="button" disabled={busy} onclick={reverseRow} class="sl-btn sl-btn-ghost" style="color:var(--warn)">
          Reverse
        </button>
      {/if}
      {#if contribution.memberId}
        <a href={`/zone/members/${contribution.memberId}/statement`} class="sl-btn sl-btn-ghost">
          Member statement
        </a>
      {/if}
    </div>

    {#if actionError}
      <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{actionError}</p>
    {/if}
  {/if}
</div>
