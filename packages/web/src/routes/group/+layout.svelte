<!--
  packages/web/src/routes/group/+layout.svelte
  Group-tier surface shell: sidebar nav + group switcher (when multiple).
  Hosts /group/dashboard, /group/chapters, etc. populated incrementally
  starting in Task 19.
  RELEVANT FILES: ./+layout.server.ts, $lib/session.svelte.ts, ../zone/+layout.svelte
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { authenticatedLandingPath, canAccessRole, landingInputFor, session } from "$lib/session.svelte";
  import type { LayoutData } from "./$types";

  let { data, children }: { data: LayoutData; children: import("svelte").Snippet } = $props();

  $effect(() => {
    const input = landingInputFor(session.current);
    if (!input) return;
    if (!canAccessRole(input, "group")) {
      goto(authenticatedLandingPath(input), { replaceState: true });
    }
  });

  const authed = $derived(session.current.status === "authenticated");
  const path = $derived(page.url.pathname);

  const NAV_ITEMS = [
    { href: "/group/dashboard", label: "Dashboard" },
    { href: "/group/chapters", label: "Chapters" },
    { href: "/group/members", label: "Members" },
    { href: "/group/contributions", label: "Contributions" },
    { href: "/group/reports", label: "Reports" },
    { href: "/group/administrators", label: "Administrators" },
  ] as const;

  function isActive(href: string): boolean {
    return path === href || path.startsWith(`${href}/`);
  }

  async function switchGroup(_groupId: string) {
    // Group switching is a future enhancement — stub for Task 19+.
  }
</script>

{#if authed}
  <div class="flex min-h-screen w-full">
    <aside
      class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--rule)] lg:flex"
      style="background: linear-gradient(180deg, var(--card-warm) 0%, var(--paper) 22%, var(--paper) 100%)"
    >
      <a href="/" class="flex items-center gap-3 px-6 pt-6 pb-5">
        <span
          class="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--ink)] bg-[var(--ink)] text-[11px] font-medium text-[var(--paper)] sl-display"
          >S</span
        >
        <span class="sl-display text-[17px] font-medium tracking-tight text-[var(--ink)]">
          Steward<span class="sl-serif-italic font-normal text-[var(--brass-deep)]">Ledger</span>
        </span>
      </a>

      <div class="mx-4 mb-7 border-t border-[var(--rule)] pt-4">
        <div class="sl-eyebrow mb-1" style="font-size:9.5px">Group</div>
        {#if data.boundGroup}
          <div class="text-[14px] font-medium text-[var(--ink)]">{data.boundGroup.name}</div>
          {#if data.boundGroups.length > 1}
            <div class="mt-2">
              <select
                class="w-full border border-[var(--rule)] bg-[var(--card)] px-2 py-1 text-[12px] text-[var(--ink)]"
                onchange={(e) => switchGroup((e.target as HTMLSelectElement).value)}
              >
                {#each data.boundGroups as g (g.id)}
                  <option value={g.id} selected={g.id === data.boundGroup.id}>{g.name}</option>
                {/each}
              </select>
            </div>
          {/if}
        {:else}
          <div class="text-[12px] text-[var(--ink-mute)]">No group bound to this session.</div>
        {/if}
      </div>

      <nav class="flex flex-1 flex-col gap-1 overflow-y-auto px-6">
        {#each NAV_ITEMS as item (item.href)}
          <a
            href={item.href}
            class="sl-side-link"
            class:sl-side-link-active={isActive(item.href)}
            aria-current={isActive(item.href) ? "page" : undefined}
          >
            <span class="sl-side-link-rail" aria-hidden="true"></span>
            <span class="truncate">{item.label}</span>
          </a>
        {/each}
      </nav>
    </aside>

    <div class="min-w-0 flex-1 px-6 pt-6 pb-12 sm:px-10 lg:pt-10 lg:pr-12 lg:pl-12">
      {@render children?.()}
    </div>
  </div>
{:else}
  {@render children?.()}
{/if}
