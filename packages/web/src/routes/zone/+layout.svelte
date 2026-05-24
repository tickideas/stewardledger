<!-- packages/web/src/routes/zone/+layout.svelte -->
<!-- Renders the zonal dashboard shell with sidebar, mobile nav, and account menus. -->
<!-- Keeps zone-scoped navigation and zone switching in one reusable route layout. -->
<!-- RELEVANT FILES: packages/web/src/lib/nav.ts, packages/web/src/lib/session.svelte.ts, docs/ARCHITECTURE.md -->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { ZONAL_NAV, isNavActive } from "$lib/nav";
  import {
    ACTIVE_ZONE_KEY,
    authenticatedLandingPath,
    canAccessRole,
    isSuperAdmin,
    landingInputFor,
    session,
    signOut,
  } from "$lib/session.svelte";

  let { children } = $props();

  const path = $derived(page.url.pathname);

  // Role gate. Authenticated users who don't qualify for the zonal surface
  // (e.g. chapter-only admins who hit `/zone/...` from an old bookmark) get
  // redirected to their canonical landing instead of staring at a sidebar
  // they can't make API calls against. We rely on the server for the final
  // word — this is UX, not security.
  $effect(() => {
    const input = landingInputFor(session.current);
    if (!input) return; // loading/anonymous/no_zone/error — root layout handles those
    if (!canAccessRole(input, "zonal")) {
      goto(authenticatedLandingPath(input), { replaceState: true });
    }
  });

  const authed = $derived(session.current.status === "authenticated");
  const zones = $derived(session.current.status === "authenticated" ? session.current.zones : []);
  const activeZone = $derived(
    session.current.status === "authenticated"
      ? session.current.zones.find((z) => z.slug === session.current.activeZoneSlug) ?? null
      : null,
  );
  const showAdminLink = $derived(isSuperAdmin(session.current));

  const sessionUser = $derived(
    session.current.status === "authenticated" ? session.current.user : null,
  );
  const profileLabel = $derived(sessionUser?.name?.trim() || sessionUser?.email || "Account");
  const profileInitial = $derived(
    (sessionUser?.name?.trim()?.[0] || sessionUser?.email?.[0] || "?").toUpperCase(),
  );

  let profileOpen = $state(false);
  let zoneSwitcherOpen = $state(false);
  function toggleProfile() {
    profileOpen = !profileOpen;
    if (profileOpen) zoneSwitcherOpen = false;
  }
  function closeProfile() {
    profileOpen = false;
  }
  function toggleZoneSwitcher() {
    zoneSwitcherOpen = !zoneSwitcherOpen;
    if (zoneSwitcherOpen) profileOpen = false;
  }
  function closeZoneSwitcher() {
    zoneSwitcherOpen = false;
  }

  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      profileOpen = false;
      zoneSwitcherOpen = false;
    }
  }

  async function handleSignOut() {
    closeProfile();
    await signOut();
    await goto("/login");
  }

  // Persist the active zone slug and refresh the page so per-route loaders
  // pick up the new tenant header (`api.ts` reads from localStorage).
  async function switchZone(slug: string) {
    closeZoneSwitcher();
    if (!slug || slug === activeZone?.slug) return;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ACTIVE_ZONE_KEY, slug);
    }
    // Update the `?zone=` param so anything reading from the URL stays in sync.
    const u = new URL(page.url);
    u.searchParams.set("zone", slug);
    await goto(`${u.pathname}${u.search}`, { replaceState: true, invalidateAll: true });
  }
</script>

<svelte:window onkeydown={onKey} />

