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
      onparseerror?.(
        "Could not update batch totals — check the value is a plain number.",
      );
    }
  }
</script>

<div class="rounded-lg border border-slate-200 p-4 bg-slate-50">
  <p class="text-xs uppercase text-slate-500">Cash</p>
  <input
    type="number"
    step="0.01"
    min="0"
    disabled={!editable}
    value={cashTotal ?? ""}
    onchange={(e) => handleChange("cashTotal", (e.currentTarget as HTMLInputElement).value)}
    class="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-sm font-mono disabled:bg-slate-100"
  />
  <p class="text-xs uppercase text-slate-500 mt-3">Cheque</p>
  <input
    type="number"
    step="0.01"
    min="0"
    disabled={!editable}
    value={chequeTotal ?? ""}
    onchange={(e) => handleChange("chequeTotal", (e.currentTarget as HTMLInputElement).value)}
    class="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-sm font-mono disabled:bg-slate-100"
  />
  <p class="mt-2 text-xs text-slate-500">
    Counted: {formatMoney({ amount: counted, currency: currencyCode })}
  </p>
</div>
