<script lang="ts">
  // Cash + cheque totals editor. The treasurer types these as they
  // count the offering envelopes; we PATCH the batch on each `change`
  // and let the parent reload to display the canonical value.
  //
  // Decimal parse runs inside try/catch — `<input type="number">`
  // covers most malformed input, but a stale "1,250.00" paste has
  // been known to slip through and an unhandled throw blanks the page.
  import { formatMoney } from "@stewardledger/shared";
  import Decimal from "decimal.js";

  interface Props {
    cashTotal: string | null;
    chequeTotal: string | null;
    currencyCode: string;
    /** Treasurer can only edit while the batch is in `draft`. */
    editable: boolean;
    /** Called with `null` to clear, or a 4-dp decimal string to set. */
    onpatch: (
      field: "cashTotal" | "chequeTotal",
      value: string | null,
    ) => Promise<void>;
    /** Surfaces parse errors to the parent's action-error slot. */
    onparseerror?: (msg: string) => void;
  }

  let { cashTotal, chequeTotal, currencyCode, editable, onpatch, onparseerror }: Props = $props();

  const counted = $derived.by(() => {
    const cash = new Decimal(cashTotal ?? 0);
    const cheque = new Decimal(chequeTotal ?? 0);
    return cash.plus(cheque).toFixed(4);
  });

  async function handleChange(field: "cashTotal" | "chequeTotal", raw: string) {
    if (!editable) return;
    try {
      const value = raw.trim() === "" ? null : new Decimal(raw).toFixed(4);
      await onpatch(field, value);
    } catch {
      onparseerror?.("Could not update counted totals — check the value is a plain number.");
    }
  }
</script>

<div class="sl-card p-5">
  <p class="sl-eyebrow" style="font-size:10px">Cash</p>
  <input
    type="number"
    step="0.01"
    min="0"
    disabled={!editable}
    value={cashTotal ?? ""}
    onchange={(e) => handleChange("cashTotal", (e.currentTarget as HTMLInputElement).value)}
    class="sl-input sl-num mt-1.5 text-right"
  />
  <p class="sl-eyebrow mt-3" style="font-size:10px">Cheque</p>
  <input
    type="number"
    step="0.01"
    min="0"
    disabled={!editable}
    value={chequeTotal ?? ""}
    onchange={(e) => handleChange("chequeTotal", (e.currentTarget as HTMLInputElement).value)}
    class="sl-input sl-num mt-1.5 text-right"
  />
  <p class="mt-3 text-[11.5px] text-[var(--ink-mute)]">
    Counted: <span class="sl-num text-[var(--ink-soft)]">{formatMoney({ amount: counted, currency: currencyCode })}</span>
  </p>
</div>
