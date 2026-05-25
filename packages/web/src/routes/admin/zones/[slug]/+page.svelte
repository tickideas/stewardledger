<script lang="ts">
  import { page } from "$app/state";
  import { api, ApiError } from "$lib/api";
  import { fmtMoney } from "$lib/format";
  import { ALL_TENANT_ROLE_OPTIONS_BY_SCOPE } from "$lib/role-options";

  type ChapterRow = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
    memberCount: number;
  };

  type Subtotal = { currencyCode: string; total: string; count: number };

  type OpenInvitation = {
    id: string;
    email: string;
    roleCode: string;
    chapterId: string | null;
    expiresAt: string;
    createdAt: string;
    expired: boolean;
  };

  type ZoneDetail = {
    zone: {
      id: string;
      slug: string;
      name: string;
      legalName: string | null;
      status: string;
      countryCode: string;
      defaultCurrencyCode: string;
      defaultTimeZone: string;
      fiscalYearStartMonth: number;
      ministryYearStartMonth: number;
      regionId: string | null;
      regionName: string | null;
      regionNameUnverified: string | null;
      activatedAt: string | null;
      createdAt: string;
    };
    chapters: ChapterRow[];
    totals: {
      members: number;
      unassignedMembers: number;
      postedContributionTotal: string;
      postedContributionCurrency: string;
      postedContributionCount: number;
      postedContributionSubtotals: Subtotal[];
    };
    openInvitations: OpenInvitation[];
    mfa: {
      requiredRoleCodes: string[];
      enrolled: number;
      required: number;
    };
  };

  let data = $state<ZoneDetail | null>(null);
  let loadError = $state<string | null>(null);
  // Bumped on each slug change; protects against an older in-flight response
  // clobbering newer data if the user navigates quickly between zones.
  let fetchEpoch = 0;

  async function refresh() {
    const slug = page.params.slug;
    if (!slug) return;
    const epoch = ++fetchEpoch;
    try {
      const res = await api.get<ZoneDetail>(`/api/admin/zones/${slug}`);
      if (epoch !== fetchEpoch) return;
      data = res;
      loadError = null;
    } catch (err) {
      if (epoch !== fetchEpoch) return;
      loadError = err instanceof ApiError ? err.message : "Could not load zone.";
    }
  }

  $effect(() => {
    // Re-fetch when the slug changes. Reading page.params.slug here is what
    // subscribes this effect to slug changes.
    if (!page.params.slug) return;
    data = null;
    loadError = null;
    refresh();
  });

  // ─── Owner-invite resend / revoke ─────────────────────────────────

  // The owner invite is the only one we offer a *resend* affordance for;
  // team invitations belong to the tenant API and don't show up here yet.
  const ownerInvite = $derived(
    data?.openInvitations.find((inv) => inv.roleCode === "zone_owner") ?? null,
  );

  let resendOpen = $state(false);
  let resendEmail = $state("");
  let resendName = $state("");
  let resendSubmitting = $state(false);

  // Unified status banner: every action (resend success, resend warning,
  // revoke success, any failure) renders here so the user always looks in
  // the same place. `level` controls colour; `sticky` keeps errors visible
  // until the next action instead of auto-dismissing.
  type StatusLevel = "success" | "warning" | "error";
  let status = $state<{ level: StatusLevel; message: string } | null>(null);
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(level: StatusLevel, message: string, autoDismissMs?: number) {
    if (statusTimer) clearTimeout(statusTimer);
    status = { level, message };
    if (autoDismissMs) {
      statusTimer = setTimeout(() => {
        status = null;
        statusTimer = null;
      }, autoDismissMs);
    }
  }

  // Confirm dialog state for destructive actions. Inline rather than
  // `window.confirm` so admins on embedded contexts (e.g. mobile in-app
  // browsers) get a consistent UX with the rest of the page.
  let confirmingRevoke = $state<OpenInvitation | null>(null);
  let revokeSubmitting = $state(false);

  function openResend() {
    resendEmail = ownerInvite?.email ?? "";
    resendName = "";
    resendOpen = true;
  }

  function closeResend() {
    if (resendSubmitting) return;
    resendOpen = false;
  }

  async function submitResend(e: SubmitEvent) {
    e.preventDefault();
    if (!data) return;
    resendSubmitting = true;
    try {
      const res = await api.post<{ status: string; warning?: string }>(
        `/api/admin/zones/${data.zone.slug}/owner-invitations`,
        {
          email: resendEmail,
          ...(resendName.trim() ? { primaryContactName: resendName.trim() } : {}),
        },
      );
      resendOpen = false;
      if (res.warning === "email_send_failed") {
        // Token was created OK but the email never went out. Tell the admin
        // explicitly so they can retry instead of assuming the recipient got
        // it. No auto-dismiss — this needs a human-read.
        setStatus(
          "warning",
          `Invitation created for ${resendEmail}, but the email failed to send. Try sending the invitation again.`,
        );
      } else {
        setStatus("success", `New invitation sent to ${resendEmail}.`, 6000);
      }
      await refresh();
    } catch (err) {
      setStatus(
        "error",
        err instanceof ApiError ? err.message : "Could not resend the invitation.",
      );
    } finally {
      resendSubmitting = false;
    }
  }

  function requestRevoke(inv: OpenInvitation) {
    confirmingRevoke = inv;
  }

  function closeRevokeConfirm() {
    if (revokeSubmitting) return;
    confirmingRevoke = null;
  }

  async function confirmRevoke() {
    if (!data || !confirmingRevoke) return;
    const inv = confirmingRevoke;
    revokeSubmitting = true;
    try {
      await api.post(
        `/api/admin/zones/${data.zone.slug}/invitations/${inv.id}/revoke`,
        {},
      );
      confirmingRevoke = null;
      setStatus("success", `Invitation for ${inv.email} revoked.`, 6000);
      await refresh();
    } catch (err) {
      setStatus(
        "error",
        err instanceof ApiError ? err.message : "Could not revoke the invitation.",
      );
      confirmingRevoke = null;
    } finally {
      revokeSubmitting = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (resendOpen) closeResend();
    else if (confirmingRevoke) closeRevokeConfirm();
  }

  // ─── Two-factor enforcement ───────────────────────────────────────

  // Local working copy of the checkbox state. Reset on every `data`
  // refresh so a discarded edit doesn't survive a re-fetch.
  let mfaSelection = $state<Set<string>>(new Set());
  let mfaSaving = $state(false);

  $effect(() => {
    // Re-sync whenever the server snapshot changes (initial load,
    // post-save refresh, slug change).
    if (data) mfaSelection = new Set(data.mfa.requiredRoleCodes);
  });

  const mfaDirty = $derived.by(() => {
    if (!data) return false;
    const server = new Set(data.mfa.requiredRoleCodes);
    if (server.size !== mfaSelection.size) return true;
    for (const code of server) if (!mfaSelection.has(code)) return true;
    return false;
  });

  function toggleMfaCode(code: string, checked: boolean): void {
    const next = new Set(mfaSelection);
    if (checked) next.add(code);
    else next.delete(code);
    mfaSelection = next;
  }

  async function saveMfa(): Promise<void> {
    if (!data || !mfaDirty) return;
    mfaSaving = true;
    try {
      const res = await api.patch<{ codes: string[] }>(
        `/api/admin/zones/${data.zone.slug}/mfa-required-role-codes`,
        { codes: [...mfaSelection] },
      );
      setStatus(
        "success",
        res.codes.length === 0
          ? "Two-factor enforcement is off for this zone."
          : `Two-factor enforcement updated (${res.codes.length} role${res.codes.length === 1 ? "" : "s"}).`,
        6000,
      );
      await refresh();
    } catch (err) {
      setStatus(
        "error",
        err instanceof ApiError
          ? err.message
          : "Could not update two-factor enforcement.",
      );
    } finally {
      mfaSaving = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="pt-2 pb-10 lg:pt-0">
  <a href="/admin/zones" class="sl-btn sl-btn-ghost">&larr; All zones</a>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if !data}
    <p class="mt-6 text-[13px] text-[var(--ink-mute)]">Loading…</p>
  {:else}
    {@const z = data.zone}
    <div class="sl-reveal sl-reveal-1 mt-4 flex flex-wrap items-end justify-between gap-6">
      <div>
        <span class="sl-eyebrow">§ Section I · Tenant detail</span>
        <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">{z.name}</h1>
        <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
          <code class="sl-mono text-[12px] text-[var(--ink-soft)]">{z.slug}</code> &middot; {z.countryCode} &middot; {z.defaultCurrencyCode} &middot;
          {z.defaultTimeZone}
        </p>
        {#if z.legalName}
          <p class="mt-1 text-[11.5px] text-[var(--ink-mute)]">Legal: {z.legalName}</p>
        {/if}
      </div>
      <div class="text-right">
        <span class="sl-eyebrow">Status</span>
        <div class="mt-2">
          <span class={`sl-badge ${
            z.status === "active" ? "sl-badge-ok" :
            z.status === "pending_setup" ? "sl-badge-warn" :
            "sl-badge-mute"
          }`}>{z.status.replace("_", " ")}</span>
        </div>
      </div>
    </div>

    <dl class="sl-reveal sl-reveal-2 mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
      <div class="sl-card p-4">
        <dt class="sl-eyebrow" style="font-size:10px">Chapters</dt>
        <dd class="sl-num mt-1 sl-display text-[24px] text-[var(--ink)]">{data.chapters.length}</dd>
      </div>
      <div class="sl-card p-4">
        <dt class="sl-eyebrow" style="font-size:10px">Members</dt>
        <dd class="sl-num mt-1 sl-display text-[24px] text-[var(--ink)]">{data.totals.members}</dd>
        {#if data.totals.unassignedMembers > 0}
          <div class="text-[11px] text-[var(--ink-mute)]">{data.totals.unassignedMembers} unassigned</div>
        {/if}
      </div>
      <div class="sl-card p-4">
        <dt class="sl-eyebrow" style="font-size:10px">Contributions (posted)</dt>
        <dd class="sl-num mt-1 sl-display text-[22px] text-[var(--ink)]">
          {fmtMoney(data.totals.postedContributionTotal, data.totals.postedContributionCurrency, 2)}
        </dd>
        <div class="text-[11px] text-[var(--ink-mute)]">{data.totals.postedContributionCount} records</div>
        {#if data.totals.postedContributionSubtotals.length > 1}
          <ul class="mt-2 space-y-0.5 text-[11.5px] text-[var(--ink-soft)]">
            {#each data.totals.postedContributionSubtotals as s (s.currencyCode)}
              {#if s.currencyCode !== data.totals.postedContributionCurrency}
                <li class="flex justify-between">
                  <span class="sl-mono">{s.currencyCode}</span>
                  <span class="sl-num">{fmtMoney(s.total, s.currencyCode, 2)}</span>
                </li>
              {/if}
            {/each}
          </ul>
        {/if}
      </div>
      <div class="sl-card p-4">
        <dt class="sl-eyebrow" style="font-size:10px">Region</dt>
        <dd class="mt-1 text-[14px] text-[var(--ink)]">
          {#if z.regionName}
            {z.regionName}
          {:else if z.regionNameUnverified}
            <span style="color:var(--warn)">{z.regionNameUnverified}</span>
            <div class="text-[11px]" style="color:var(--warn)">unverified</div>
          {:else}
            <span class="text-[var(--ink-faint)]">—</span>
          {/if}
        </dd>
      </div>
    </dl>

    {#if status}
      <div
        class="mt-6 flex items-start justify-between gap-3 border-l-2 px-3 py-2 text-[13px] {status.level ===
        'success'
          ? 'border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]'
          : status.level === 'warning'
            ? 'border-[var(--warn)] bg-[var(--warn-soft)] text-[var(--warn)]'
            : 'border-[var(--bad)] bg-[var(--bad-soft)] text-[var(--bad)]'}"
        role={status.level === "error" ? "alert" : "status"}
      >
        <span>{status.message}</span>
        <button type="button" onclick={() => (status = null)} class="shrink-0 text-[12px] opacity-70 hover:opacity-100" aria-label="Dismiss">✕</button>
      </div>
    {/if}

    {#if data.openInvitations.length > 0}
      <div class="sl-reveal sl-reveal-3 mt-10">
        <div class="mb-3 flex items-center justify-between">
          <span class="sl-eyebrow">Pending invitations</span>
          <span class="text-[11.5px] text-[var(--ink-mute)]">Open invitations that haven't been accepted or revoked yet.</span>
        </div>
        <div class="sl-card overflow-hidden">
          <table class="sl-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Sent</th>
                <th>Expires</th>
                <th class="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each data.openInvitations as inv (inv.id)}
                <tr>
                  <td class="text-[var(--ink)]">{inv.email}</td>
                  <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{inv.roleCode}</td>
                  <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">{new Date(inv.createdAt).toLocaleString()}</td>
                  <td>
                    {#if inv.expired}
                      <span class="sl-badge sl-badge-bad">expired</span>
                    {:else}
                      <span class="sl-mono text-[11.5px] text-[var(--ink-mute)]">{new Date(inv.expiresAt).toLocaleString()}</span>
                    {/if}
                  </td>
                  <td class="text-right">
                    <div class="inline-flex items-center gap-2">
                      {#if inv.roleCode === "zone_owner" && data.zone.status === "pending_setup"}
                        <button type="button" onclick={openResend} class="sl-btn sl-btn-ghost">Resend</button>
                      {/if}
                      <button type="button" onclick={() => requestRevoke(inv)} class="sl-btn sl-btn-danger-ghost">Revoke</button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {:else if data.zone.status === "pending_setup"}
      <div class="sl-reveal sl-reveal-3 mt-10">
        <span class="sl-eyebrow">Pending invitations</span>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-4 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-[13px] text-[var(--warn)]">
          <span>
            This zone is awaiting owner setup but has no open invitation. The previous one may have been revoked or expired.
          </span>
          <button type="button" onclick={openResend} class="sl-btn sl-btn-warn-ghost">
            Send owner invitation
          </button>
        </div>
      </div>
    {/if}

    <div class="sl-reveal sl-reveal-4 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Chapters</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {data.chapters.length} {data.chapters.length === 1 ? "row" : "rows"}
        </span>
      </div>
      {#if data.chapters.length === 0}
        <div class="sl-card p-10 text-center text-[13px] text-[var(--ink-mute)]">No chapters yet.</div>
      {:else}
        <div class="sl-card overflow-hidden">
          <table class="sl-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Name</th>
                <th>Country</th>
                <th class="!text-right">Members</th>
                <th>Active since</th>
              </tr>
            </thead>
            <tbody>
              {#each data.chapters as ch (ch.id)}
                <tr>
                  <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{ch.referenceCode}</td>
                  <td class="text-[var(--ink)]">{ch.name}</td>
                  <td class="text-[var(--ink-soft)]">{ch.countryCode ?? "—"}</td>
                  <td class="sl-num text-right text-[var(--ink)]">{ch.memberCount}</td>
                  <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">{new Date(ch.dateFrom).toLocaleDateString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    {#if resendOpen && data}
      <div
        class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
        style="background: rgba(21, 22, 26, 0.42);"
        role="presentation"
        onclick={(e) => { if (e.target === e.currentTarget) closeResend(); }}
      >
        <div class="w-full max-w-md border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]" role="dialog" aria-modal="true" aria-labelledby="resend-title">
          <div class="flex items-start justify-between border-b border-[var(--rule)] px-6 py-5">
            <div>
              <span class="sl-eyebrow">Resend invitation</span>
              <h2 id="resend-title" class="mt-2 sl-display text-[22px] leading-tight text-[var(--ink)]">
                Resend owner invitation
              </h2>
              <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">
                Revokes the current owner invitation and emails a new one. Use this to correct a wrong email or replace a lost / expired link.
              </p>
            </div>
            <button type="button" onclick={closeResend} class="ml-4 text-[var(--ink-faint)] hover:text-[var(--ink)]" aria-label="Close">✕</button>
          </div>
          <form class="space-y-4 px-6 py-5" onsubmit={submitResend}>
            <label class="block">
              <span class="sl-eyebrow" style="font-size:10.5px">Primary contact email</span>
              <input type="email" required bind:value={resendEmail} class="sl-input mt-1.5" />
            </label>
            <label class="block">
              <span class="sl-eyebrow" style="font-size:10.5px">Primary contact name (optional)</span>
              <input type="text" minlength="2" maxlength="120" bind:value={resendName} placeholder="For the email greeting line" class="sl-input mt-1.5" />
            </label>
            <div class="flex items-center justify-end gap-3 pt-2">
              <button type="button" onclick={closeResend} disabled={resendSubmitting} class="sl-btn sl-btn-ghost">
                Cancel
              </button>
              <button type="submit" disabled={resendSubmitting} class="sl-btn sl-btn-primary">
                {resendSubmitting ? "Sending…" : "Send new invitation"}
              </button>
            </div>
          </form>
        </div>
      </div>
    {/if}

    {#if confirmingRevoke}
      <div
        class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
        style="background: rgba(21, 22, 26, 0.42);"
        role="presentation"
        onclick={(e) => { if (e.target === e.currentTarget) closeRevokeConfirm(); }}
      >
        <div class="w-full max-w-md border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]" role="alertdialog" aria-modal="true" aria-labelledby="revoke-title">
          <div class="border-b border-[var(--rule)] px-6 py-5">
            <span class="sl-eyebrow" style="color:var(--bad)">Destructive action</span>
            <h2 id="revoke-title" class="mt-2 sl-display text-[22px] leading-tight text-[var(--ink)]">Revoke this invitation?</h2>
            <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
              The link sent to <strong class="text-[var(--ink)]">{confirmingRevoke.email}</strong> will stop working immediately. This can't be undone.
            </p>
          </div>
          <div class="flex items-center justify-end gap-3 px-6 py-4">
            <button type="button" onclick={closeRevokeConfirm} disabled={revokeSubmitting} class="sl-btn sl-btn-ghost">
              Cancel
            </button>
            <button type="button" onclick={confirmRevoke} disabled={revokeSubmitting} class="sl-btn sl-btn-danger">
              {revokeSubmitting ? "Revoking…" : "Revoke"}
            </button>
          </div>
        </div>
      </div>
    {/if}

    <div class="sl-reveal sl-reveal-5 mt-10">
      <div class="mb-3 flex items-baseline justify-between">
        <span class="sl-eyebrow">Two-factor enforcement</span>
        <span class="sl-mono text-[11px] text-[var(--ink-mute)]">
          {data.mfa.enrolled} / {data.mfa.required} enrolled
        </span>
      </div>
      <div class="sl-card p-5">
        <p class="text-[12.5px] text-[var(--ink-mute)]">
          Users holding any of these roles in this zone must enrol in
          TOTP before they can use the application. Removing a role from
          this list doesn’t disable MFA for users who already have it
          — it only stops forcing new ones.
        </p>
        <div class="mt-4 grid gap-5 sm:grid-cols-3">
          {#each ALL_TENANT_ROLE_OPTIONS_BY_SCOPE as group (group.scope)}
            <fieldset class="space-y-2">
              <legend class="sl-eyebrow" style="font-size:10.5px">
                {group.label}
              </legend>
              {#each group.options as opt (opt.value)}
                <label class="flex items-center gap-2 text-[13px] text-[var(--ink)]">
                  <input
                    type="checkbox"
                    checked={mfaSelection.has(opt.value)}
                    onchange={(e) =>
                      toggleMfaCode(
                        opt.value,
                        (e.currentTarget as HTMLInputElement).checked,
                      )}
                  />
                  <span>{opt.label}</span>
                  <code class="sl-mono text-[11px] text-[var(--ink-faint)]">{opt.value}</code>
                </label>
              {/each}
            </fieldset>
          {/each}
        </div>
        <div class="mt-5 flex items-center justify-end gap-3 border-t border-[var(--rule)] pt-4">
          <button
            type="button"
            class="sl-btn sl-btn-primary"
            disabled={!mfaDirty || mfaSaving}
            onclick={saveMfa}
          >
            {mfaSaving ? "Saving…" : mfaDirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>
    </div>

    <div class="sl-reveal sl-reveal-5 mt-10">
      <span class="sl-eyebrow">Metadata</span>
      <dl class="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
        <div class="flex justify-between border-b border-[var(--rule)] py-2">
          <dt class="text-[var(--ink-mute)]">Created</dt>
          <dd class="sl-mono text-[12px] text-[var(--ink-soft)]">{new Date(z.createdAt).toLocaleString()}</dd>
        </div>
        <div class="flex justify-between border-b border-[var(--rule)] py-2">
          <dt class="text-[var(--ink-mute)]">Activated</dt>
          <dd class="sl-mono text-[12px] text-[var(--ink-soft)]">{z.activatedAt ? new Date(z.activatedAt).toLocaleString() : "—"}</dd>
        </div>
        <div class="flex justify-between border-b border-[var(--rule)] py-2">
          <dt class="text-[var(--ink-mute)]">Fiscal year starts</dt>
          <dd class="text-[var(--ink-soft)]">Month {z.fiscalYearStartMonth}</dd>
        </div>
        <div class="flex justify-between border-b border-[var(--rule)] py-2">
          <dt class="text-[var(--ink-mute)]">Ministry year starts</dt>
          <dd class="text-[var(--ink-soft)]">Month {z.ministryYearStartMonth}</dd>
        </div>
      </dl>
    </div>
  {/if}
</div>
