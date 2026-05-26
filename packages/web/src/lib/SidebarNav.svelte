<!-- packages/web/src/lib/SidebarNav.svelte -->
<!-- Collapsible grouped navigation used by the zonal, church, and platform sidebars. -->
<!-- Each group is a disclosure: the group containing the current route is always expanded; -->
<!-- the rest collapse and remember user state per scope in localStorage. -->
<!-- RELEVANT FILES: packages/web/src/lib/nav.ts, packages/web/src/routes/zone/+layout.svelte, packages/web/src/routes/church/+layout.svelte, packages/web/src/routes/admin/+layout.svelte -->

<script lang="ts">
  import { isNavActive, type NavGroup } from "$lib/nav";

  type Props = {
    /** Nav groups to render. */
    groups: NavGroup[];
    /** Current pathname; used to mark the active link and force its group open. */
    pathname: string;
    /** Per-shell storage key so the zonal/church/admin sidebars don't share state. */
    storageKey: string;
  };

  const { groups, pathname, storageKey }: Props = $props();

  // Group containing the current route. That group is always expanded and the
  // toggle is disabled for it — hiding the link you're standing on is never
  // useful. Everything else honours the user's saved choice.
  const activeKey = $derived(
    groups.find((g) => g.items.some((it) => isNavActive(it, pathname)))?.key ?? null,
  );

  // Collapsed-group set. Persisted as a list of keys under
  // `sl-sidebar-collapsed:<storageKey>`. We treat unknown keys as expanded so
  // newly-added groups appear by default; only explicit user collapses persist.
  const fullKey = $derived(`sl-sidebar-collapsed:${storageKey}`);
  let collapsed = $state<Set<string>>(new Set());

  $effect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(fullKey);
      if (!raw) {
        // First visit: collapse every group except the active one so the
        // sidebar fits without scrolling. The active group is always open
        // regardless of what's in `collapsed`, so we collapse it too — that
        // way when the user navigates away the previously-active group
        // doesn't suddenly stay open without their asking for it.
        collapsed = new Set(groups.map((g) => g.key));
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) collapsed = new Set(parsed.filter((k) => typeof k === "string"));
    } catch {
      collapsed = new Set();
    }
  });

  function persist(next: Set<string>) {
    collapsed = next;
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(fullKey, JSON.stringify([...next]));
    } catch {
      // Storage full / disabled — ignore; state still works in-memory.
    }
  }

  function toggle(key: string) {
    if (key === activeKey) return; // can't collapse the active group
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persist(next);
  }

  function isOpen(key: string): boolean {
    if (key === activeKey) return true;
    return !collapsed.has(key);
  }
</script>

{#each groups as group (group.key)}
  {@const open = isOpen(group.key)}
  {@const isActive = group.key === activeKey}
  <div>
    <button
      type="button"
      onclick={() => toggle(group.key)}
      aria-expanded={open}
      aria-controls={`sl-nav-${storageKey}-${group.key}`}
      disabled={isActive}
      class="sl-side-group-toggle"
    >
      <span class="sl-eyebrow" style="font-size:10px">{group.label}</span>
      <svg
        class="sl-side-group-chevron"
        class:sl-side-group-chevron-open={open}
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
      >
        <path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>
    {#if open}
      <ul id={`sl-nav-${storageKey}-${group.key}`} class="mt-3 flex flex-col gap-0.5">
        {#each group.items as item (item.href)}
          {@const active = isNavActive(item, pathname)}
          <li>
            <a
              href={item.href}
              aria-current={active ? "page" : undefined}
              class="sl-side-link"
              class:sl-side-link-active={active}
            >
              <span
                class="sl-side-link-rail"
                style={active ? "background:var(--brass)" : ""}
                aria-hidden="true"
              ></span>
              <span class="truncate">{item.label}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/each}