{#if authed}
  <div class="flex min-h-screen w-full">
    <!-- ============ Sidebar ============ -->
    <aside
      class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--rule)] lg:flex"
      style="background: linear-gradient(180deg, var(--card-warm) 0%, var(--paper) 22%, var(--paper) 100%)"
    >
      <!-- Brand -->
      <a href="/" class="flex items-center gap-3 px-6 pt-6 pb-5">
        <span
          class="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--ink)] bg-[var(--ink)] text-[11px] font-medium text-[var(--paper)] sl-display"
          style="letter-spacing:0"
        >S</span>
        <span class="sl-display text-[17px] font-medium tracking-tight text-[var(--ink)]">
          Steward<span class="sl-serif-italic font-normal text-[var(--brass-deep)]">Ledger</span>
        </span>
      </a>

      <!-- Zone switcher appears only when there is something to switch. -->
      {#if zones.length > 1}
        <div class="mx-4 mb-7 border-t border-[var(--rule)] pt-4">
          <div class="relative">
            <button
              type="button"
              onclick={toggleZoneSwitcher}
              aria-haspopup="listbox"
              aria-expanded={zoneSwitcherOpen}
              class="flex w-full items-start gap-3 rounded-[3px] px-2 py-2 text-left transition-colors hover:bg-[var(--paper-soft)]"
            >
              <span class="sl-eyebrow shrink-0 pt-0.5" style="font-size:9.5px">Zone</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] font-medium text-[var(--ink)]">
                  {activeZone?.name ?? "Select a zone"}
                </span>
                {#if activeZone}
                  <span class="sl-mono block truncate text-[10.5px] text-[var(--ink-mute)]">
                    {activeZone.slug}
                  </span>
                {/if}
              </span>
              <svg class="h-3 w-3 shrink-0 text-[var(--ink-mute)]" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
            </button>
            {#if zoneSwitcherOpen}
              <ul
                role="listbox"
                class="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-[3px] border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]"
              >
                {#each zones as zone (zone.id)}
                  <li>
                    <button
                      type="button"
                      onclick={() => switchZone(zone.slug)}
                      role="option"
                      aria-selected={zone.slug === activeZone?.slug}
                      class="flex w-full items-baseline gap-3 border-b border-[var(--rule)] px-3 py-2 text-left last:border-b-0 transition-colors hover:bg-[var(--paper-soft)]"
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[13px] text-[var(--ink)]">{zone.name}</span>
                        <span class="sl-mono block truncate text-[10.5px] text-[var(--ink-mute)]">{zone.slug}</span>
                      </span>
                      {#if zone.slug === activeZone?.slug}
                        <span class="sl-eyebrow shrink-0" style="font-size:9px;color:var(--brass-deep)">Active</span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
      {/if}

      <nav class="flex flex-1 flex-col gap-7 overflow-y-auto px-6">
        {#each ZONAL_NAV as group (group.label)}
          <div>
            <div class="sl-eyebrow mb-3" style="font-size:10px">{group.label}</div>
            <ul class="flex flex-col gap-0.5">
              {#each group.items as item (item.href)}
                {@const active = isNavActive(item, path)}
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
          </div>
        {/each}

        {#if showAdminLink}
          <div class="mt-2 border-t border-[var(--rule)] pt-5">
            <a
              href="/admin/zones"
              class="sl-side-link"
              style="color:var(--brass-deep)"
            >
              <span class="sl-side-link-rail" aria-hidden="true"></span>
              <span class="truncate">Platform admin →</span>
            </a>
          </div>
        {/if}
      </nav>

      <!-- Profile + sign-out -->
      <div class="relative border-t border-[var(--rule)] px-4 py-3">
        {#if profileOpen}
          <div
            class="absolute right-4 bottom-[calc(100%-4px)] left-4 mb-2 overflow-hidden rounded-[3px] border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]"
            role="menu"
          >
            <div class="border-b border-[var(--rule)] px-3 py-3">
              <div class="sl-eyebrow" style="font-size:9.5px">Signed in</div>
              {#if sessionUser?.name}
                <div class="mt-1 truncate text-[13px] text-[var(--ink)]">{sessionUser.name}</div>
                <div class="truncate text-[11.5px] text-[var(--ink-mute)]">{sessionUser.email}</div>
              {:else}
                <div class="mt-1 truncate text-[13px] text-[var(--ink)]">{sessionUser?.email ?? ""}</div>
              {/if}
            </div>
            <a
              href="/account"
              onclick={closeProfile}
              class="block px-3 py-2.5 text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--paper-soft)]"
              role="menuitem">Profile &amp; password</a
            >
            <button
              type="button"
              onclick={handleSignOut}
              class="block w-full border-t border-[var(--rule)] px-3 py-2.5 text-left text-[13px] text-[var(--ink-mute)] transition-colors hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]"
              role="menuitem"
            >
              Sign out
            </button>
          </div>
        {/if}

        <button
          type="button"
          onclick={toggleProfile}
          aria-haspopup="menu"
          aria-expanded={profileOpen}
          class="sl-profile-trigger flex w-full items-center gap-3 rounded-[3px] px-2 py-2 text-left transition-colors hover:bg-[var(--paper-soft)]"
        >
          <span
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--rule-strong)] text-[12px] font-medium text-[var(--ink)] sl-display"
            style="background:var(--card-warm)"
            aria-hidden="true">{profileInitial}</span
          >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12.5px] text-[var(--ink)]">{profileLabel}</span>
            <span class="block text-[10.5px] text-[var(--ink-mute)]">Manage account</span>
          </span>
          <svg
            class="h-3 w-3 shrink-0 text-[var(--ink-mute)]"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </aside>

    <!-- ============ Content column ============ -->
    <div class="min-w-0 flex-1">
      <!-- Mobile header (sidebar collapses below `lg`). -->
      <div
        class="border-b border-[var(--rule)] lg:hidden"
        style="background: linear-gradient(180deg, var(--card-warm) 0%, var(--paper) 100%)"
      >
        <div class="flex items-center justify-between gap-3 px-5 py-3 sm:px-8">
          <a href="/" class="flex items-center gap-2">
            <span
              class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] bg-[var(--ink)] text-[10px] font-medium text-[var(--paper)] sl-display"
              >S</span
            >
            <span class="sl-display text-[15px] font-medium text-[var(--ink)]">
              Steward<span class="sl-serif-italic font-normal text-[var(--brass-deep)]">Ledger</span>
            </span>
          </a>
          <div class="flex items-center gap-3">
            {#if activeZone}
              <span class="max-w-[10rem] truncate text-[12px] text-[var(--ink-mute)]" title={activeZone.slug}>
                {activeZone.name}
              </span>
            {/if}
            <a
              href="/account"
              class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--rule-strong)] text-[11px] font-medium text-[var(--ink)] sl-display"
              style="background:var(--card-warm)"
              aria-label="Account"
              title={profileLabel}>{profileInitial}</a
            >
          </div>
        </div>
        <nav class="flex gap-6 overflow-x-auto border-t border-[var(--rule)] px-5 py-3 sm:px-8">
          {#each ZONAL_NAV as group (group.label)}
            {#each group.items as item (item.href)}
              <a
                href={item.href}
                class="sl-nav-link shrink-0"
                aria-current={isNavActive(item, path) ? "page" : undefined}>{item.label}</a
              >
            {/each}
          {/each}
        </nav>
      </div>

      <div class="px-6 pt-6 pb-12 sm:px-10 lg:pt-10 lg:pr-12 lg:pl-12">
        {@render children?.()}
      </div>
    </div>
  </div>
{:else}
  <!-- Not authed: fall through to whatever the root layout wants to render. -->
  {@render children?.()}
{/if}
