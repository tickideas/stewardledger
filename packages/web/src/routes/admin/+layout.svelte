<!-- packages/web/src/routes/admin/+layout.svelte -->
<!-- Platform-admin shell with brand, scoped navigation, and account controls. -->
<!-- Exists to keep platform-only routes visually and behaviorally separate from tenant surfaces. -->
<!-- RELEVANT FILES: packages/web/src/lib/nav.ts, packages/web/src/routes/zone/+layout.svelte, packages/web/src/routes/church/+layout.svelte -->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { PLATFORM_NAV, isNavActive } from "$lib/nav";
  import { isSuperAdmin, isSuperAdminOnlyPath, session, signOut } from "$lib/session.svelte";

  let { children } = $props();

  $effect(() => {
    const s = session.current;
    if (
      s.status === "authenticated" &&
      !s.isSuperAdmin &&
      isSuperAdminOnlyPath(page.url.pathname)
    ) {
      goto("/zone/chapters", { replaceState: true });
    }
  });

  const allow = $derived.by(() => {
    const s = session.current;
    if (s.status === "loading") return true;
    if (isSuperAdmin(s)) return true;
    if (s.status === "authenticated") return !isSuperAdminOnlyPath(page.url.pathname);
    return false;
  });

  const path = $derived(page.url.pathname);

  // What can the current user actually open?
  //
  //   - /admin/zones          super_admin OR support_admin
  //   - /admin/administrators super_admin only
  //   - everything else under /admin/* is implicitly admin-wide
  //
  // Filter the nav so we don't surface links the API would 403.
  const sessionPlatformRoles = $derived.by(() => {
    const s = session.current;
    return s.status === "authenticated" ? (s.platformRoles ?? []) : [];
  });
  const canSeeZones = $derived(
    isSuperAdmin(session.current) || sessionPlatformRoles.includes("support_admin"),
  );
  const canSeeAdministrators = $derived(isSuperAdmin(session.current));

  const groups = $derived(
    PLATFORM_NAV.map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        if (it.href === "/admin/zones") return canSeeZones;
        if (it.href === "/admin/administrators") return canSeeAdministrators;
        return true;
      }),
    })).filter((g) => g.items.length > 0),
  );

  const sessionUser = $derived(
    session.current.status === "authenticated" ? session.current.user : null,
  );
  const profileLabel = $derived(sessionUser?.name?.trim() || sessionUser?.email || "Account");
  const profileInitial = $derived(
    (sessionUser?.name?.trim()?.[0] || sessionUser?.email?.[0] || "?").toUpperCase(),
  );

  let profileOpen = $state(false);
  function toggleProfile() {
    profileOpen = !profileOpen;
  }
  function closeProfile() {
    profileOpen = false;
  }

  async function handleSignOut() {
    closeProfile();
    await signOut();
    await goto("/login");
  }

  // Click-outside / Escape to close the profile popover.
  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") closeProfile();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if allow}
  <div class="flex min-h-screen w-full">
    <!-- ============ Sidebar ============ -->
    <aside
      class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--rule)] lg:flex"
      style="background: linear-gradient(180deg, var(--brass-soft) 0%, var(--paper) 22%, var(--paper) 100%)"
    >
      <!-- Brand (replaces the root header on /admin) -->
      <a href="/" class="flex items-center gap-3 px-6 pt-6 pb-5">
        <span
          class="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--ink)] bg-[var(--ink)] text-[11px] font-medium text-[var(--paper)] sl-display"
          style="letter-spacing:0"
        >S</span>
        <span class="sl-display text-[17px] font-medium tracking-tight text-[var(--ink)]">
          Steward<span class="sl-serif-italic font-normal text-[var(--brass-deep)]">Ledger</span>
        </span>
      </a>

      <!-- Scope strip -->
      <div class="mx-6 mb-7 flex items-start gap-3 border-t border-[var(--rule)] pt-5">
        <span
          class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style="background:var(--brass);box-shadow:0 0 0 3px rgba(168,116,50,0.18)"
          aria-hidden="true"
        ></span>
        <div class="min-w-0">
          <div class="sl-eyebrow" style="color:var(--brass-deep)">Platform Admin</div>
          <p class="mt-1 text-[11.5px] leading-snug text-[var(--ink-mute)]">
            Cross-zone access · every action is audited
          </p>
        </div>
      </div>

      <nav class="flex flex-1 flex-col gap-7 overflow-y-auto px-6">
        {#each groups as group (group.label)}
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
      </nav>

      <!-- Profile + sign-out -->
      <div class="relative border-t border-[var(--rule)] px-4 py-3">
        {#if profileOpen}
          <!-- Popover above the trigger -->
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
      <!-- Mobile header: sidebar collapses below `lg`, so we surface the -->
      <!-- brand + scope + a flat nav in a compact strip.                 -->
      <div
        class="border-b border-[var(--rule)] lg:hidden"
        style="background: linear-gradient(180deg, var(--brass-soft) 0%, var(--paper) 100%)"
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
            <span class="sl-eyebrow" style="color:var(--brass-deep);font-size:10px">Platform</span>
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
          {#each groups as group (group.label)}
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
{/if}
