<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { isProtectedPath, loadSession, session, signOut } from "$lib/session.svelte";

  let { children } = $props();

  // Kick off session resolution on first client render. SSR cannot see the
  // API's host-only session cookie (different origin), so gating happens here.
  $effect(() => {
    loadSession();
  });

  // Redirect unauthenticated visitors away from protected paths the moment
  // we know they're anonymous. Guarded so we never bounce away from /login
  // itself (avoids a self-redirect loop) and so transient `error` states
  // don't kick a still-signed-in user back to the login screen.
  $effect(() => {
    const status = session.current.status;
    const path = page.url.pathname;
    if (status === "anonymous" && isProtectedPath(path) && path !== "/login") {
      const next = encodeURIComponent(path + page.url.search);
      goto(`/login?next=${next}`, { replaceState: true });
    }
  });

  // Authenticated users hitting /login or /signup get punted to the app
  // shell. Treat /onboarding/chapter as the canonical landing for users
  // whose first action is still picking a chapter; otherwise drop them on
  // /members which is the main read-mostly entry point.
  $effect(() => {
    if (session.current.status !== "authenticated") return;
    const path = page.url.pathname;
    if (path === "/login" || path === "/signup" || path.startsWith("/signup/")) {
      const slug = session.current.activeZoneSlug;
      const target = slug ? `/onboarding/chapter?zone=${encodeURIComponent(slug)}` : "/members";
      goto(target, { replaceState: true });
    }
  });

  // Users with a session but no zone bindings: keep them on /login with a
  // banner-equivalent state. Anywhere protected, bounce home.
  $effect(() => {
    if (session.current.status !== "no_zone") return;
    const path = page.url.pathname;
    if (isProtectedPath(path)) {
      goto("/login?error=no_zone", { replaceState: true });
    }
  });

  const isAuthed = $derived(session.current.status === "authenticated");
  const activeZone = $derived(
    session.current.status === "authenticated"
      ? session.current.zones.find((z) => z.slug === session.current.activeZoneSlug) ?? null
      : null,
  );

  async function handleSignOut() {
    await signOut();
    await goto("/login");
  }
</script>

<div class="min-h-screen flex flex-col">
  <header class="border-b bg-white">
    <div class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
      <a href="/" class="text-xl font-semibold tracking-tight">StewardLedger</a>
      <nav class="text-sm text-slate-600 flex items-center gap-4">
        {#if isAuthed}
          <a href="/members" class="hover:text-slate-900">Members</a>
          <a href="/contributions" class="hover:text-slate-900">Contributions</a>
          <a href="/imports" class="hover:text-slate-900">Imports</a>
          <a href="/reports" class="hover:text-slate-900">Reports</a>
          {#if activeZone}
            <span class="text-slate-400">·</span>
            <span class="text-slate-500" title={activeZone.slug}>{activeZone.name}</span>
          {/if}
          <button
            type="button"
            onclick={handleSignOut}
            class="hover:text-slate-900 underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        {:else if session.current.status === "anonymous" || session.current.status === "no_zone" || session.current.status === "error"}
          <a href="/signup" class="hover:text-slate-900">Set up a zone</a>
          <a href="/login" class="hover:text-slate-900">Sign in</a>
        {/if}
      </nav>
    </div>
  </header>

  <main class="flex-1">
    {@render children?.()}
  </main>

  <footer class="border-t bg-white">
    <div class="max-w-6xl mx-auto px-6 py-6 text-xs text-slate-500 text-center">
      Powered by StewardLedger &middot; stewardledger.church
    </div>
  </footer>
</div>
