<!-- packages/web/src/lib/ConfirmDialog.svelte -->
<!-- Generic destructive-action confirm dialog matching the editorial design system. -->
<!-- Replaces window.confirm() on surfaces that already use sl-card/sl-btn/sl-eyebrow. -->
<!-- RELEVANT FILES: packages/web/src/routes/admin/administrators/+page.svelte, packages/web/src/routes/admin/zones/+page.svelte -->

<script lang="ts">
  type Tone = "danger" | "warn" | "neutral";

  let {
    open = $bindable(false),
    title,
    body = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    tone = "danger",
    submitting = false,
    onconfirm,
    oncancel,
  } = $props<{
    open?: boolean;
    title: string;
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: Tone;
    submitting?: boolean;
    onconfirm?: () => void;
    oncancel?: () => void;
  }>();

  function cancel() {
    if (submitting) return;
    open = false;
    oncancel?.();
  }

  function confirm() {
    if (submitting) return;
    onconfirm?.();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) cancel();
  }

  // CSS classes are computed up front so Tailwind picks them up at build.
  const eyebrowStyle = $derived(
    tone === "danger"
      ? "color:var(--bad)"
      : tone === "warn"
        ? "color:var(--warn)"
        : "color:var(--ink-mute)",
  );
  const eyebrowLabel = $derived(
    tone === "danger"
      ? "Destructive action"
      : tone === "warn"
        ? "Sensitive action"
        : "Confirm",
  );
  const confirmClasses = $derived(
    tone === "danger"
      ? "sl-btn border-[var(--bad)] bg-[var(--bad)] text-white hover:bg-[#742f26] disabled:opacity-45"
      : tone === "warn"
        ? "sl-btn border-[var(--warn)] bg-[var(--warn)] text-white hover:opacity-90 disabled:opacity-45"
        : "sl-btn sl-btn-primary",
  );
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) cancel();
    }}
  >
    <div
      class="w-full max-w-md rounded-[4px] border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div class="border-b border-[var(--rule)] px-6 py-5">
        <div class="sl-eyebrow" style={eyebrowStyle}>{eyebrowLabel}</div>
        <h2
          id="confirm-dialog-title"
          class="mt-2 sl-display text-[22px] leading-tight text-[var(--ink)]"
        >
          {title}
        </h2>
        {#if body}
          <p class="mt-2 text-[13px] leading-6 text-[var(--ink-mute)]">{body}</p>
        {/if}
      </div>
      <div class="flex items-center justify-end gap-3 border-t border-[var(--rule)] px-6 py-4">
        <button
          type="button"
          onclick={cancel}
          disabled={submitting}
          class="sl-btn sl-btn-ghost"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onclick={confirm}
          disabled={submitting}
          class={confirmClasses}
        >
          {submitting ? "Working…" : confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
