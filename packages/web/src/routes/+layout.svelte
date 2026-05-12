<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    authenticatedLandingPath,
    isProtectedPath,
    isSuperAdmin,
    loadSession,
    session,
    signOut,
  } from "$lib/session.svelte";

  let { children } = $props();

  $effect(() => {
    loadSession();
  });

  $effect(() => {
    const status = session.current.status;
    const path = page.url.pathname;
    if (status === "anonymous" && isProtectedPath(path) && path !== "/login") {
      const next = encodeURIComponent(path + page.url.search);
      goto(`/login?next=${next}`, { replaceState: true });
    }
  });

  $effect(() => {
    if (session.current.status !== "authenticated") return;
    const path = page.url.pathname;
    if (path === "/login") {
      goto(authenticatedLandingPath(session.current), { replaceState: true });
    }
  });

  $effect(() => {
    if (session.current.status !== "no_zone") return;
    const path = page.url.pathname;
    if (isProtectedPath(path)) {
      goto("/login?error=no_zone", { replaceState: true });
    }
  });

  const isAuthed = $derived(session.current.status === "authenticated");
  const showAdminLink = $derived(isSuperAdmin(session.current));
  const activeZone = $derived(
    session.current.status === "authenticated"
      ? session.current.zones.find((z) => z.slug === session.current.activeZoneSlug) ?? null
      : null,
  );

  const path = $derived(page.url.pathname);
  const isLanding = $derived(path === "/");

  function isActive(prefix: string): boolean {
    if (prefix === "/") return path === "/";
    return path === prefix || path.startsWith(prefix + "/");
  }

  async function handleSignOut() {
    await signOut();
    await goto("/login");
  }
</script>

<div class="sl-app flex min-h-screen flex-col">
  <header class="border-b border-[var(--rule)] bg-[var(--paper)]/80 backdrop-blur-sm">
    <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-4 px-5 py-5 sm:px-8">
      <a href="/" class="group flex items-center gap-3">
        <span
          class="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--ink)] bg-[var(--ink)] text-[11px] font-medium text-[var(--paper)] sl-display"
          style="letter-spacing:0"
        >S</span>
        <span class="sl-display text-[19px] font-medium tracking-tight text-[var(--ink)]">
          Steward<span class="sl-serif-italic font-normal text-[var(--brass-deep)]">Ledger</span>
        </span>
      </a>

      <nav class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-5 gap-y-3 sm:gap-x-7">
        {#if isAuthed}
          <a
            href="/members"
            class="sl-nav-link"
            aria-current={isActive("/members") ? "page" : undefined}>Zone</a
          >
          <a
            href="/contributions"
            class="sl-nav-link"
            aria-current={isActive("/contributions") ? "page" : undefined}>Contributions</a
          >
          <a
            href="/imports"
            class="sl-nav-link"
            aria-current={isActive("/imports") ? "page" : undefined}>Imports</a
          >
          <a
            href="/reports"
            class="sl-nav-link"
            aria-current={isActive("/reports") ? "page" : undefined}>Reports</a
          >
          {#if showAdminLink}
            <a
              href="/admin/zones"
              class="sl-nav-link"
              style="color:var(--brass-deep)"
              aria-current={isActive("/admin") ? "page" : undefined}>Platform</a
            >
          {/if}

          <span class="h-4 w-px bg-[var(--rule-strong)]"></span>

          {#if activeZone}
            <div class="hidden max-w-44 min-w-0 items-center gap-2 text-[12px] md:flex">
              <span class="sl-eyebrow shrink-0" style="font-size:9.5px">Zone</span>
              <span class="truncate text-[var(--ink)]" title={activeZone.slug}>{activeZone.name}</span>
            </div>
          {/if}

          <button
            type="button"
            onclick={handleSignOut}
            class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)] transition-colors"
          >
            Sign out
          </button>
        {:else if session.current.status === "anonymous" || session.current.status === "no_zone" || session.current.status === "error"}
          <a href="/login" class="sl-btn sl-btn-ghost">Sign in</a>
        {/if}
      </nav>
    </div>
  </header>

  <main class="flex-1">
    {@render children?.()}
  </main>

  {#if !isLanding}
    <footer class="mt-16 border-t border-[var(--rule)]">
      <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-8 py-8 text-[11px] text-[var(--ink-mute)] sm:flex-row">
        <span class="sl-eyebrow">Steward<span class="sl-serif-italic normal-case tracking-normal" style="font-size:13px">Ledger</span></span>
        <span class="sl-mono" style="font-size:10.5px;letter-spacing:0.04em">stewardledger.church</span>
      </div>
    </footer>
  {/if}
</div>
