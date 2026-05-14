<script lang="ts">
  import { PUBLIC_API_URL } from "$lib/env";
  import { isSuperAdmin, loadSession, session } from "$lib/session.svelte";

  const user = $derived(
    session.current.status === "authenticated" ? session.current.user : null,
  );
  const showSecurityLink = $derived(isSuperAdmin(session.current));

  // ─── Profile (display name) ────────────────────────────────────────────
  let name = $state("");
  let nameInitialised = false;
  // Seed the input from the session once it lands. Re-seeding on every
  // session change would clobber a user mid-typing, so we only do it the
  // first time we see a real user.
  $effect(() => {
    if (!nameInitialised && user) {
      name = user.name ?? "";
      nameInitialised = true;
    }
  });

  let savingProfile = $state(false);
  let profileError = $state<string | null>(null);
  let profileFlash = $state<string | null>(null);
  let profileFlashTimer: ReturnType<typeof setTimeout> | null = null;

  const profileDirty = $derived(nameInitialised && name.trim() !== (user?.name ?? "").trim());

  function flashProfile(msg: string) {
    profileFlash = msg;
    if (profileFlashTimer) clearTimeout(profileFlashTimer);
    profileFlashTimer = setTimeout(() => {
      profileFlash = null;
      profileFlashTimer = null;
    }, 4000);
  }

  async function saveProfile(e: SubmitEvent) {
    e.preventDefault();
    if (!profileDirty || savingProfile) return;
    profileError = null;
    savingProfile = true;
    try {
      // Better Auth: POST /api/auth/update-user accepts { name?, image? }.
      // It returns 200 with the updated user shape on success.
      const res = await fetch(`${PUBLIC_API_URL}/api/auth/update-user`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Update failed (${res.status}).`);
      }
      await loadSession({ force: true });
      flashProfile("Profile updated.");
    } catch (err) {
      profileError = err instanceof Error ? err.message : "Could not update profile.";
    } finally {
      savingProfile = false;
    }
  }

  function resetProfile() {
    name = user?.name ?? "";
    profileError = null;
  }

  // ─── Password ──────────────────────────────────────────────────────────
  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let revokeOtherSessions = $state(true);
  let savingPassword = $state(false);
  let passwordError = $state<string | null>(null);
  let passwordFlash = $state<string | null>(null);
  let passwordFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function flashPassword(msg: string) {
    passwordFlash = msg;
    if (passwordFlashTimer) clearTimeout(passwordFlashTimer);
    passwordFlashTimer = setTimeout(() => {
      passwordFlash = null;
      passwordFlashTimer = null;
    }, 4000);
  }

  // Surface client-side validation eagerly so the user doesn't round-trip
  // the server for trivially-bad input. Server still has the final word.
  const passwordIssue = $derived.by(() => {
    if (!currentPassword || !newPassword || !confirmPassword) return null;
    if (newPassword.length < 8) return "New password must be at least 8 characters.";
    if (newPassword !== confirmPassword) return "New passwords do not match.";
    if (newPassword === currentPassword) return "New password must differ from the current one.";
    return null;
  });
  const passwordReady = $derived(
    currentPassword.length > 0 &&
      newPassword.length > 0 &&
      confirmPassword.length > 0 &&
      passwordIssue === null,
  );

  async function changePassword(e: SubmitEvent) {
    e.preventDefault();
    if (!passwordReady || savingPassword) return;
    passwordError = null;
    savingPassword = true;
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/auth/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          revokeOtherSessions,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        // Better Auth uses 400/401 with `message` for incorrect-current-password etc.
        throw new Error(body?.message ?? `Password change failed (${res.status}).`);
      }
      currentPassword = "";
      newPassword = "";
      confirmPassword = "";
      flashPassword(
        revokeOtherSessions
          ? "Password updated. Other sessions were signed out."
          : "Password updated.",
      );
    } catch (err) {
      passwordError = err instanceof Error ? err.message : "Could not change password.";
    } finally {
      savingPassword = false;
    }
  }
</script>

<svelte:head>
  <title>Account · StewardLedger</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-6 pt-10 pb-16 sm:px-10 lg:px-12">
  <button
    type="button"
    onclick={() => (history.length > 1 ? history.back() : (location.href = "/"))}
    class="text-[12px] text-[var(--ink-mute)] hover:text-[var(--ink)] transition-colors"
  >← Back</button>
  <div class="sl-reveal mt-6">
    <p class="sl-eyebrow" style="font-size:10.5px">§ Account</p>
    <h1 class="sl-display mt-2 text-[40px] leading-[1.05] tracking-tight text-[var(--ink)]">
      Profile <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">&amp; password</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Manage the identity attached to your account.
    </p>

  <!-- ============ Profile ============ -->
  <section class="mt-12 border-t border-[var(--rule)] pt-10">
    <header class="flex items-baseline justify-between gap-4">
      <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Profile</h2>
      <span class="sl-eyebrow" style="font-size:10px">Identity</span>
    </header>

    <form class="mt-6 grid gap-6 sm:grid-cols-2" onsubmit={saveProfile}>
      <label class="block sm:col-span-1">
        <span class="sl-eyebrow" style="font-size:10.5px">Display name</span>
        <input
          type="text"
          name="name"
          autocomplete="name"
          maxlength={120}
          bind:value={name}
          disabled={savingProfile || !user}
          class="sl-input mt-2"
          placeholder="Your name"
        />
      </label>

      <label class="block sm:col-span-1">
        <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
        <input
          type="email"
          value={user?.email ?? ""}
          readonly
          class="sl-input mt-2"
          style="background:var(--paper-soft);color:var(--ink-mute);cursor:not-allowed"
          aria-describedby="email-help"
        />
        <span id="email-help" class="mt-1.5 block text-[11.5px] text-[var(--ink-faint)]">
          Email changes are coordinated by support to preserve audit continuity.
        </span>
      </label>

      {#if profileError}
        <p
          class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)] sm:col-span-2"
        >
          {profileError}
        </p>
      {/if}
      {#if profileFlash}
        <p
          class="border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)] sm:col-span-2"
        >
          {profileFlash}
        </p>
      {/if}

      <div class="flex items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={!profileDirty || savingProfile}
          class="sl-btn sl-btn-primary"
        >
          {savingProfile ? "Saving…" : "Save profile"}
        </button>
        {#if profileDirty}
          <button
            type="button"
            onclick={resetProfile}
            disabled={savingProfile}
            class="text-[13px] text-[var(--ink-mute)] hover:text-[var(--ink)] transition-colors"
          >
            Discard
          </button>
        {/if}
      </div>
    </form>
  </section>

  {#if showSecurityLink}
    <!-- ============ Security ============ -->
    <!--
      Surfaced only for super-admins in PR 1. Better Auth's two-factor
      after-hook only challenges /sign-in/email, so the OTP / magic-link
      paths still bypass MFA — not customer-ready. See tasks/totp-mfa.md.
    -->
    <section class="mt-14 border-t border-[var(--rule)] pt-10">
      <header class="flex items-baseline justify-between gap-4">
        <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Security</h2>
        <span class="sl-eyebrow" style="font-size:10px">Two-factor</span>
      </header>
      <p class="mt-3 max-w-xl text-[13px] leading-relaxed text-[var(--ink-mute)]">
        Bind a TOTP authenticator to your sign-in. Currently available
        to platform administrators only while we wire the remaining
        sign-in paths into the challenge flow.
      </p>
      <a
        href="/account/security"
        class="sl-btn mt-6 inline-flex"
      >Manage two-factor →</a>
    </section>
  {/if}

  <!-- ============ Password ============ -->
  <section class="mt-14 border-t border-[var(--rule)] pt-10">
    <header class="flex items-baseline justify-between gap-4">
      <h2 class="sl-display text-[22px] tracking-tight text-[var(--ink)]">Password</h2>
      <span class="sl-eyebrow" style="font-size:10px">Credentials</span>
    </header>
    <p class="mt-3 max-w-xl text-[13px] leading-relaxed text-[var(--ink-mute)]">
      Use at least 8 characters. Choosing to revoke other sessions will sign you out of every
      browser except this one.
    </p>

    <form class="mt-6 grid max-w-xl gap-5" onsubmit={changePassword}>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Current password</span>
        <input
          type="password"
          autocomplete="current-password"
          required
          bind:value={currentPassword}
          disabled={savingPassword}
          class="sl-input mt-2"
        />
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">New password</span>
        <input
          type="password"
          autocomplete="new-password"
          minlength={8}
          required
          bind:value={newPassword}
          disabled={savingPassword}
          class="sl-input mt-2"
        />
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Confirm new password</span>
        <input
          type="password"
          autocomplete="new-password"
          minlength={8}
          required
          bind:value={confirmPassword}
          disabled={savingPassword}
          class="sl-input mt-2"
        />
      </label>

      <label class="mt-1 flex items-start gap-3 text-[13px] text-[var(--ink-soft)]">
        <input
          type="checkbox"
          bind:checked={revokeOtherSessions}
          disabled={savingPassword}
          class="mt-[3px] h-3.5 w-3.5 accent-[var(--brass)]"
        />
        <span>
          Sign out other sessions
          <span class="block text-[11.5px] text-[var(--ink-mute)]">
            Recommended if you're rotating a possibly-compromised password.
          </span>
        </span>
      </label>

      {#if passwordIssue && currentPassword && newPassword && confirmPassword}
        <p class="border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-[13px] text-[var(--warn)]">
          {passwordIssue}
        </p>
      {/if}
      {#if passwordError}
        <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
          {passwordError}
        </p>
      {/if}
      {#if passwordFlash}
        <p class="border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">
          {passwordFlash}
        </p>
      {/if}

      <div>
        <button
          type="submit"
          disabled={!passwordReady || savingPassword}
          class="sl-btn sl-btn-primary"
        >
          {savingPassword ? "Updating…" : "Change password"}
        </button>
      </div>
    </form>
  </section>
  </div>
</div>
