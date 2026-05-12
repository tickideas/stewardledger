<script lang="ts">
  import { page } from "$app/state";
  import { api, ApiError } from "$lib/api";
  import { fmtMoney } from "$lib/format";

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
  let resendError = $state<string | null>(null);
  let flash = $state<string | null>(null);

  function openResend() {
    resendEmail = ownerInvite?.email ?? "";
    resendName = "";
    resendError = null;
    resendOpen = true;
  }

  function closeResend() {
    if (resendSubmitting) return;
    resendOpen = false;
  }

  function flashFor(ms: number, message: string) {
    flash = message;
    setTimeout(() => {
      flash = null;
    }, ms);
  }

  async function submitResend(e: SubmitEvent) {
    e.preventDefault();
    if (!data) return;
    resendError = null;
    resendSubmitting = true;
    try {
      await api.post(`/api/admin/zones/${data.zone.slug}/owner-invitations`, {
        email: resendEmail,
        ...(resendName.trim() ? { primaryContactName: resendName.trim() } : {}),
      });
      resendOpen = false;
      flashFor(6000, `New invitation sent to ${resendEmail}.`);
      await refresh();
    } catch (err) {
      resendError =
        err instanceof ApiError ? err.message : "Could not resend the invitation.";
    } finally {
      resendSubmitting = false;
    }
  }

  async function revoke(inv: OpenInvitation) {
    if (!data) return;
    const confirmed = confirm(
      `Revoke the open invitation for ${inv.email}? The current link will stop working.`,
    );
    if (!confirmed) return;
    try {
      await api.post(
        `/api/admin/zones/${data.zone.slug}/invitations/${inv.id}/revoke`,
        {},
      );
      flashFor(6000, `Invitation for ${inv.email} revoked.`);
      await refresh();
    } catch (err) {
      flashFor(
        8000,
        err instanceof ApiError ? err.message : "Could not revoke the invitation.",
      );
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && resendOpen) closeResend();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="py-8">
  <a href="/admin/zones" class="text-xs text-slate-500 hover:text-slate-900">&larr; All zones</a>

  {#if loadError}
    <p class="mt-6 text-sm text-red-600">{loadError}</p>
  {:else if !data}
    <p class="mt-6 text-sm text-slate-500">Loading…</p>
  {:else}
    {@const z = data.zone}
    <div class="mt-3 flex items-baseline justify-between gap-6">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{z.name}</h1>
        <p class="mt-1 text-sm text-slate-600">
          <code>{z.slug}</code> &middot; {z.countryCode} &middot; {z.defaultCurrencyCode} &middot;
          {z.defaultTimeZone}
        </p>
        {#if z.legalName}
          <p class="text-xs text-slate-500">Legal: {z.legalName}</p>
        {/if}
      </div>
      <div class="text-right">
        <div class="text-xs uppercase tracking-wide text-slate-500">Status</div>
        <div class="text-lg font-medium">{z.status.replace("_", " ")}</div>
      </div>
    </div>

    <dl class="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Chapters</dt>
        <dd class="mt-1 text-2xl font-semibold tabular-nums">{data.chapters.length}</dd>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Members</dt>
        <dd class="mt-1 text-2xl font-semibold tabular-nums">{data.totals.members}</dd>
        {#if data.totals.unassignedMembers > 0}
          <div class="text-xs text-slate-500">{data.totals.unassignedMembers} unassigned</div>
        {/if}
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Contributions (posted)</dt>
        <dd class="mt-1 text-2xl font-semibold tabular-nums">
          {fmtMoney(
            data.totals.postedContributionTotal,
            data.totals.postedContributionCurrency,
            2,
          )}
        </dd>
        <div class="text-xs text-slate-500">{data.totals.postedContributionCount} records</div>
        {#if data.totals.postedContributionSubtotals.length > 1}
          <ul class="mt-2 text-xs text-slate-600 space-y-0.5">
            {#each data.totals.postedContributionSubtotals as s (s.currencyCode)}
              {#if s.currencyCode !== data.totals.postedContributionCurrency}
                <li class="flex justify-between">
                  <span>{s.currencyCode}</span>
                  <span class="tabular-nums">{fmtMoney(s.total, s.currencyCode, 2)}</span>
                </li>
              {/if}
            {/each}
          </ul>
        {/if}
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <dt class="text-xs uppercase tracking-wide text-slate-500">Region</dt>
        <dd class="mt-1 text-sm font-medium">
          {#if z.regionName}
            {z.regionName}
          {:else if z.regionNameUnverified}
            <span class="text-amber-700">{z.regionNameUnverified}</span>
            <div class="text-xs text-amber-600">unverified</div>
          {:else}
            <span class="text-slate-400">—</span>
          {/if}
        </dd>
      </div>
    </dl>

    {#if flash}
      <p
        class="mt-6 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      >
        {flash}
      </p>
    {/if}

    {#if data.openInvitations.length > 0}
      <h2 class="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Pending invitations
      </h2>
      <p class="mt-1 text-xs text-slate-500">
        Open invitations that haven't been accepted or revoked yet.
      </p>
      <div class="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table class="w-full text-sm">
          <thead
            class="border-b bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"
          >
            <tr>
              <th class="py-3 px-4">Email</th>
              <th class="py-3 px-4">Role</th>
              <th class="py-3 px-4">Sent</th>
              <th class="py-3 px-4">Expires</th>
              <th class="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            {#each data.openInvitations as inv (inv.id)}
              <tr>
                <td class="py-3 px-4 font-medium">{inv.email}</td>
                <td class="py-3 px-4 font-mono text-xs text-slate-600">{inv.roleCode}</td>
                <td class="py-3 px-4 text-xs text-slate-500">
                  {new Date(inv.createdAt).toLocaleString()}
                </td>
                <td class="py-3 px-4 text-xs">
                  {#if inv.expired}
                    <span class="text-red-700">expired</span>
                  {:else}
                    <span class="text-slate-500"
                      >{new Date(inv.expiresAt).toLocaleString()}</span
                    >
                  {/if}
                </td>
                <td class="py-3 px-4 text-right">
                  <div class="inline-flex items-center gap-2">
                    {#if inv.roleCode === "zone_owner" && data.zone.status === "pending_setup"}
                      <button
                        type="button"
                        onclick={openResend}
                        class="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs hover:bg-slate-50"
                      >
                        Resend
                      </button>
                    {/if}
                    <button
                      type="button"
                      onclick={() => revoke(inv)}
                      class="rounded border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                    >
                      Revoke
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if data.zone.status === "pending_setup"}
      <h2 class="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Pending invitations
      </h2>
      <div
        class="mt-3 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
      >
        <span>
          This zone is awaiting owner setup but has no open invitation. The previous one may have
          been revoked or expired.
        </span>
        <button
          type="button"
          onclick={openResend}
          class="ml-4 rounded border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
        >
          Send owner invitation
        </button>
      </div>
    {/if}

    <h2 class="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">Chapters</h2>
    {#if data.chapters.length === 0}
      <p class="mt-3 text-sm text-slate-500">No chapters yet.</p>
    {:else}
      <div class="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b bg-slate-50">
            <tr>
              <th class="py-3 px-4">Reference</th>
              <th class="py-3 px-4">Name</th>
              <th class="py-3 px-4">Country</th>
              <th class="py-3 px-4 text-right">Members</th>
              <th class="py-3 px-4">Active since</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            {#each data.chapters as ch (ch.id)}
              <tr>
                <td class="py-3 px-4 text-slate-600 font-mono text-xs">{ch.referenceCode}</td>
                <td class="py-3 px-4 font-medium">{ch.name}</td>
                <td class="py-3 px-4 text-slate-600">{ch.countryCode ?? "—"}</td>
                <td class="py-3 px-4 text-right tabular-nums">{ch.memberCount}</td>
                <td class="py-3 px-4 text-xs text-slate-500">
                  {new Date(ch.dateFrom).toLocaleDateString()}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if resendOpen && data}
      <div
        class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8"
        role="presentation"
        onclick={(e) => {
          if (e.target === e.currentTarget) closeResend();
        }}
      >
        <div
          class="w-full max-w-md rounded-xl bg-white shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resend-title"
        >
          <div class="flex items-start justify-between border-b border-slate-200 px-6 py-4">
            <div>
              <h2 id="resend-title" class="text-lg font-semibold tracking-tight">
                Resend owner invitation
              </h2>
              <p class="mt-1 text-xs text-slate-500">
                Revokes the current owner invitation and emails a new one. Use this to correct
                a wrong email or replace a lost / expired link.
              </p>
            </div>
            <button
              type="button"
              onclick={closeResend}
              class="ml-4 text-slate-400 hover:text-slate-700"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <form class="space-y-4 px-6 py-5" onsubmit={submitResend}>
            <label class="block">
              <span class="text-sm font-medium text-slate-700">Primary contact email</span>
              <input
                type="email"
                required
                bind:value={resendEmail}
                class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label class="block">
              <span class="text-sm font-medium text-slate-700">
                Primary contact name <span class="text-slate-400">(optional)</span>
              </span>
              <input
                type="text"
                minlength="2"
                maxlength="120"
                bind:value={resendName}
                placeholder="For the email greeting line"
                class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            {#if resendError}
              <p class="text-sm text-red-600">{resendError}</p>
            {/if}
            <div class="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onclick={closeResend}
                disabled={resendSubmitting}
                class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={resendSubmitting}
                class="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {resendSubmitting ? "Sending…" : "Send new invitation"}
              </button>
            </div>
          </form>
        </div>
      </div>
    {/if}

    <h2 class="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">Metadata</h2>
    <dl class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Created</dt>
        <dd>{new Date(z.createdAt).toLocaleString()}</dd>
      </div>
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Activated</dt>
        <dd>{z.activatedAt ? new Date(z.activatedAt).toLocaleString() : "—"}</dd>
      </div>
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Fiscal year starts</dt>
        <dd>Month {z.fiscalYearStartMonth}</dd>
      </div>
      <div class="flex justify-between border-b border-slate-100 py-2">
        <dt class="text-slate-500">Ministry year starts</dt>
        <dd>Month {z.ministryYearStartMonth}</dd>
      </div>
    </dl>
  {/if}
</div>
