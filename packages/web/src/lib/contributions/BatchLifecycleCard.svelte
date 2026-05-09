<script lang="ts" module>
  export type BatchStatus = "draft" | "submitted" | "approved" | "posted" | "voided";
  export type BatchAction = "submit" | "approve" | "post" | "void";
</script>

<script lang="ts">
  // Submit / approve / post / void buttons. Pure presentation: the
  // parent owns the API calls and busy state.
  interface Props {
    status: BatchStatus;
    busy: boolean;
    busyMsg?: string | null;
    actionError?: string | null;
    /** Disabled the Submit button until at least one live row exists. */
    submitDisabled?: boolean;
    onaction: (action: BatchAction) => void;
  }

  let {
    status,
    busy,
    busyMsg = null,
    actionError = null,
    submitDisabled = false,
    onaction,
  }: Props = $props();
</script>

<div class="rounded-lg border border-slate-200 p-4">
  <p class="text-xs uppercase text-slate-500">Lifecycle</p>
  <div class="mt-2 flex flex-wrap gap-2">
    {#if status === "draft"}
      <button
        type="button"
        disabled={busy || submitDisabled}
        onclick={() => onaction("submit")}
        class="inline-flex items-center px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm hover:bg-slate-700 disabled:opacity-50"
      >
        Submit
      </button>
    {/if}
    {#if status === "submitted"}
      <button
        type="button"
        disabled={busy}
        onclick={() => onaction("approve")}
        class="inline-flex items-center px-3 py-1.5 rounded-lg bg-blue-700 text-white text-sm hover:bg-blue-600 disabled:opacity-50"
      >
        Approve
      </button>
    {/if}
    {#if status === "approved"}
      <button
        type="button"
        disabled={busy}
        onclick={() => onaction("post")}
        class="inline-flex items-center px-3 py-1.5 rounded-lg bg-green-700 text-white text-sm hover:bg-green-600 disabled:opacity-50"
      >
        Post
      </button>
    {/if}
    {#if status !== "posted" && status !== "voided"}
      <button
        type="button"
        disabled={busy}
        onclick={() => onaction("void")}
        class="inline-flex items-center px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 text-sm hover:bg-rose-50 disabled:opacity-50"
      >
        Void
      </button>
    {/if}
  </div>
  {#if busyMsg}
    <p class="mt-2 text-xs text-slate-500">{busyMsg}</p>
  {/if}
  {#if actionError}
    <p class="mt-2 text-xs text-red-600">{actionError}</p>
  {/if}
</div>
