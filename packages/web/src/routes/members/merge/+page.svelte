<script lang="ts">
  import { api, ApiError } from "$lib/api";

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

  let primaryId = $state("");
  let duplicateId = $state("");
  let notes = $state("");
  let formError = $state<string | null>(null);
  let submitting = $state(false);

  async function refresh() {
    try {
      const res = await api.get<{ items: Proposal[] }>("/api/tenant/members/merge/proposals");
      proposals = res.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load proposals.";
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
      formError = err instanceof ApiError ? err.message : "Could not propose merge.";
    } finally {
      submitting = false;
    }
  }

  async function apply(p: Proposal) {
    if (!confirm("Apply this merge? The duplicate will be soft-deleted and references reassigned.")) return;
    try {
      await api.post("/api/tenant/members/merge/apply", { proposalId: p.id });
      await refresh();
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not apply merge.";
    }
  }
</script>

<div class="py-8">
  <h1 class="text-2xl font-semibold tracking-tight">Merge proposals</h1>
  <p class="mt-1 text-sm text-slate-600">
    Manually propose a primary/duplicate pair and apply the merge. Auto-detection lands in
    Phase 6 with the bulk import pipeline.
  </p>

  <form class="mt-6 grid grid-cols-12 gap-3 p-4 border rounded-lg bg-slate-50" onsubmit={propose}>
    <input
      type="text"
      required
      bind:value={primaryId}
      placeholder="Primary member id (kept)"
      class="col-span-12 sm:col-span-5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
    />
    <input
      type="text"
      required
      bind:value={duplicateId}
      placeholder="Duplicate member id (absorbed)"
      class="col-span-12 sm:col-span-5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
    />
    <button
      type="submit"
      disabled={submitting}
      class="col-span-12 sm:col-span-2 inline-flex items-center justify-center px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
    >
      Propose
    </button>
    <input
      type="text"
      bind:value={notes}
      placeholder="Notes (optional)"
      class="col-span-12 rounded-lg border border-slate-300 px-3 py-2 text-sm"
    />
    {#if formError}
      <p class="col-span-12 text-sm text-red-600">{formError}</p>
    {/if}
  </form>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else}
    <table class="mt-6 w-full text-sm">
      <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">Status</th>
          <th class="py-2">Primary</th>
          <th class="py-2">Duplicate</th>
          <th class="py-2">Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each proposals as p}
          <tr>
            <td class="py-3 text-xs">{p.status}</td>
            <td class="py-3 font-mono text-xs">
              <a class="hover:underline" href={`/members/${p.primaryMemberId}`}>{p.primaryMemberId.slice(0, 8)}…</a>
            </td>
            <td class="py-3 font-mono text-xs">
              <a class="hover:underline" href={`/members/${p.duplicateMemberId}`}>{p.duplicateMemberId.slice(0, 8)}…</a>
            </td>
            <td class="py-3 text-slate-600">{p.notes ?? "—"}</td>
            <td class="py-3 text-right">
              {#if p.status === "pending" || p.status === "approved"}
                <button class="text-xs text-slate-900 underline" onclick={() => apply(p)}>
                  apply
                </button>
              {/if}
            </td>
          </tr>
        {/each}
        {#if proposals.length === 0}
          <tr>
            <td colspan="5" class="py-8 text-center text-sm text-slate-500">No proposals.</td>
          </tr>
        {/if}
      </tbody>
    </table>
  {/if}
</div>
