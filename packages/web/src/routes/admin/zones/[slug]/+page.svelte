<script lang="ts">
  import { page } from "$app/state";
  import { api, ApiError } from "$lib/api";
  import { fmtMoney } from "$lib/format";
  import { ALL_TENANT_ROLE_OPTIONS_BY_SCOPE } from "$lib/role-options";
  import { session } from "$lib/session.svelte";

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
    else if (decomModalOpen) closeDecomModal();
  }

  // ─── Two-factor enforcement ───────────────────────────────────────

  // The set of codes the UI knows how to render. Anything in the
  // server snapshot outside this set is a legacy entry from the
  // SQL-only era and gets surfaced separately so the operator can
  // see what they're about to remove.
  const KNOWN_MFA_CODES = new Set(
    ALL_TENANT_ROLE_OPTIONS_BY_SCOPE.flatMap((g) => g.options.map((o) => o.value)),
  );

  // Local working copy of the checkbox state. Reset on every `data`
  // refresh so a discarded edit doesn't survive a re-fetch.
  let mfaSelection = $state<Set<string>>(new Set());
  let mfaSaving = $state(false);

  $effect(() => {
    // Re-sync whenever the server snapshot changes (initial load,
    // post-save refresh, slug change). Filter to KNOWN codes so a
    // legacy entry (e.g. left over from SQL editing) is removed on
    // the next save instead of round-tripping back as `invalid_role`.
    if (data) {
      mfaSelection = new Set(
        data.mfa.requiredRoleCodes.filter((c) => KNOWN_MFA_CODES.has(c)),
      );
    }
  });

  // Codes on the server that this UI doesn't recognise. Rendered as
  // a warning so the operator knows the next save will drop them.
  const mfaUnknownCodes = $derived(
    data
      ? data.mfa.requiredRoleCodes.filter((c) => !KNOWN_MFA_CODES.has(c))
      : [],
  );

  const mfaDirty = $derived.by(() => {
    if (!data) return false;
    // Compare against the SANITISED server snapshot — if the only
    // difference is unknown legacy codes, that's a dirty state
    // (saving will clean them up).
    const serverKnown = data.mfa.requiredRoleCodes.filter((c) =>
      KNOWN_MFA_CODES.has(c),
    );
    if (mfaUnknownCodes.length > 0) return true;
    if (serverKnown.length !== mfaSelection.size) return true;
    for (const code of serverKnown) if (!mfaSelection.has(code)) return true;
    return false;
  });

  function toggleMfaCode(code: string, checked: boolean): void {
    const next = new Set(mfaSelection);
    if (checked) next.add(code);
    else next.delete(code);
    mfaSelection = next;
  }

  // ─── Decommission panel (Phase 9 §6) ──────────────────────────────
  // Super-admin parallel of the owner-driven flow on /zone/settings.
  // Same body shape, same recent-export gate (the server enforces),
  // same reversibility window. Mounted on the admin tenant-detail
  // page so an admin acting on behalf of an owner who has lost
  // access (abandoned tenant, disputed handover) has the same handle
  // the owner would have had.
  //
  // Visible to super-admins only — the admin layout admits
  // `support_admin` too, but support cannot decommission. The
  // server enforces this separately via `requireSuperAdmin`; the
  // UI predicate stops support admins seeing a button they can't use.
  type AdminErasureRequest = {
    id: string;
    scope: "member" | "zone";
    status: "pending" | "applied" | "cancelled" | "failed";
    reason: string | null;
    reversibilityWindowDays: number;
    appliesAt: string;
    createdAt: string;
    updatedAt: string;
    errorCode: string | null;
    errorMessage: string | null;
  };

  const isSuperAdmin = $derived(
    session.current.status === "authenticated" &&
      session.current.isSuperAdmin,
  );

  let zoneErasure = $state<AdminErasureRequest | null>(null);
  let zoneErasureLoadError = $state<string | null>(null);
  let zoneErasureActionError = $state<string | null>(null);

  let decomModalOpen = $state(false);
  let decomSlugInput = $state("");
  let decomReason = $state("");
  let decomConfirmExportId = $state("");
  let decomSubmitting = $state(false);
  let decomCancelConfirming = $state(false);
  let decomCancelSubmitting = $state(false);

  const decomSlugMatches = $derived.by(() => {
    if (!data) return false;
    return (
      decomSlugInput.trim().toLowerCase() ===
        data.zone.slug.toLowerCase() && data.zone.slug.length > 0
    );
  });

  async function loadZoneErasure() {
    if (!isSuperAdmin || !data) return;
    try {
      const res = await api.get<{ requests: AdminErasureRequest[] }>(
        `/api/admin/zones/${data.zone.slug}/erasure-requests`,
      );
      zoneErasure = res.requests[0] ?? null;
      zoneErasureLoadError = null;
    } catch (err) {
      zoneErasureLoadError =
        err instanceof ApiError
          ? err.message
          : "Could not load decommission status.";
    }
  }

  // Re-load when `data` becomes available (after `refresh()` lands)
  // OR when the slug changes (admin nav between tenants).
  $effect(() => {
    if (data?.zone.slug && isSuperAdmin) {
      void loadZoneErasure();
    } else {
      zoneErasure = null;
      zoneErasureLoadError = null;
    }
  });

  function openDecomModal() {
    decomSlugInput = "";
    decomReason = "";
    decomConfirmExportId = "";
    zoneErasureActionError = null;
    decomModalOpen = true;
  }

  function closeDecomModal() {
    if (decomSubmitting) return;
    decomModalOpen = false;
  }

  async function submitDecom(e: SubmitEvent) {
    e.preventDefault();
    if (!data || !decomSlugMatches) return;
    if (!decomConfirmExportId.trim()) {
      zoneErasureActionError = "Export bundle ID is required.";
      return;
    }
    decomSubmitting = true;
    zoneErasureActionError = null;
    try {
      const body: { confirmExportId: string; reason?: string } = {
        confirmExportId: decomConfirmExportId.trim(),
      };
      if (decomReason.trim()) body.reason = decomReason.trim();
      await api.post(
        `/api/admin/zones/${data.zone.slug}/erasure-requests`,
        body,
      );
      decomModalOpen = false;
      setStatus(
        "success",
        `Decommission scheduled for ${data.zone.slug}.`,
        6000,
      );
      await loadZoneErasure();
    } catch (err) {
      if (err instanceof ApiError && err.code === "recent_export_required") {
        zoneErasureActionError =
          "That export bundle ID is either invalid or older than 7 days. The owner must generate a fresh export first.";
      } else if (err instanceof ApiError && err.code === "duplicate_pending") {
        zoneErasureActionError =
          "A decommission is already pending for this zone. Refresh to see it.";
      } else {
        zoneErasureActionError =
          err instanceof ApiError
            ? err.message
            : "Could not schedule decommission.";
      }
    } finally {
      decomSubmitting = false;
    }
  }

  async function cancelDecom() {
    if (!data || !zoneErasure) return;
    decomCancelSubmitting = true;
    zoneErasureActionError = null;
    try {
      await api.delete(
        `/api/admin/zones/${data.zone.slug}/erasure-requests/${zoneErasure.id}`,
      );
      decomCancelConfirming = false;
      setStatus(
        "success",
        `Decommission cancelled for ${data.zone.slug}.`,
        6000,
      );
      await loadZoneErasure();
    } catch (err) {
      zoneErasureActionError =
        err instanceof ApiError
          ? err.message
          : "Could not cancel decommission.";
    } finally {
      decomCancelSubmitting = false;
    }
  }

  function formatDateTimeDecom(iso: string | null): string {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async function saveMfa(): Promise<void> {
    if (!data || !mfaDirty) return;
    mfaSaving = true;
    try {
      // Send only known codes. Anything else is either a typo or a
      // legacy entry from SQL-only editing; the service would 422
      // on them. Sanitising client-side lets the save succeed and
      // cleans up the legacy entry as a side-effect.
      const known = [...mfaSelection].filter((c) => KNOWN_MFA_CODES.has(c));
      const res = await api.patch<{ codes: string[] }>(
        `/api/admin/zones/${data.zone.slug}/mfa-required-role-codes`,
        { codes: known },
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
        {#if mfaUnknownCodes.length > 0}
          <div class="mt-3 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-[12.5px] text-[var(--warn)]">
            <strong>Unknown role codes on this zone:</strong>
            {#each mfaUnknownCodes as code, i (code)}
              <code class="sl-mono text-[11.5px]">{code}</code>{i < mfaUnknownCodes.length - 1 ? ", " : ""}
            {/each}
            . Saving will remove them (likely left over from SQL editing
            before this UI existed).
          </div>
        {/if}
        <div class="mt-4 grid gap-5 sm:grid-cols-3">
          {#each ALL_TENANT_ROLE_OPTIONS_BY_SCOPE as group (group.scope)}
            <fieldset class="space-y-2" disabled={mfaSaving}>
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
            {mfaSaving ? "Saving…" : mfaDirty ? "Save changes" : "No changes"}
          </button>
        </div>
      </div>
    </div>

    {#if isSuperAdmin}
      <!-- ── Decommission panel (super-admin parallel) ────────────────── -->
      <!-- Mirrors `/zone/settings`'s owner-driven flow. Visible only
           to super-admins; support admins land here through the
           admin layout but the section stays hidden. The server
           enforces super-admin separately. -->
      <section class="sl-reveal sl-reveal-5 mt-10">
        <div class="flex items-end justify-between gap-4">
          <div>
            <span class="sl-eyebrow" style="color:var(--bad)">Danger zone</span>
            <h2 class="sl-display mt-1 text-[22px] text-[var(--ink)]">
              Decommission this zone
            </h2>
            <p class="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--ink-mute)]">
              Schedule a permanent purge of every record, file, and report
              owned by this zone. Use when the owner has lost access and
              has explicitly requested closure. Requires the ID of a
              completed export bundle the owner generated in the last
              7 days.
            </p>
          </div>
        </div>

        {#if zoneErasureLoadError}
          <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
            {zoneErasureLoadError}
          </p>
        {/if}

        <div class="mt-4 border-2 border-[var(--bad)] bg-[var(--bad-soft)] p-5">
          {#if zoneErasure && zoneErasure.status === "pending"}
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="text-[13px] text-[var(--bad)]">
                  <strong>Decommission is scheduled.</strong>
                  Every record in this zone will be permanently deleted
                  unless cancelled before the window closes.
                </p>
                <dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
                  <div class="flex justify-between sm:block">
                    <dt class="text-[var(--ink-mute)]">Applies on</dt>
                    <dd class="sl-mono mt-0.5 text-[var(--ink)]">
                      {formatDateTimeDecom(zoneErasure.appliesAt)}
                    </dd>
                  </div>
                  <div class="flex justify-between sm:block">
                    <dt class="text-[var(--ink-mute)]">Window</dt>
                    <dd class="sl-mono mt-0.5 text-[var(--ink)]">
                      {zoneErasure.reversibilityWindowDays} days
                    </dd>
                  </div>
                  <div class="flex justify-between sm:block">
                    <dt class="text-[var(--ink-mute)]">Scheduled</dt>
                    <dd class="sl-mono mt-0.5 text-[var(--ink)]">
                      {formatDateTimeDecom(zoneErasure.createdAt)}
                    </dd>
                  </div>
                  {#if zoneErasure.reason}
                    <div class="col-span-1 sm:col-span-2">
                      <dt class="text-[var(--ink-mute)]">Reason</dt>
                      <dd class="mt-0.5 text-[var(--ink)]">{zoneErasure.reason}</dd>
                    </div>
                  {/if}
                </dl>
              </div>
              <div class="flex flex-col items-end gap-2">
                {#if !decomCancelConfirming}
                  <button
                    type="button"
                    class="sl-btn sl-btn-primary"
                    onclick={() => (decomCancelConfirming = true)}
                  >
                    Cancel decommission
                  </button>
                {:else}
                  <p class="text-right text-[12px] text-[var(--ink-mute)]">
                    Cancel decommission and keep this zone?
                  </p>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="sl-btn sl-btn-ghost"
                      disabled={decomCancelSubmitting}
                      onclick={() => (decomCancelConfirming = false)}
                    >
                      Keep scheduled
                    </button>
                    <button
                      type="button"
                      class="sl-btn sl-btn-primary"
                      disabled={decomCancelSubmitting}
                      onclick={cancelDecom}
                    >
                      {decomCancelSubmitting ? "Cancelling…" : "Cancel decommission"}
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                {#if zoneErasure && zoneErasure.status !== "pending"}
                  <p class="text-[12px] text-[var(--ink-mute)]">
                    Last decommission attempt:
                    <span class="sl-badge sl-badge-mute">{zoneErasure.status}</span>
                    on {formatDateTimeDecom(zoneErasure.updatedAt)}.
                    {#if zoneErasure.errorMessage}
                      <span class="text-[var(--bad)]">{zoneErasure.errorMessage}</span>
                    {/if}
                  </p>
                {:else}
                  <p class="text-[13px] text-[var(--ink-soft)]">
                    No decommission scheduled.
                  </p>
                {/if}
              </div>
              <button
                type="button"
                class="sl-btn sl-btn-danger"
                onclick={openDecomModal}
              >
                Decommission zone…
              </button>
            </div>
          {/if}

          {#if zoneErasureActionError}
            <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {zoneErasureActionError}
            </p>
          {/if}
        </div>
      </section>

      {#if decomModalOpen}
        <!-- ── Admin decommission confirm modal ───────────────────── -->
        <!-- Differs from the owner-side modal in that the admin must
             paste the export bundle ID by hand (the admin doesn't see
             the tenant's bundle list on this surface), in addition to
             typing the zone slug. -->
        <div
          class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
          style="background: rgba(21, 22, 26, 0.42);"
          role="presentation"
          onclick={(e) => { if (e.target === e.currentTarget) closeDecomModal(); }}
        >
          <div
            class="w-full max-w-lg border-2 border-[var(--bad)] bg-[var(--card)] shadow-[var(--shadow-lift)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-decom-title"
          >
            <div class="border-b border-[var(--rule)] px-6 py-5">
              <span class="sl-eyebrow" style="color:var(--bad)">Irreversible after the window</span>
              <h2 id="admin-decom-title" class="mt-2 sl-display text-[22px] leading-tight text-[var(--ink)]">
                Decommission this zone
              </h2>
              <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
                Confirms a permanent purge for this zone after the
                reversibility window (14 days). The owner's export
                bundle ID is required — paste it from the owner's
                request or from the tenant's `zone_exports` row.
              </p>
            </div>
            <form class="space-y-4 px-6 py-5" onsubmit={submitDecom}>
              <label class="block">
                <span class="sl-eyebrow" style="font-size:10.5px">Recent export bundle ID</span>
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="e.g. 9f3a1c2b-…"
                  class="sl-input sl-mono mt-1.5"
                  bind:value={decomConfirmExportId}
                  disabled={decomSubmitting}
                />
                <p class="mt-1 text-[11.5px] text-[var(--ink-mute)]">
                  Must reference a completed `zone_exports` row created in
                  the last 7 days, owned by this zone.
                </p>
              </label>
              <label class="block">
                <span class="sl-eyebrow" style="font-size:10.5px">
                  Type <code class="sl-mono text-[12px] text-[var(--ink)]">{data.zone.slug}</code> to confirm
                </span>
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  class="sl-input sl-mono mt-1.5"
                  bind:value={decomSlugInput}
                  disabled={decomSubmitting}
                />
              </label>
              <label class="block">
                <span class="sl-eyebrow" style="font-size:10.5px">Reason (optional)</span>
                <textarea
                  class="sl-input mt-1.5"
                  rows="3"
                  maxlength="500"
                  placeholder="For the platform-scope audit log…"
                  bind:value={decomReason}
                  disabled={decomSubmitting}
                ></textarea>
              </label>

              {#if zoneErasureActionError}
                <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
                  {zoneErasureActionError}
                </p>
              {/if}

              <div class="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onclick={closeDecomModal}
                  disabled={decomSubmitting}
                  class="sl-btn sl-btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!decomSlugMatches || !decomConfirmExportId.trim() || decomSubmitting}
                  class="sl-btn sl-btn-danger"
                >
                  {decomSubmitting ? "Scheduling…" : "Schedule decommission"}
                </button>
              </div>
            </form>
          </div>
        </div>
      {/if}
    {/if}

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
