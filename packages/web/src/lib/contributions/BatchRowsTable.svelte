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

<div class="sl-card overflow-hidden">
  <table class="sl-table">
    <thead>
      <tr>
        <th>Date</th>
        <th>Member</th>
        <th>Source</th>
        <th class="!text-right">Total</th>
        <th>Status</th>
        <th class="!text-right"></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.id)}
        <tr>
          <td>
            <a href={`/zone/contributions/${r.id}`} class="sl-mono text-[12.5px] text-[var(--ink)] hover:text-[var(--brass-deep)]">{r.contributionDate}</a>
          </td>
          <td>{memberName(r.memberId)}</td>
          <td class="text-[var(--ink-soft)]">{r.sourceType}</td>
          <td class="sl-num text-right text-[var(--ink)]">{fmt(r.totalAmount, r.currencyCode)}</td>
          <td>
            <span class={`sl-badge ${statusBadge(r.status)}`}>{r.status}</span>
          </td>
          <td class="text-right">
            {#if r.status === "draft" && batchStatus === "draft"}
              <button type="button" onclick={() => ondelete(r.id)} class="text-[12px] text-[var(--bad)] hover:underline">
                delete
              </button>
            {/if}
          </td>
        </tr>
      {/each}
      {#if rows.length === 0}
        <tr>
          <td colspan="6" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
            No rows yet. Add the first one above.
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
</div>
