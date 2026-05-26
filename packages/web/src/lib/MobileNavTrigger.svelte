<!-- packages/web/src/lib/MobileNavTrigger.svelte -->
<!-- Hamburger button used by every mobile dashboard header to open MobileNavDrawer. -->
<!-- Extracted so the SVG, sizing, and aria wiring live in one place across all three shells. -->
<!-- RELEVANT FILES: packages/web/src/lib/MobileNavDrawer.svelte, packages/web/src/routes/zone/+layout.svelte, packages/web/src/routes/church/+layout.svelte, packages/web/src/routes/admin/+layout.svelte -->

<script lang="ts">
  type Props = {
    /** Whether the controlled drawer is currently open (drives `aria-expanded`). */
    open: boolean;
    /** Id of the controlled drawer's nav region (drives `aria-controls`). */
    controls: string;
    onclick: () => void;
  };

  const { open, controls, onclick }: Props = $props();
</script>

<button
  type="button"
  {onclick}
  aria-label="Open navigation"
  aria-expanded={open}
  aria-controls={controls}
  class="-ml-2 inline-flex h-9 w-9 items-center justify-center rounded-[3px] text-[var(--ink)] transition-colors hover:bg-[var(--paper-soft)]"
>
  <svg viewBox="0 0 18 18" class="h-4 w-4" fill="none" aria-hidden="true">
    <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
</button>
