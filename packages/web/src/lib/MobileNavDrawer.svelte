<!-- packages/web/src/lib/MobileNavDrawer.svelte -->
<!-- Slide-in mobile navigation drawer used by every dashboard shell. -->
<!-- Replaces the per-shell horizontal nav strip with the same grouped IA the desktop sidebar uses, -->
<!-- so mobile and desktop stay conceptually identical as items grow. -->
<!-- RELEVANT FILES: packages/web/src/lib/SidebarNav.svelte, packages/web/src/routes/zone/+layout.svelte, packages/web/src/routes/church/+layout.svelte, packages/web/src/routes/admin/+layout.svelte -->

<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import { tick, type Snippet } from "svelte";

  type Props = {
    open: boolean;
    onclose: () => void;
    /** Optional eyebrow shown above the drawer title (e.g. "Platform admin"). */
    eyebrow?: string;
    /** Required title used as the dialog's accessible name. */
    title: string;
    /** Drawer body. Compose your scope switcher + <SidebarNav> + footer here. */
    children: Snippet;
  };

  const { open, onclose, eyebrow, title, children }: Props = $props();

  let panelEl = $state<HTMLDivElement | null>(null);

  // Lock body scroll while the drawer is open so the page underneath doesn't
  // scroll behind the overlay. The cleanup runs whether `open` flips or the
  // component unmounts.
  $effect(() => {
    if (!open || typeof document === "undefined") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  });

  // Move focus into the panel on open and restore it on close. Mirrors the
  // pattern in ConfirmDialog so keyboard / screen-reader behaviour matches.
  $effect(() => {
    if (!open || typeof document === "undefined") return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (!open) return;
      panelEl?.focus();
    });
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  });

  // Any in-app navigation should dismiss the drawer — otherwise the user
  // taps a link, the page changes, and the drawer is still sitting on top.
  afterNavigate(() => {
    if (open) onclose();
  });

  function focusable(): HTMLElement[] {
    if (!panelEl) return [];
    return Array.from(
      panelEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.tabIndex >= 0);
  }

  function trapFocus(e: KeyboardEvent) {
    const list = focusable();
    if (list.length === 0) {
      e.preventDefault();
      panelEl?.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panelEl?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") onclose();
    else if (e.key === "Tab") trapFocus(e);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div
    class="fixed inset-0 z-50 lg:hidden"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onclose();
    }}
  >
    <!-- Scrim -->
    <div
      class="absolute inset-0"
      style="background: rgba(21, 22, 26, 0.42); animation: sl-fade-in 140ms ease-out;"
      aria-hidden="true"
    ></div>

    <!-- Panel -->
    <div
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      class="relative flex h-full w-[19rem] max-w-[85vw] flex-col border-r border-[var(--rule)] shadow-[var(--shadow-lift)]"
      style="background: linear-gradient(180deg, var(--card-warm) 0%, var(--paper) 22%, var(--paper) 100%); animation: sl-slide-in-left 180ms ease-out;"
    >
      <div class="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
        <div class="min-w-0">
          {#if eyebrow}
            <div class="sl-eyebrow" style="font-size:10px">{eyebrow}</div>
          {/if}
          <div class="sl-display mt-1 text-[15px] font-medium text-[var(--ink)]">{title}</div>
        </div>
        <button
          type="button"
          onclick={onclose}
          aria-label="Close navigation"
          class="-mt-1 -mr-1 inline-flex h-9 w-9 items-center justify-center rounded-[3px] text-[var(--ink-mute)] transition-colors hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
        >
          <svg viewBox="0 0 16 16" class="h-4 w-4" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-5 pb-6">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

<style>
  @keyframes sl-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes sl-slide-in-left {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }
</style>
