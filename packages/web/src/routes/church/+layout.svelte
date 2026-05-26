<!-- packages/web/src/routes/church/+layout.svelte -->
<!-- Chapter-scoped shell with active chapter selection, navigation, and account controls. -->
<!-- Exists so chapter users work inside one tenant/chapter context without leaving the church surface. -->
<!-- RELEVANT FILES: packages/web/src/lib/nav.ts, packages/web/src/lib/active-chapter.svelte.ts, packages/web/src/routes/admin/+layout.svelte -->

<script lang="ts">
  // Church-admin (chapter-scoped) shell. Mirrors the zonal shell so the two
  // surfaces feel like siblings: brand → chapter strip → grouped nav →
  // profile footer. The key difference is the *chapter* switcher in place
  // of the zone switcher.
  //
  // Chapter list comes from /api/public/session-zones — the user's chapter
  // role bindings within their active zone. The picked chapter is persisted
  // to localStorage under ACTIVE_CHAPTER_KEY so reloads stay sticky.

  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import {
    activeChapter as activeChapterStore,
    hydrateActiveChapter,
    setActiveChapter,
    setActiveChapterChoices,
    type ChapterChoice,
  } from "$lib/active-chapter.svelte";
  import { api } from "$lib/api";
  import MobileNavDrawer from "$lib/MobileNavDrawer.svelte";
  import MobileNavTrigger from "$lib/MobileNavTrigger.svelte";
  import SidebarNav from "$lib/SidebarNav.svelte";
  import { CHURCH_NAV } from "$lib/nav";
  import {
    authenticatedLandingPath,
    canAccessRole,
    isSuperAdmin,
    landingInputFor,
    session,
    signOut,
  } from "$lib/session.svelte";

  let { children } = $props();

  const path = $derived(page.url.pathname);
  const authed = $derived(session.current.status === "authenticated");

  // Role gate. Mirrors the zonal shell: bounce users who can't make use of
  // this surface back to their canonical landing instead of letting them
  // see a sidebar that won't function. Super-admins, zone-role holders, and
  // chapter-bound users all qualify.
  $effect(() => {
    const input = landingInputFor(session.current);
    if (!input) return;
    if (!canAccessRole(input, "church")) {
      goto(authenticatedLandingPath(input), { replaceState: true });
    }
  });
  const showZoneLink = $derived.by(() => {
    const input = landingInputFor(session.current);
    return input ? canAccessRole(input, "zonal") : false;
  });
  const showAdminLink = $derived(isSuperAdmin(session.current));

  const sessionUser = $derived(
    session.current.status === "authenticated" ? session.current.user : null,
  );
  const profileLabel = $derived(sessionUser?.name?.trim() || sessionUser?.email || "Account");
  const profileInitial = $derived(
    (sessionUser?.name?.trim()?.[0] || sessionUser?.email?.[0] || "?").toUpperCase(),
  );

  // ─── Chapter list (distinct, name-sorted) ───────────────────────────────
  // A user may hold several roles within the same chapter (e.g. treasurer +
  // pastor-viewer); collapse those into one entry. The server already sorts
  // by chapter name, so a Map preserves that order.
  let zoneChapterChoices = $state<ChapterChoice[]>([]);
  let loadedZoneSlug = $state<string | null>(null);

  const activeZone = $derived.by(() => {
    const s = session.current;
    if (s.status !== "authenticated") return null;
    return s.zones.find((z) => z.slug === s.activeZoneSlug) ?? null;
  });

  const hasZoneRole = $derived((activeZone?.zoneRoles.length ?? 0) > 0);
  const chapterRoleChoices = $derived.by<ChapterChoice[]>(() => {
    if (!activeZone) return [];
    const seen = new Map<string, ChapterChoice>();
    for (const r of activeZone.chapterRoles) {
      if (!seen.has(r.chapterId)) {
        seen.set(r.chapterId, { id: r.chapterId, name: r.chapterName || r.chapterId });
      }
    }
    return [...seen.values()];
  });

  $effect(() => {
    const zone = activeZone;
    const requestedChapterId = page.url.searchParams.get("chapterId");
    if (!zone || !requestedChapterId) return;
    if (!hasZoneRole) {
      const match = chapterRoleChoices.find((chapter) => chapter.id === requestedChapterId);
      if (!match) return;
      setActiveChapter(match.id);
      setActiveChapterChoices(chapterRoleChoices);
      return;
    }
    const match = zoneChapterChoices.find((chapter) => chapter.id === requestedChapterId);
    if (!match) return;
    setActiveChapter(match.id);
    setActiveChapterChoices(zoneChapterChoices);
  });

  $effect(() => {
    const zone = activeZone;
    if (!zone || !hasZoneRole) {
      zoneChapterChoices = [];
      loadedZoneSlug = null;
      return;
    }
    if (loadedZoneSlug === zone.slug) return;
    let cancelled = false;
    api
      .get<{ items: Array<{ id: string; name: string }> }>("/api/tenant/chapters")
      .then((res) => {
        if (cancelled) return;
        zoneChapterChoices = res.items.map((chapter) => ({
          id: chapter.id,
          name: chapter.name,
        }));
        loadedZoneSlug = zone.slug;
      })
      .catch(() => {
        if (cancelled) return;
        zoneChapterChoices = [];
        loadedZoneSlug = null;
      });
    return () => {
      cancelled = true;
    };
  });

  const chapters = $derived.by<ChapterChoice[]>(() => {
    if (!activeZone) return [];
    if (hasZoneRole) return zoneChapterChoices;
    return chapterRoleChoices;
  });

  // Active chapter id lives in a module-level rune (`activeChapterStore`)
  // so every consumer — this layout AND every /church/* page using
  // `useActiveChapter()` — reads the same source. The effect below
  // hydrates from localStorage and reconciles the stored id against the
  // user's current chapter bindings (a revoked role / deleted chapter
  // shouldn't leave them pointing nowhere).
  $effect(() => {
    hydrateActiveChapter();
    const list = chapters;
    if (list.length > 0) setActiveChapterChoices(list);
    if (list.length === 0) {
      if (hasZoneRole) return;
      if (activeChapterStore.id !== null) setActiveChapter(null);
      return;
    }
    const current = activeChapterStore.id;
    const valid = current && list.some((c) => c.id === current) ? current : list[0]?.id ?? null;
    if (valid !== current) setActiveChapter(valid);
  });

  const activeChapterId = $derived(activeChapterStore.id);
  const activeChapter = $derived(chapters.find((c) => c.id === activeChapterId) ?? null);

  // ─── Popovers ────────────────────────────────────────────────────────────
  let profileOpen = $state(false);
  let chapterSwitcherOpen = $state(false);
  let mobileNavOpen = $state(false);
  function openMobileNav() {
    mobileNavOpen = true;
  }
  function closeMobileNav() {
    mobileNavOpen = false;
  }

  function toggleProfile() {
    profileOpen = !profileOpen;
    if (profileOpen) chapterSwitcherOpen = false;
  }
  function closeProfile() {
    profileOpen = false;
  }
  function toggleChapterSwitcher() {
    chapterSwitcherOpen = !chapterSwitcherOpen;
    if (chapterSwitcherOpen) profileOpen = false;
  }
  function closeChapterSwitcher() {
    chapterSwitcherOpen = false;
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      profileOpen = false;
      chapterSwitcherOpen = false;
    }
  }

  async function handleSignOut() {
    closeProfile();
    await signOut();
    await goto("/login");
  }

  // Set the active chapter and refresh page loaders. The shared store
  // pushes the change to every page using `useActiveChapter()`; we also
  // call `invalidateAll()` so any `+page.server.ts` / `+page.ts` loaders
  // (none yet, but coming) re-run with the new scope.
  async function selectChapter(id: string) {
    closeChapterSwitcher();
    if (!id || id === activeChapterId) return;
    // Defensive: don't accept an id outside the user's current chapter set.
    if (!chapters.some((c) => c.id === id)) return;
    setActiveChapter(id);
    await invalidateAll();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if authed}
  <div class="flex min-h-screen w-full">
    <!-- ============ Sidebar ============ -->
    <aside
      class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--rule)] lg:flex"
      style="background: linear-gradient(180deg, var(--brass-soft) 0%, var(--paper) 22%, var(--paper) 100%)"
    >
      <a href="/" class="flex items-center gap-3 px-6 pt-6 pb-5">
        <span
          class="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--ink)] bg-[var(--ink)] text-[11px] font-medium text-[var(--paper)] sl-display"
          style="letter-spacing:0"
        >S</span>
        <span class="sl-display text-[17px] font-medium tracking-tight text-[var(--ink)]">
          Steward<span class="sl-serif-italic font-normal text-[var(--brass-deep)]">Ledger</span>
        </span>
      </a>

      <!-- Chapter switcher appears only when there is something to switch. -->
      {#if chapters.length > 1}
        <div class="mx-6 mb-7 border-t border-[var(--rule)] pt-5">
          <div class="relative">
            <button
              type="button"
              onclick={toggleChapterSwitcher}
              aria-haspopup="listbox"
              aria-expanded={chapterSwitcherOpen}
              class="sl-scope-trigger flex w-full items-start gap-3 rounded-[3px] text-left transition-colors hover:bg-[var(--paper-soft)]"
            >
              <span
                class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style="background:var(--brass);box-shadow:0 0 0 3px rgba(168,116,50,0.18)"
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1">
                <span class="sl-eyebrow block" style="color:var(--brass-deep)">Chapter</span>
                <span class="block truncate text-[13px] font-medium text-[var(--ink)]">
                  {activeChapter?.name ?? "Select a chapter"}
                </span>
                <span class="block truncate text-[11.5px] leading-snug text-[var(--ink-mute)]">
                  {chapters.length} chapters
                </span>
              </span>
              <svg class="mt-1 h-3 w-3 shrink-0 text-[var(--ink-mute)]" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
            </button>
            {#if chapterSwitcherOpen}
              <ul
                role="listbox"
                class="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-[3px] border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]"
              >
                {#each chapters as c (c.id)}
                  <li>
                    <button
                      type="button"
                      onclick={() => selectChapter(c.id)}
                      role="option"
                      aria-selected={c.id === activeChapterId}
                      class="flex w-full items-baseline gap-3 border-b border-[var(--rule)] px-3 py-2 text-left last:border-b-0 transition-colors hover:bg-[var(--paper-soft)]"
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[13px] text-[var(--ink)]">{c.name}</span>
                      </span>
                      {#if c.id === activeChapterId}
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

      <nav class="flex flex-1 flex-col gap-5 overflow-y-auto px-6">
        <SidebarNav groups={CHURCH_NAV} pathname={path} storageKey="church" />

        {#if showZoneLink || showAdminLink}
          <div class="mt-2 border-t border-[var(--rule)] pt-5">
            {#if showZoneLink}
              <a href="/zone/chapters" class="sl-side-link">
                <span class="sl-side-link-rail" aria-hidden="true"></span>
                <span class="truncate">Zone view →</span>
              </a>
            {/if}
            {#if showAdminLink}
              <a
                href="/admin/zones"
                class="sl-side-link"
                style="color:var(--brass-deep)"
              >
                <span class="sl-side-link-rail" aria-hidden="true"></span>
                <span class="truncate">Platform admin →</span>
              </a>
            {/if}
          </div>
        {/if}
      </nav>

      <!-- Profile -->
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
          <svg class="h-3 w-3 shrink-0 text-[var(--ink-mute)]" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </aside>

    <!-- ============ Content column ============ -->
    <div class="min-w-0 flex-1">
      <div
        class="border-b border-[var(--rule)] lg:hidden"
        style="background: linear-gradient(180deg, var(--brass-soft) 0%, var(--paper) 100%)"
      >
        <div class="flex items-center justify-between gap-3 px-5 py-3 sm:px-8">
          <div class="flex min-w-0 items-center gap-2">
            <MobileNavTrigger open={mobileNavOpen} controls="sl-mobile-nav-church" onclick={openMobileNav} />
            <a href="/" class="flex items-center gap-2">
              <span
                class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] bg-[var(--ink)] text-[10px] font-medium text-[var(--paper)] sl-display"
                >S</span
              >
              <span class="sl-display text-[15px] font-medium text-[var(--ink)]">
                Steward<span class="sl-serif-italic font-normal text-[var(--brass-deep)]">Ledger</span>
              </span>
            </a>
          </div>
          <div class="flex items-center gap-3">
            {#if activeChapter}
              <span class="max-w-[10rem] truncate text-[12px] text-[var(--ink-mute)]" title={activeChapter.name}>
                {activeChapter.name}
              </span>
            {:else}
              <span class="sl-eyebrow" style="font-size:10px">Church</span>
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
      </div>

      <MobileNavDrawer
        open={mobileNavOpen}
        onclose={closeMobileNav}
        eyebrow="Chapter"
        title={activeChapter?.name ?? "Navigation"}
      >
        <!-- Chapter switcher: native <select> wins on mobile — OS pickers handle
             long lists, search, and accessibility better than any custom popover. -->
        {#if chapters.length > 1}
          <label class="mb-5 flex flex-col gap-1.5">
            <span class="sl-eyebrow" style="font-size:9.5px">Switch chapter</span>
            <select
              value={activeChapterId ?? ""}
              onchange={(e) => {
                closeMobileNav();
                selectChapter((e.target as HTMLSelectElement).value);
              }}
              class="sl-select"
              style="padding:0.5rem 0.6rem;font-size:13px"
            >
              {#each chapters as c (c.id)}
                <option value={c.id}>{c.name}</option>
              {/each}
            </select>
          </label>
        {/if}

        <nav class="flex flex-col gap-5" id="sl-mobile-nav-church">
          <SidebarNav groups={CHURCH_NAV} pathname={path} storageKey="church" />
          {#if showZoneLink || showAdminLink}
            <div class="mt-2 border-t border-[var(--rule)] pt-4">
              {#if showZoneLink}
                <a href="/zone/chapters" class="sl-side-link">
                  <span class="sl-side-link-rail" aria-hidden="true"></span>
                  <span class="truncate">Zone view →</span>
                </a>
              {/if}
              {#if showAdminLink}
                <a href="/admin/zones" class="sl-side-link" style="color:var(--brass-deep)">
                  <span class="sl-side-link-rail" aria-hidden="true"></span>
                  <span class="truncate">Platform admin →</span>
                </a>
              {/if}
            </div>
          {/if}
        </nav>

        <div class="mt-6 border-t border-[var(--rule)] pt-4">
          <a href="/account" class="sl-side-link">
            <span class="sl-side-link-rail" aria-hidden="true"></span>
            <span class="truncate">Profile &amp; password</span>
          </a>
          <button
            type="button"
            onclick={() => {
              closeMobileNav();
              handleSignOut();
            }}
            class="sl-side-link w-full text-left"
          >
            <span class="sl-side-link-rail" aria-hidden="true"></span>
            <span class="truncate">Sign out</span>
          </button>
        </div>
      </MobileNavDrawer>

      <div class="px-6 pt-6 pb-12 sm:px-10 lg:pt-10 lg:pr-12 lg:pl-12">
        {@render children?.()}
      </div>
    </div>
  </div>
{:else}
  {@render children?.()}
{/if}
