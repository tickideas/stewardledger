<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { PUBLIC_API_URL } from "$lib/env";
  import {
    ACTIVE_ZONE_KEY,
    authenticatedLandingPath,
    loadSession,
  } from "$lib/session.svelte";

  let email = $state("");
  let password = $state("");
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  // Two-factor challenge state. Better Auth's two-factor plugin
  // intercepts /sign-in/email when the user has TOTP enabled and
  // returns `{ twoFactorRedirect: true }` instead of setting the
  // session cookie. The plugin parks the half-finished sign-in in a
  // signed `better-auth.two_factor` cookie that the verify endpoint
  // consumes. We swap the form into a 6-digit TOTP prompt and POST
  // to /api/auth/two-factor/verify-totp.
  let mfaPending = $state(false);
  let totpCode = $state("");

  const banner = $derived.by(() => {
    const code = page.url.searchParams.get("error");
    if (code === "no_zone") {
      return "Your account is signed in but not yet linked to a zone. Ask your zone owner for an invitation.";
    }
    if (page.url.searchParams.get("verified") === "1") {
      return "Email verified. Sign in to continue.";
    }
    return null;
  });

  /**
   * Resolve the post-sign-in destination by reading the session zones
   * and routing to the canonical landing page. Shared between the
   * password sign-in path and the TOTP verify path because both end
   * with "a fresh session cookie is set; figure out where to send
   * the user".
   *
   * Order is important: we call /session-zones FIRST so a missing
   * session cookie (third-party-cookie blocking, cookie-domain
   * misconfiguration) surfaces as a 401 here, rather than persisting
   * a zone slug to localStorage that the next request can't act on.
   * Only after a 2xx response do we commit the slug + force-reload
   * the session store.
   */
  async function landAfterSignIn(): Promise<void> {
    const zonesRes = await fetch(`${PUBLIC_API_URL}/api/public/session-zones`, {
      credentials: "include",
    });
    if (zonesRes.status === 401) {
      // The Better Auth endpoint accepted the credentials but the
      // session cookie didn't make it back. Almost always a cookie
      // scope / SameSite issue on a split-host deployment.
      throw new Error(
        "Sign-in succeeded but the session cookie was not set. Check that the API and web origins can share cookies.",
      );
    }
    if (!zonesRes.ok) throw new Error("Could not load your zones.");
    const zonesBody = (await zonesRes.json()) as {
      items: Array<{
        slug: string;
        zoneRoles?: string[];
        chapterRoles?: Array<{ chapterId: string; roleCode: string }>;
      }>;
      isSuperAdmin?: boolean;
    };
    const firstZone = zonesBody.items[0];
    const zoneSlug = firstZone?.slug;
    const isSuperAdminFlag = zonesBody.isSuperAdmin === true;

    if (!zoneSlug && !isSuperAdminFlag) {
      throw new Error("Your account is not linked to a zone.");
    }
    // Persist + refresh only once we know the session actually
    // landed. A stale slug from a prior session is preserved
    // untouched on failure paths above so the next attempt isn't
    // poisoned.
    if (zoneSlug) {
      localStorage.setItem(ACTIVE_ZONE_KEY, zoneSlug);
    }
    await loadSession({ force: true });

    await goto(
      authenticatedLandingPath(
        {
          activeZoneSlug: zoneSlug ?? null,
          isSuperAdmin: isSuperAdminFlag,
          activeZoneRoles: firstZone?.zoneRoles ?? [],
          activeZoneChapterRoles: firstZone?.chapterRoles ?? [],
        },
        page.url.searchParams.get("next"),
      ),
    );
  }

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
      // Two-factor enrolled accounts get a `twoFactorRedirect: true`
      // body instead of a session. Swap into the TOTP-prompt branch
      // — the password is already discarded by the plugin's
      // verification cookie.
      const body = (await res.json().catch(() => null)) as
        | { twoFactorRedirect?: boolean }
        | null;
      if (body?.twoFactorRedirect) {
        mfaPending = true;
        password = "";
        return;
      }
      await landAfterSignIn();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Could not sign in.";
    } finally {
      submitting = false;
    }
  }

  async function verifyTotp(e: SubmitEvent) {
    e.preventDefault();
    errorMsg = null;
    submitting = true;
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: totpCode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Code rejected.");
      }
      totpCode = "";
      mfaPending = false;
      await landAfterSignIn();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Could not verify the code.";
    } finally {
      submitting = false;
    }
  }

  function cancelMfa() {
    mfaPending = false;
    totpCode = "";
    errorMsg = null;
  }
</script>

