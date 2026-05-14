<!-- packages/web/src/routes/account/security/+page.svelte -->
<!-- Phase 9 §5 (PR 2) — TOTP enrollment surface. -->
<!-- Drives Better Auth's two-factor/enable → verify-totp → -->
<!-- generate-backup-codes → disable flow. Open to every -->
<!-- authenticated user; the layout effect redirects users with -->
<!-- a per-zone enforcement flag here via ?required=1. -->
<!-- RELEVANT FILES: packages/api/src/auth.ts, packages/api/src/services/mfa-policy.ts, packages/web/src/lib/qr.ts -->

<script lang="ts">
  import { page } from "$app/state";
  import { PUBLIC_API_URL } from "$lib/env";
  import { renderQrDataUrl } from "$lib/qr";
  import { loadSession, session } from "$lib/session.svelte";

  const user = $derived(
    session.current.status === "authenticated" ? session.current.user : null,
  );
  const sessionState = $derived(session.current);
  const enabled = $derived(user?.twoFactorEnabled === true);
  // Set when the layout's enforcement effect redirects an MFA-less
  // user with a required role here. Drives the banner copy + a
  // gentle nudge toward the enable flow.
  const requiredByPolicy = $derived(page.url.searchParams.get("required") === "1");

  // ─── Enrollment flow state ───────────────────────────────────────────
  // step: idle → password (collect pw) → verify (show QR + 6-digit input)
  //       → done (recovery codes shown once)
  //       → manage (already-enabled landing) → regenerate / disable subflows
  type Step = "idle" | "password" | "verify" | "done";
  let step = $state<Step>("idle");
  let password = $state("");
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  let flashMsg = $state<string | null>(null);
  let totpUri = $state<string | null>(null);
  let qrDataUrl = $state<string | null>(null);
  let backupCodes = $state<string[]>([]);
  let verifyCode = $state("");

  // ─── Regenerate / disable state ──────────────────────────────────────
  let regenOpen = $state(false);
  let regenPassword = $state("");
  let disableOpen = $state(false);
  let disablePassword = $state("");

  function resetEnrollState() {
    password = "";
    verifyCode = "";
    totpUri = null;
    qrDataUrl = null;
    backupCodes = [];
    errorMsg = null;
    flashMsg = null;
  }

  function setFlash(msg: string) {
    flashMsg = msg;
    setTimeout(() => {
      if (flashMsg === msg) flashMsg = null;
    }, 4000);
  }

  // Auth-flow helper: every Better Auth two-factor endpoint is a POST
  // under /api/auth/two-factor/. They consume `credentials: include`
  // for the session cookie. We surface the response's `message` on
  // failure for inline error rendering.
  //
  // SECURITY NOTE: the `enable` and `generate-backup-codes` responses
  // carry one-shot secrets (TOTP URI + plaintext recovery codes). They
  // are stored encrypted server-side, but the response body crosses
  // the wire — do NOT log, telemeter, or persist these values.
  async function authFetch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${PUBLIC_API_URL}/api/auth/two-factor/${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const parsed = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(parsed?.message ?? `Request failed (${res.status}).`);
    }
    return (await res.json()) as T;
  }

  async function startEnroll(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !password) return;
    busy = true;
    errorMsg = null;
    try {
      const body = await authFetch<{ totpURI: string; backupCodes: string[] }>(
        "enable",
        { password },
      );
      totpUri = body.totpURI;
      backupCodes = body.backupCodes;
      qrDataUrl = await renderQrDataUrl(body.totpURI);
      step = "verify";
      password = "";
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Could not start enrollment.";
    } finally {
      busy = false;
    }
  }

  async function verifyEnroll(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !verifyCode) return;
    busy = true;
    errorMsg = null;
    try {
      await authFetch<{ status: boolean }>("verify-totp", { code: verifyCode });
      step = "done";
      verifyCode = "";
      // Refresh session so `user.twoFactorEnabled` flips locally.
      await loadSession({ force: true });
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Could not verify the code.";
    } finally {
      busy = false;
    }
  }

  async function regenerateCodes(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !regenPassword) return;
    busy = true;
    errorMsg = null;
    try {
      const body = await authFetch<{ backupCodes: string[] }>(
        "generate-backup-codes",
        { password: regenPassword },
      );
      backupCodes = body.backupCodes;
      regenPassword = "";
      regenOpen = false;
      // Show the new codes in the same panel the post-enroll flow uses.
      step = "done";
      setFlash("New recovery codes generated. Save them now — they're shown once.");
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Could not regenerate codes.";
    } finally {
      busy = false;
    }
  }

  async function disableMfa(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !disablePassword) return;
    busy = true;
    errorMsg = null;
    try {
      await authFetch<{ status: boolean }>("disable", { password: disablePassword });
      disablePassword = "";
      disableOpen = false;
      step = "idle";
      resetEnrollState();
      await loadSession({ force: true });
      setFlash("Two-factor authentication disabled.");
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Could not disable MFA.";
    } finally {
      busy = false;
    }
  }

  async function copyAll() {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setFlash("Clipboard unavailable — copy the codes manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setFlash("Recovery codes copied to clipboard.");
    } catch {
      // Permission denied / iframe / Safari WebView. The codes are
      // still visible below; surface a clear message instead of
      // pretending the copy succeeded.
      setFlash("Could not copy automatically. Select the codes and copy manually.");
    }
  }
