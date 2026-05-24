<!-- packages/web/src/routes/zone/duplicates/+page.svelte -->
<!-- Zone-wide tool for resolving duplicate member records by merging them. -->
<!-- Replaces /zone/merge so the page name matches its purpose for non-technical admins. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/members/+page.svelte, packages/api/src/routes/tenant-members.ts, packages/web/src/lib/nav.ts -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";
  import ConfirmDialog from "$lib/ConfirmDialog.svelte";

  type Proposal = {
    id: string;
    primaryMemberId: string;
    duplicateMemberId: string;
    matchScore: string;
    status: "pending" | "approved" | "rejected" | "applied";
    proposedAt: string;
    appliedAt: string | null;
    notes: string | null;
  };

  let proposals = $state<Proposal[]>([]);
  let loadError = $state<string | null>(null);
  let loading = $state(false);

  let primaryId = $state("");
  let duplicateId = $state("");
  let notes = $state("");
  let formError = $state<string | null>(null);
  let submitting = $state(false);
  let applyingId = $state<string | null>(null);

  // Pending-merge dialog state. We hold the row that triggered the
  // dialog so the confirm-step handler knows which proposal to apply.
  let confirmTarget = $state<Proposal | null>(null);
  const confirmOpen = $derived(confirmTarget !== null);

  async function refresh() {
    loading = true;
    try {
      const res = await api.get<{ items: Proposal[] }>("/api/tenant/members/merge/proposals");
      proposals = res.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load duplicate pairs.";
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    refresh();
  });

  async function propose(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    submitting = true;
    try {
      await api.post("/api/tenant/members/merge/proposals", {
        primaryMemberId: primaryId,
        duplicateMemberId: duplicateId,
        notes: notes || undefined,
      });
      primaryId = "";
      duplicateId = "";
      notes = "";
      await refresh();
    } catch (err) {
      formError = err instanceof ApiError ? err.message : "Could not queue this pair.";
    } finally {
      submitting = false;
    }
  }

  function requestApply(p: Proposal) {
    confirmTarget = p;
  }

  function cancelApply() {
    if (applyingId) return;
    confirmTarget = null;
  }

  async function confirmApply() {
    const p = confirmTarget;
    if (!p) return;
    applyingId = p.id;
    try {
      await api.post("/api/tenant/members/merge/apply", { proposalId: p.id });
      confirmTarget = null;
      await refresh();
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not complete the merge.";
      confirmTarget = null;
    } finally {
      applyingId = null;
    }
  }

  function statusBadge(status: Proposal["status"]) {
    switch (status) {
      case "applied":
        return "sl-badge-ok";
      case "rejected":
        return "sl-badge-bad";
      case "approved":
        return "sl-badge-accent";
      case "pending":
      default:
        return "sl-badge-mute";
    }
  }

  function statusLabel(status: Proposal["status"]) {
    switch (status) {
      case "applied":
        return "merged";
      case "rejected":
        return "dismissed";
      case "approved":
        return "ready";
      case "pending":
      default:
        return "awaiting review";
    }
  }
</script>

