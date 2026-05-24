<!-- packages/web/src/lib/ConfirmDialog.svelte -->
<!-- Generic destructive-action confirm dialog matching the editorial design system. -->
<!-- Replaces window.confirm() on surfaces that already use sl-card/sl-btn/sl-eyebrow. -->
<!-- RELEVANT FILES: packages/web/src/routes/admin/administrators/+page.svelte, packages/web/src/routes/admin/zones/+page.svelte -->

<script lang="ts">
  import { tick } from "svelte";

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

  let dialogEl = $state<HTMLDivElement | null>(null);
  let cancelButtonEl = $state<HTMLButtonElement | null>(null);

  function cancel() {
    if (submitting) return;
    open = false;
    oncancel?.();
  }

  function confirm() {
    if (submitting) return;
    onconfirm?.();
  }

  function focusableElements(): HTMLElement[] {
    if (!dialogEl) return [];
    return Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0);
  }

  function trapFocus(e: KeyboardEvent) {
    const focusable = focusableElements();
    if (focusable.length === 0) {
      e.preventDefault();
      dialogEl?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && (active === first || !dialogEl?.contains(active))) {
      e.preventDefault();
      last.focus();
      return;
    }
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") cancel();
    if (e.key === "Tab") trapFocus(e);
  }

  $effect(() => {
    if (!open || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    void tick().then(() => {
      if (!open) return;
      // Focus the safe choice first, mirroring native confirm()'s modal
      // behaviour while avoiding accidental destructive Enter presses.
      cancelButtonEl?.focus();
    });

    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  });

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
      ? "sl-btn sl-btn-danger"
      : tone === "warn"
        ? "sl-btn sl-btn-warn"
        : "sl-btn sl-btn-primary",
  );
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
    style="background: rgba(21, 22, 26, 0.42);"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) cancel();
    }}
  >
    <div
      bind:this={dialogEl}
      class="w-full max-w-md rounded-[4px] border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      tabindex="-1"
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
          bind:this={cancelButtonEl}
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