</script>

<svelte:head><title>Security · StewardLedger</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 pt-10 pb-16 sm:px-10 lg:px-12">
  <button
    type="button"
    onclick={() => (history.length > 1 ? history.back() : (location.href = "/account"))}
    class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--ink)] transition-colors"
  >← Back</button>
  <div class="sl-reveal mt-6">
    <p class="sl-eyebrow" style="font-size:10.5px">§ Account · Security</p>
    <h1 class="sl-display mt-2 text-[40px] leading-[1.05] tracking-tight text-[var(--ink)]">
      Two-factor <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">authentication</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Bind a one-time-password authenticator (Authy, 1Password, Google
      Authenticator, etc.) to your sign-in. Once enabled, password
      sign-ins ask for a 6-digit code.
    </p>
  </div>

  {#if sessionState.status === "loading"}
    <p class="mt-8 text-[13px] text-[var(--ink-mute)]">Loading…</p>
  {:else}
    {#if requiredByPolicy && !enabled}
      <!--
        Per-zone enforcement banner. The root layout redirected here
        because the user holds a role on this zone's required-role
        list. Stays visible until the user finishes the flow.
      -->
      <div class="mt-10 rounded-lg border border-[var(--brass)] bg-[var(--paper-soft)] p-6">
        <h2 class="text-[15px] font-medium text-[var(--ink)]">
          Your zone requires two-factor authentication.
        </h2>
        <p class="mt-2 max-w-xl text-[13px] text-[var(--ink-mute)]">
          Your role here requires a second factor. Enrol below to
          continue — you'll keep your current session, and the rest
          of the app unlocks as soon as MFA is on.
        </p>
      </div>
    {/if}
    <!-- ============ Already enrolled ============ -->
    {#if enabled && step !== "done"}
      <section class="mt-12 border-t border-[var(--rule)] pt-10">
        <header class="flex items-baseline justify-between gap-4">
          <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Status</h2>
          <span class="sl-eyebrow" style="font-size:10px">Active</span>
        </header>
        <p class="mt-4 text-[14px] text-[var(--ink)]">
          Two-factor authentication is <strong>on</strong>. Recovery codes
          are single-use; regenerate them if you've used them all.
        </p>

        {#if flashMsg}
          <p class="mt-4 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">
            {flashMsg}
          </p>
        {/if}
        {#if errorMsg}
          <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
            {errorMsg}
          </p>
        {/if}

        <!-- Regenerate. -->
        <div class="mt-6">
          {#if !regenOpen}
            <button
              type="button"
              onclick={() => {
                regenOpen = true;
                disableOpen = false;
                disablePassword = "";
                errorMsg = null;
              }}
              class="sl-btn"
            >Regenerate recovery codes</button>
          {:else}
            <form onsubmit={regenerateCodes} class="grid max-w-md gap-4 rounded-lg border bg-white p-4">
              <p class="text-[13px] text-[var(--ink-mute)]">
                Confirm your password. Old recovery codes stop working
                immediately.
              </p>
              <label class="block">
                <span class="sl-eyebrow" style="font-size:10.5px">Password</span>
                <input
                  type="password"
                  autocomplete="current-password"
                  bind:value={regenPassword}
                  required
                  class="sl-input mt-2"
                />
              </label>
              <div class="flex items-center gap-3">
                <button type="submit" disabled={busy} class="sl-btn sl-btn-primary">
                  {busy ? "Generating…" : "Regenerate"}
                </button>
                <button
                  type="button"
                  onclick={() => {
                    regenOpen = false;
                    regenPassword = "";
                  }}
                  disabled={busy}
                  class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                >Cancel</button>
              </div>
            </form>
          {/if}
        </div>

        <!-- Disable. -->
        <div class="mt-6">
          {#if !disableOpen}
            <button
              type="button"
              onclick={() => {
                disableOpen = true;
                regenOpen = false;
                regenPassword = "";
                errorMsg = null;
              }}
              class="sl-btn"
              style="border-color: var(--bad); color: var(--bad)"
            >Disable two-factor</button>
          {:else}
            <form onsubmit={disableMfa} class="grid max-w-md gap-4 rounded-lg border border-[var(--bad)] bg-[var(--bad-soft)] p-4">
              <p class="text-[13px] text-[var(--ink)]">
                Disabling MFA removes the second-factor requirement and
                deletes your recovery codes. Confirm with your password.
              </p>
              <label class="block">
                <span class="sl-eyebrow" style="font-size:10.5px">Password</span>
                <input
                  type="password"
                  autocomplete="current-password"
                  bind:value={disablePassword}
                  required
                  class="sl-input mt-2"
                />
              </label>
              <div class="flex items-center gap-3">
                <button type="submit" disabled={busy} class="sl-btn sl-btn-primary" style="background:var(--bad)">
                  {busy ? "Disabling…" : "Disable MFA"}
                </button>
                <button
                  type="button"
                  onclick={() => {
                    disableOpen = false;
                    disablePassword = "";
                  }}
                  disabled={busy}
                  class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                >Cancel</button>
              </div>
            </form>
          {/if}
        </div>
      </section>
    {/if}

    <!-- ============ Initial enrollment ============ -->
    {#if !enabled && step === "idle"}
      <section class="mt-12 border-t border-[var(--rule)] pt-10">
        <header class="flex items-baseline justify-between gap-4">
          <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Status</h2>
          <span class="sl-eyebrow" style="font-size:10px">Off</span>
        </header>
        <p class="mt-4 text-[14px] text-[var(--ink)]">
          Two-factor authentication is <strong>off</strong>.
        </p>
        <button
          type="button"
          onclick={() => {
            step = "password";
            errorMsg = null;
          }}
          class="sl-btn sl-btn-primary mt-6"
        >Enable two-factor</button>
      </section>
    {/if}

    {#if !enabled && step === "password"}
      <section class="mt-12 border-t border-[var(--rule)] pt-10">
        <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Confirm password</h2>
        <p class="mt-3 max-w-xl text-[13px] text-[var(--ink-mute)]">
          We'll generate a secret + recovery codes. Have an authenticator
          app open.
        </p>
        <form onsubmit={startEnroll} class="mt-6 grid max-w-md gap-4">
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">Password</span>
            <input
              type="password"
              autocomplete="current-password"
              bind:value={password}
              required
              class="sl-input mt-2"
            />
          </label>
          {#if errorMsg}
            <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {errorMsg}
            </p>
          {/if}
          <div class="flex items-center gap-3">
            <button type="submit" disabled={busy} class="sl-btn sl-btn-primary">
              {busy ? "Working…" : "Continue"}
            </button>
            <button
              type="button"
              onclick={() => {
                step = "idle";
                resetEnrollState();
              }}
              disabled={busy}
              class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
            >Cancel</button>
          </div>
        </form>
      </section>
    {/if}

    {#if step === "verify"}
      <section class="mt-12 border-t border-[var(--rule)] pt-10">
        <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Scan + verify</h2>
        <p class="mt-3 max-w-xl text-[13px] text-[var(--ink-mute)]">
          Scan the QR with your authenticator app, then enter the
          current 6-digit code to confirm setup.
        </p>
        <div class="mt-6 grid gap-6 sm:grid-cols-2">
          <div class="flex flex-col items-start gap-3">
            {#if qrDataUrl}
              <img
                src={qrDataUrl}
                alt="TOTP enrollment QR code"
                class="rounded-md border bg-white p-2"
                width="220"
                height="220"
              />
            {/if}
            {#if totpUri}
              <details class="w-full">
                <summary class="cursor-pointer text-[12px] text-[var(--ink-mute)] hover:text-[var(--ink)]">
                  Can't scan? Show the secret URI
                </summary>
                <p class="mt-2 break-all sl-mono text-[11.5px] text-[var(--ink)]">
                  {totpUri}
                </p>
              </details>
            {/if}
          </div>
          <form onsubmit={verifyEnroll} class="grid gap-4">
            <label class="block">
              <span class="sl-eyebrow" style="font-size:10.5px">6-digit code</span>
              <input
                type="text"
                inputmode="numeric"
                pattern="[0-9]{6}"
                autocomplete="one-time-code"
                bind:value={verifyCode}
                required
                minlength={6}
                maxlength={6}
                title="Enter the 6-digit code from your authenticator app"
                class="sl-input mt-2 sl-mono"
              />
            </label>
            {#if errorMsg}
              <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
                {errorMsg}
              </p>
            {/if}
            <div class="flex items-center gap-3">
              <button type="submit" disabled={busy} class="sl-btn sl-btn-primary">
                {busy ? "Verifying…" : "Verify + enable"}
              </button>
              <button
                type="button"
                onclick={() => {
                  step = "idle";
                  resetEnrollState();
                }}
                disabled={busy}
                class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
              >Cancel</button>
            </div>
          </form>
        </div>
      </section>
    {/if}

    {#if step === "done"}
      <section class="mt-12 border-t border-[var(--rule)] pt-10">
        <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Recovery codes</h2>
        <p class="mt-3 max-w-xl text-[13px] text-[var(--ink-mute)]">
          Save these somewhere safe — they're shown <strong>once</strong>.
          Each code works one time if you lose access to your
          authenticator app.
        </p>
        {#if flashMsg}
          <p class="mt-4 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">
            {flashMsg}
          </p>
        {/if}
        <div
          class="mt-4 grid max-w-md grid-cols-2 gap-2 rounded-md border bg-[var(--paper-soft)] p-4"
          role="group"
          aria-live="polite"
          aria-label="Recovery codes — save before leaving this page"
        >
          {#each backupCodes as code}
            <span class="sl-mono text-[13px] text-[var(--ink)]">{code}</span>
          {/each}
        </div>
        <div class="mt-4 flex items-center gap-3">
          <button type="button" onclick={copyAll} class="sl-btn">Copy all</button>
          <button
            type="button"
            onclick={() => {
              step = "idle";
              resetEnrollState();
            }}
            class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
          >I've saved them</button>
        </div>
      </section>
    {/if}
  {/if}
</div>