<section class="mx-auto grid min-h-[calc(100vh-160px)] max-w-7xl grid-cols-1 px-8 md:grid-cols-12">
  <!-- Editorial left rail -->
  <aside class="hidden md:col-span-6 md:flex md:flex-col md:justify-between md:border-r md:border-[var(--rule)] md:py-20 md:pr-12">
    <div class="sl-reveal sl-reveal-1">
      <span class="sl-eyebrow">Folio · Sign in</span>
      <h2 class="mt-6 sl-display text-[64px] leading-[0.95] text-[var(--ink)]">
        Open the
        <span class="sl-serif-italic font-light text-[var(--brass-deep)]">ledger.</span>
      </h2>
      <p class="mt-6 max-w-md text-[15px] leading-relaxed text-[var(--ink-mute)]">
        Sign in with the credentials from your invitation. Every action you take
        from here is signed, time-stamped, and traceable to your zone.
      </p>
    </div>

    <div class="sl-reveal sl-reveal-3 mt-16 max-w-md border-t border-[var(--rule)] pt-8">
      <p class="sl-display text-[16px] italic leading-relaxed text-[var(--ink-soft)]">
        “Moreover, it is required of stewards that they be found
        <span class="not-italic" style="font-family:var(--font-body);font-weight:500;color:var(--ink)">trustworthy</span>.”
      </p>
      <p class="mt-3 sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        — 1 Cor 4 : 2
      </p>
    </div>
  </aside>

  <!-- Form column -->
  <div class="sl-reveal sl-reveal-2 col-span-1 flex items-center justify-center py-16 md:col-span-6 md:py-20 md:pl-12">
    <div class="w-full max-w-md">
      <div class="md:hidden">
        <span class="sl-eyebrow">Sign in</span>
        <h1 class="mt-3 sl-display text-[44px] leading-[0.95] text-[var(--ink)]">
          Open the
          <span class="sl-serif-italic font-light text-[var(--brass-deep)]">ledger.</span>
        </h1>
      </div>

      <div class="hidden md:block">
        <span class="sl-eyebrow">Credentials</span>
        <div class="mt-2 h-px w-12 bg-[var(--brass)]"></div>
      </div>

      {#if banner}
        <div class="mt-8 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-[13px] text-[var(--ink-soft)]">
          {banner}
        </div>
      {/if}

      {#if !mfaPending}
        <form class="mt-10 space-y-6" onsubmit={submit}>
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
            <input
              type="email"
              name="email"
              required
              autocomplete="email"
              bind:value={email}
              class="sl-input mt-2"
              placeholder="treasurer@chapter.church"
            />
          </label>
          <label class="block">
            <div class="flex items-baseline justify-between">
              <span class="sl-eyebrow" style="font-size:10.5px">Password</span>
            </div>
            <input
              type="password"
              name="password"
              required
              autocomplete="current-password"
              bind:value={password}
              class="sl-input mt-2"
              placeholder="••••••••••••"
            />
          </label>

          {#if errorMsg}
            <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {errorMsg}
            </p>
          {/if}

          <button
            type="submit"
            disabled={submitting}
            class="sl-btn sl-btn-primary w-full justify-center"
            style="padding:0.85rem 1rem"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      {:else}
        <form class="mt-10 space-y-6" onsubmit={verifyTotp}>
          <p class="text-[13px] text-[var(--ink-mute)]">
            Two-factor required. Enter the 6-digit code from your
            authenticator app.
          </p>
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">6-digit code</span>
            <input
              type="text"
              inputmode="numeric"
              pattern="[0-9]{6}"
              autocomplete="one-time-code"
              required
              minlength={6}
              maxlength={6}
              bind:value={totpCode}
              title="Enter the 6-digit code from your authenticator app"
              class="sl-input sl-mono mt-2"
              placeholder="123456"
            />
          </label>

          {#if errorMsg}
            <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {errorMsg}
            </p>
          {/if}

          <div class="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              class="sl-btn sl-btn-primary flex-1 justify-center"
              style="padding:0.85rem 1rem"
            >
              {submitting ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              onclick={cancelMfa}
              disabled={submitting}
              class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
            >Cancel</button>
          </div>
        </form>
      {/if}

      <div class="mt-10 flex items-center gap-3 text-[11px] text-[var(--ink-mute)]">
        <span class="h-px flex-1 bg-[var(--rule)]"></span>
        <span class="sl-mono" style="letter-spacing:0.16em">SECURE · TLS · BETTER-AUTH</span>
        <span class="h-px flex-1 bg-[var(--rule)]"></span>
      </div>

      <p class="mt-6 text-center text-[12px] text-[var(--ink-mute)]">
        By signing in you agree to our
        <a class="sl-link" href="/">Terms</a> and <a class="sl-link" href="/">Privacy Policy</a>.
      </p>
    </div>
  </div>
</section>
