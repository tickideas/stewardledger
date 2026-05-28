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

<div class="sl-card p-5">
  <p class="sl-eyebrow" style="font-size:10px">Review and post</p>
  <div class="mt-3 flex flex-wrap gap-2">
    {#if status === "draft"}
      <button type="button" disabled={busy || submitDisabled} onclick={() => onaction("submit")} class="sl-btn sl-btn-primary">
        Submit
      </button>
    {/if}
    {#if status === "submitted"}
      <button type="button" disabled={busy} onclick={() => onaction("approve")} class="sl-btn sl-btn-primary">
        Approve
      </button>
    {/if}
    {#if status === "approved"}
      <button type="button" disabled={busy} onclick={() => onaction("post")} class="sl-btn sl-btn-accent">
        Post
      </button>
    {/if}
    {#if status !== "posted" && status !== "voided"}
      <button type="button" disabled={busy} onclick={() => onaction("void")} class="sl-btn sl-btn-danger-ghost">
        Void
      </button>
    {/if}
  </div>
  {#if busyMsg}
    <p class="mt-3 text-[11.5px] text-[var(--ink-mute)]">{busyMsg}</p>
  {/if}
  {#if actionError}
    <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-2 py-1 text-[12px] text-[var(--bad)]">{actionError}</p>
  {/if}
</div>
