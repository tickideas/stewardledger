<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { PUBLIC_API_URL } from "$lib/env";
  import {
    ACTIVE_ZONE_KEY,
    isProtectedPath,
    isSafeInternalPath,
    loadSession,
  } from "$lib/session.svelte";

  let email = $state("");
  let password = $state("");
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  // Banner for cases where the layout redirected the user here with context
  // (e.g. signed in but no zone bindings).
  const banner = $derived.by(() => {
    const code = page.url.searchParams.get("error");
    if (code === "no_zone") {
      return "Your account is signed in but not yet linked to a zone. Ask your zone owner for an invitation.";
    }
    return null;
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    errorMsg = null;
    submitting = true;
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password, rememberMe: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Could not sign in.");
      }

      const zonesRes = await fetch(`${PUBLIC_API_URL}/api/public/session-zones`, {
        credentials: "include",
      });
      if (!zonesRes.ok) throw new Error("Could not load your zones.");
      const zonesBody = (await zonesRes.json()) as { items: Array<{ slug: string }> };
      const zoneSlug = zonesBody.items[0]?.slug;
      if (!zoneSlug) throw new Error("Your account is not linked to a zone.");
      localStorage.setItem(ACTIVE_ZONE_KEY, zoneSlug);
      // Refresh the in-memory session so the navbar updates before navigation.
      await loadSession();

      // Honour ?next=… only when it is a same-origin internal path that
      // matches our known protected prefixes. The dual check protects against
      // protocol-relative (`//evil.com`) and backslash (`/\evil.com`) tricks,
      // and the `isProtectedPath` filter narrows it to routes we already
      // intend to serve.
      const next = page.url.searchParams.get("next");
      if (next && isSafeInternalPath(next) && isProtectedPath(next)) {
        await goto(next);
      } else {
        await goto(`/onboarding/chapter?zone=${encodeURIComponent(zoneSlug)}`);
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Could not sign in.";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="max-w-md mx-auto px-6 py-24">
  <h1 class="text-3xl font-semibold tracking-tight">Sign in to StewardLedger</h1>
  <p class="mt-2 text-sm text-slate-600">
    Enter the email and password you used when accepting your invitation.
  </p>
  {#if banner}
    <p
      class="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      {banner}
    </p>
  {/if}
  <form class="mt-8 space-y-4" onsubmit={submit}>
    <label class="block">
      <span class="text-sm text-slate-700">Email</span>
      <input
        type="email"
        name="email"
        required
        autocomplete="email"
        bind:value={email}
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
    <label class="block">
      <span class="text-sm text-slate-700">Password</span>
      <input
        type="password"
        name="password"
        required
        autocomplete="current-password"
        bind:value={password}
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
    {#if errorMsg}
      <p class="text-sm text-red-600">{errorMsg}</p>
    {/if}
    <button
      type="submit"
      disabled={submitting}
      class="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
    >
      {submitting ? "Signing in…" : "Sign in"}
    </button>
  </form>
  <p class="mt-6 text-xs text-slate-400 text-center">
    By signing in you agree to our Terms and Privacy Policy.
  </p>
</div>