<svelte:head><title>Duplicate members · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ II · Identities · Duplicates</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      Duplicate <span class="sl-serif-italic font-light text-[var(--brass-deep)]">members</span>
    </h1>
    <p class="mt-2 max-w-2xl text-[14px] text-[var(--ink-mute)]">
      Found two records for the same person? Queue them here, then merge.
      The record you keep absorbs the duplicate's giving history, addresses
      and references — the duplicate is archived, not deleted, and every
      merge is recorded in the audit log.
    </p>
  </div>

  <!-- Queue form -->
  <form class="sl-reveal sl-reveal-2 sl-card-warm mt-8 grid grid-cols-12 gap-3 p-6" onsubmit={propose}>
    <label class="col-span-12 sm:col-span-5">
      <span class="sl-eyebrow" style="font-size:10.5px">Keep this member</span>
      <input
        type="text"
        required
        bind:value={primaryId}
        placeholder="Member id of the record to keep"
        class="sl-input sl-mono mt-1.5 text-[12.5px]"
      />
      <span class="mt-1.5 block text-[11.5px] text-[var(--ink-mute)]">
        This record stays. All history from the duplicate moves here.
      </span>
    </label>
    <label class="col-span-12 sm:col-span-5">
      <span class="sl-eyebrow" style="font-size:10.5px">Merge in this duplicate</span>
      <input
        type="text"
        required
        bind:value={duplicateId}
        placeholder="Member id of the duplicate"
        class="sl-input sl-mono mt-1.5 text-[12.5px]"
      />
      <span class="mt-1.5 block text-[11.5px] text-[var(--ink-mute)]">
        This record is archived once the merge runs.
      </span>
    </label>
    <div class="col-span-12 flex items-start sm:col-span-2 sm:pt-[26px]">
      <button type="submit" disabled={submitting} class="sl-btn sl-btn-primary w-full justify-center">
        {submitting ? "Adding…" : "Queue pair"}
      </button>
    </div>
    <label class="col-span-12">
      <span class="sl-eyebrow" style="font-size:10.5px">Reason / notes (optional)</span>
      <input
        type="text"
        bind:value={notes}
        placeholder="e.g. Same person, different chapter spellings"
        class="sl-input mt-1.5"
      />
    </label>
    {#if formError}
      <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{formError}</p>
    {/if}
  </form>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  <div class="sl-reveal sl-reveal-3 mt-10">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Queued duplicate pairs</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {proposals.length} {proposals.length === 1 ? "pair" : "pairs"}
      </span>
    </div>
    <div class="sl-card overflow-hidden">
      <table class="sl-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Kept member</th>
            <th>Duplicate</th>
            <th>Notes</th>
            <th class="!text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {#each proposals as p (p.id)}
            <tr>
              <td>
                <span class="sl-badge {statusBadge(p.status)}">{statusLabel(p.status)}</span>
              </td>
              <td>
                <a
                  href={`/zone/members/${p.primaryMemberId}`}
                  class="sl-mono text-[12px] text-[var(--ink)] hover:text-[var(--brass-deep)]"
                  style="letter-spacing:0.04em"
                >
                  {p.primaryMemberId.slice(0, 8)}…
                </a>
              </td>
              <td>
                <a
                  href={`/zone/members/${p.duplicateMemberId}`}
                  class="sl-mono text-[12px] text-[var(--ink-soft)] hover:text-[var(--brass-deep)]"
                  style="letter-spacing:0.04em"
                >
                  {p.duplicateMemberId.slice(0, 8)}…
                </a>
              </td>
              <td class="text-[var(--ink-soft)]">{p.notes ?? "—"}</td>
              <td class="text-right">
                {#if p.status === "pending" || p.status === "approved"}
                  <button
                    type="button"
                    class="sl-btn sl-btn-ghost justify-center"
                    disabled={applyingId === p.id}
                    onclick={() => requestApply(p)}
                  >
                    {applyingId === p.id ? "Merging…" : "Merge now"}
                  </button>
                {:else if p.status === "applied"}
                  <span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
                    {p.appliedAt ? new Date(p.appliedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : ""}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
          {#if !loading && proposals.length === 0}
            <tr>
              <td colspan="5" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                No duplicate pairs queued. Add one above when you find two records for the same person.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>
</div>

<ConfirmDialog
  open={confirmOpen}
  title="Merge these two members?"
  body="The duplicate is archived (not deleted) and its giving history, addresses, and references move to the kept member. Every merge is recorded in the audit log."
  confirmLabel="Merge now"
  cancelLabel="Keep separate"
  tone="danger"
  submitting={applyingId !== null}
  onconfirm={confirmApply}
  oncancel={cancelApply}
/>
