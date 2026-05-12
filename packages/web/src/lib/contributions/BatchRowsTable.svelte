<script lang="ts" module>
  export type RowsTableContribution = {
    id: string;
    memberId: string | null;
    contributionDate: string;
    totalAmount: string;
    currencyCode: string;
    status: "draft" | "posted" | "voided" | "reversed";
    sourceType: string;
  };

  export type BatchStatus = "draft" | "submitted" | "approved" | "posted" | "voided";
</script>

<script lang="ts">
  import { formatMoney } from "@stewardledger/shared";

  interface Props {
    rows: RowsTableContribution[];
    batchStatus: BatchStatus;
    /** Resolves a member id to display text. Parent owns the cache. */
    memberName: (mid: string | null) => string;
    /** Called when the treasurer clicks the per-row delete affordance. */
    ondelete: (rowId: string) => void;
  }

  let { rows, batchStatus, memberName, ondelete }: Props = $props();

  function fmt(amount: string, currency: string): string {
    return formatMoney({ amount, currency });
  }

  function statusBadge(s: string): string {
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

<table class="w-full text-sm">
  <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
    <tr>
      <th class="py-2">Date</th>
      <th class="py-2">Member</th>
      <th class="py-2">Source</th>
      <th class="py-2 text-right">Total</th>
      <th class="py-2">Status</th>
      <th class="py-2"></th>
    </tr>
  </thead>
  <tbody class="divide-y divide-slate-200">
    {#each rows as r (r.id)}
      <tr class="hover:bg-slate-50">
        <td class="py-2 text-slate-700">
          <a href={`/zone/contributions/${r.id}`} class="hover:underline">{r.contributionDate}</a>
        </td>
        <td class="py-2">{memberName(r.memberId)}</td>
        <td class="py-2 text-slate-600">{r.sourceType}</td>
        <td class="py-2 text-right font-mono">{fmt(r.totalAmount, r.currencyCode)}</td>
        <td class="py-2">
          <span class={`inline-block px-2 py-0.5 rounded-full text-xs ${statusBadge(r.status)}`}>
            {r.status}
          </span>
        </td>
        <td class="py-2 text-right">
          {#if r.status === "draft" && batchStatus === "draft"}
            <button
              type="button"
              onclick={() => ondelete(r.id)}
              class="text-xs text-rose-600 hover:underline"
            >
              delete
            </button>
          {/if}
        </td>
      </tr>
    {/each}
    {#if rows.length === 0}
      <tr>
        <td colspan="6" class="py-8 text-center text-sm text-slate-500">
          No rows yet. Add the first one above.
        </td>
      </tr>
    {/if}
  </tbody>
</table>
