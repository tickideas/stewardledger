<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { canManageMemberErasure } from "$lib/erasure/access";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Member = {
    id: string;
    referenceCode: string;
    firstName: string;
    middleNames: string | null;
    lastName: string | null;
    fullName: string | null;
    gender: string | null;
    email: string | null;
    mobile: string | null;
    telephone: string | null;
    chapterId: string | null;
    titleId: string | null;
    maritalStatusId: string | null;
    memberTypeId: string | null;
    isActive: boolean;
    isCell: boolean;
    isDepartment: boolean;
    dateOfBirth: string | null;
    dateJoinedMinistry: string | null;
    foundationSchoolGraduationDate: string | null;
    createdAt: string;
  };

  type ErasureRequest = {
    id: string;
    zoneId: string;
    scope: "member" | "zone";
    memberId: string | null;
    requestedByUserId: string | null;
    reason: string | null;
    status: "pending" | "applied" | "cancelled" | "failed";
    reversibilityWindowDays: number;
    appliesAt: string;
    appliedAt: string | null;
    cancelledAt: string | null;
    cancelledByUserId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  };

  type Chapter = { id: string; name: string };
  type Lookup = { id: string; name: string };

  type Address = {
    id: string;
    isPrimary: boolean;
    line1: string | null;
    line2: string | null;
    city: string | null;
    regionText: string | null;
    postcode: string | null;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
  };

  let memberId = $derived(page.params.id);

  let member = $state<Member | null>(null);
  let addresses = $state<Address[]>([]);
  let chapters = $state<Chapter[]>([]);
  let titles = $state<Lookup[]>([]);
  let maritalStatuses = $state<Lookup[]>([]);
  let memberTypes = $state<Lookup[]>([]);
  let loadError = $state<string | null>(null);

  // ─── Erasure (Phase 9 §6) ───────────────────────────────────────
  // Auth context drives the Privacy panel: gate the Request /
  // Cancel buttons off `canManageMemberErasure`, which mirrors
  // the server-side role gate (owner / admin / finance_admin).
  // A finance_admin can pull a member's data; a member-viewer
  // role cannot see the panel at all.
  let auth = $state<AuthorizedContext | null>(null);
  let erasureRequest = $state<ErasureRequest | null>(null);
  let erasureLoadError = $state<string | null>(null);
  // Action errors render in the panel under the row, separate
  // from `erasureLoadError` so a successful refresh doesn't blow
  // away an unread "create failed" message.
  let erasureActionError = $state<string | null>(null);
  const canEraseMember = $derived(canManageMemberErasure(auth));

  // Modal state.
  let modalOpen = $state(false);
  let modalReason = $state("");
  let modalWindowDays = $state<number>(14);
  let modalSubmitting = $state(false);
  // Cancel-confirm uses a small inline confirmer rather than a
  // separate modal: the panel already shows the schedule + the
  // applies_at clearly, so a click on Cancel goes through a
  // 2-step click-to-confirm in the same panel.
  let cancelConfirming = $state(false);
  let cancelSubmitting = $state(false);

  let saving = $state(false);
  let saveError = $state<string | null>(null);

  let addrForm = $state({
    line1: "",
    line2: "",
    city: "",
    regionText: "",
    postcode: "",
    countryCode: "",
    isPrimary: false,
  });
  let addrError = $state<string | null>(null);

  async function load() {
    try {
      const [m, a, ch, t, ms, mt] = await Promise.all([
        api.get<{ member: Member }>(`/api/tenant/members/${memberId}`),
        api.get<{ items: Address[] }>(`/api/tenant/members/${memberId}/addresses`),
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/titles"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/marital-statuses"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/member-types"),
      ]);
      member = m.member;
      addresses = a.items;
      chapters = ch.items;
      titles = t.items;
      maritalStatuses = ms.items;
      memberTypes = mt.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load member.";
    }
  }

  async function loadAuth(signal: AbortSignal) {
    try {
      const me = await api.get<{ auth: AuthorizedContext }>(
        "/api/tenant/me",
        signal,
      );
      auth = me.auth;
    } catch (err) {
      if (isAbortError(err)) return;
      // Soft-fail: a missing auth context just hides the Privacy
      // panel rather than blocking the rest of the page. The other
      // panels render off `member` regardless.
      auth = null;
    }
  }

  async function loadErasure(signal?: AbortSignal) {
    if (!canEraseMember || !memberId) return;
    try {
      // Tenant-scope list returns every erasure request for the
      // zone; filter client-side by member to find the at-most-one
      // open or recently-applied row. The list endpoint already
      // orders newest-first via the `(zone_id, status, created_at
      // DESC)` index.
      const res = await api.get<{ requests: ErasureRequest[] }>(
        "/api/tenant/erasure-requests?scope=member",
        signal,
      );
      erasureRequest =
        res.requests.find((r) => r.memberId === memberId) ?? null;
      erasureLoadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      erasureLoadError =
        err instanceof ApiError ? err.message : "Could not load erasure status.";
    }
  }

  $effect(() => {
    if (memberId) load();
  });

  $effect(() => {
    const controller = new AbortController();
    void loadAuth(controller.signal);
    return () => controller.abort();
  });

  // Re-fetch the erasure row once both auth and the member id are
  // known. `auth` resolution is independent of `memberId` so this
  // effect waits for both to settle.
  $effect(() => {
    if (!auth || !memberId) return;
    if (!canEraseMember) return;
    const controller = new AbortController();
    void loadErasure(controller.signal);
    return () => controller.abort();
  });

  function openErasureModal() {
    modalReason = "";
    modalWindowDays = 14;
    erasureActionError = null;
    modalOpen = true;
  }

  function closeErasureModal() {
    if (modalSubmitting) return;
    modalOpen = false;
  }

  async function submitErasure(e: SubmitEvent) {
    e.preventDefault();
    if (!memberId) return;
    modalSubmitting = true;
    erasureActionError = null;
    try {
      const body: { reason?: string; windowDays?: number } = {};
      if (modalReason.trim()) body.reason = modalReason.trim();
      // Only send windowDays when the operator changed it; the
      // server picks its own default (14, floored by the retention
      // policy) when omitted.
      if (modalWindowDays !== 14) body.windowDays = modalWindowDays;
      await api.post(
        `/api/tenant/members/${memberId}/erasure-requests`,
        body,
      );
      modalOpen = false;
      await loadErasure();
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate_pending") {
        erasureActionError =
          "This member already has a pending erasure request. Refresh the page to see it.";
      } else {
        erasureActionError =
          err instanceof ApiError
            ? err.message
            : "Could not schedule erasure.";
      }
    } finally {
      modalSubmitting = false;
    }
  }

  async function cancelErasure() {
    if (!erasureRequest) return;
    cancelSubmitting = true;
    erasureActionError = null;
    try {
      await api.delete(
        `/api/tenant/erasure-requests/${erasureRequest.id}`,
      );
      cancelConfirming = false;
      await loadErasure();
    } catch (err) {
      erasureActionError =
        err instanceof ApiError ? err.message : "Could not cancel erasure.";
    } finally {
      cancelSubmitting = false;
    }
  }

  function formatDateTime(iso: string | null): string {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  // True when the member's `first_name` literally equals 'erased'
  // — the canonical post-scrub marker the apply path writes. We
  // could also key off `metadata.erased_at`, but the field is the
  // visible signal so we render the banner off it directly.
  const isErased = $derived(
    !!member && member.firstName === "erased" && !member.lastName,
  );

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!member) return;
    saving = true;
    saveError = null;
    try {
      await api.patch(`/api/tenant/members/${member.id}`, {
        firstName: member.firstName,
        middleNames: member.middleNames || null,
        lastName: member.lastName || null,
        gender: member.gender || null,
        email: member.email || null,
        mobile: member.mobile || null,
        telephone: member.telephone || null,
        chapterId: member.chapterId || null,
        titleId: member.titleId || null,
        maritalStatusId: member.maritalStatusId || null,
        memberTypeId: member.memberTypeId || null,
        isActive: member.isActive,
        isCell: member.isCell,
        isDepartment: member.isDepartment,
        dateOfBirth: member.dateOfBirth || null,
        dateJoinedMinistry: member.dateJoinedMinistry || null,
        foundationSchoolGraduationDate: member.foundationSchoolGraduationDate || null,
      });
      await load();
    } catch (err) {
      saveError = err instanceof ApiError ? err.message : "Could not save.";
    } finally {
      saving = false;
    }
  }

  async function addAddress(e: SubmitEvent) {
    e.preventDefault();
    addrError = null;
    try {
      await api.post(`/api/tenant/members/${memberId}/addresses`, {
        line1: addrForm.line1 || undefined,
        line2: addrForm.line2 || undefined,
        city: addrForm.city || undefined,
        regionText: addrForm.regionText || undefined,
        postcode: addrForm.postcode || undefined,
        countryCode: addrForm.countryCode || undefined,
        isPrimary: addrForm.isPrimary,
      });
      addrForm = {
        line1: "",
        line2: "",
        city: "",
        regionText: "",
        postcode: "",
        countryCode: "",
        isPrimary: false,
      };
      await load();
    } catch (err) {
      addrError = err instanceof ApiError ? err.message : "Could not add address.";
    }
  }

  async function archiveAddress(addrId: string) {
    addrError = null;
    try {
      await api.delete(`/api/tenant/members/${memberId}/addresses/${addrId}`);
      await load();
    } catch (err) {
      addrError = err instanceof ApiError ? err.message : "Could not archive address.";
    }
  }

  async function softDelete() {
    if (!member) return;
    if (!confirm(`Soft-delete member ${member.fullName ?? member.firstName}?`)) return;
    try {
      await api.delete(`/api/tenant/members/${member.id}`);
      await goto("/zone/members");
    } catch (err) {
      saveError = err instanceof ApiError ? err.message : "Could not delete member.";
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && modalOpen) closeErasureModal();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head><title>Member · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if member}
    <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
      <div>
        <span class="sl-eyebrow">§ II · Identity record</span>
        <p class="mt-3 sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.08em">{member.referenceCode}</p>
        <h1 class="mt-1 sl-display text-[40px] leading-[1] text-[var(--ink)]">
          {#if isErased}
            Erased member <span class="sl-mono text-[16px] text-[var(--ink-mute)]">#{member.referenceCode}</span>
          {:else}
            {member.fullName ?? `${member.firstName} ${member.lastName ?? ""}`.trim()}
          {/if}
        </h1>
        <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
          {#if isErased}
            <span class="sl-badge sl-badge-bad">erased</span>
          {:else if member.isActive}
            <span class="sl-badge sl-badge-ok">active</span>
          {:else}
            <span class="sl-badge sl-badge-mute">inactive</span>
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <a href="/zone/members" class="sl-btn sl-btn-ghost">← Back to directory</a>
        {#if !isErased}
          <button type="button" class="sl-btn sl-btn-danger-ghost" onclick={softDelete}>
            Soft-delete
          </button>
        {/if}
      </div>
    </div>

    {#if isErased}
      <div class="sl-reveal sl-reveal-2 mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-4 py-3 text-[13px] text-[var(--bad)]">
        <strong>This member's personal data has been erased</strong> in
        response to a GDPR request. The contribution ledger entries
        are retained under the legitimate-interest legal basis for
        financial record-keeping; they appear as &ldquo;Erased member
        #{member.referenceCode}&rdquo; in totals and statements.
      </div>
    {/if}

    <form class="sl-reveal sl-reveal-2 sl-card-warm mt-8 grid grid-cols-12 gap-3 p-6" onsubmit={save}>
      <label class="col-span-12 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Title</span>
        <select bind:value={member.titleId} class="sl-select mt-1.5">
          <option value={null}>—</option>
          {#each titles as t}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">First name</span>
        <input type="text" required minlength="1" maxlength="120" bind:value={member.firstName} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Middle names</span>
        <input type="text" maxlength="200" bind:value={member.middleNames} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Last name</span>
        <input type="text" maxlength="120" bind:value={member.lastName} class="sl-input mt-1.5" />
      </label>

      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Gender</span>
        <select bind:value={member.gender} class="sl-select mt-1.5">
          <option value={null}>—</option>
          <option value="M">M</option>
          <option value="F">F</option>
          <option value="U">U</option>
        </select>
      </label>
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Date of birth</span>
        <input type="date" bind:value={member.dateOfBirth} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Marital status</span>
        <select bind:value={member.maritalStatusId} class="sl-select mt-1.5">
          <option value={null}>—</option>
          {#each maritalStatuses as ms}
            <option value={ms.id}>{ms.name}</option>
          {/each}
        </select>
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Member type</span>
        <select bind:value={member.memberTypeId} class="sl-select mt-1.5">
          <option value={null}>—</option>
          {#each memberTypes as mt}
            <option value={mt.id}>{mt.name}</option>
          {/each}
        </select>
      </label>

      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
        <input type="email" bind:value={member.email} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Mobile</span>
        <input type="text" maxlength="40" bind:value={member.mobile} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Telephone</span>
        <input type="text" maxlength="40" bind:value={member.telephone} class="sl-input mt-1.5" />
      </label>

      <label class="col-span-12 sm:col-span-6">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
        <select bind:value={member.chapterId} class="sl-select mt-1.5">
          <option value={null}>No chapter</option>
          {#each chapters as ch}
            <option value={ch.id}>{ch.name}</option>
          {/each}
        </select>
      </label>
      <div class="col-span-12 flex flex-wrap items-end gap-6 pb-1 text-[13px] text-[var(--ink-soft)] sm:col-span-6">
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" bind:checked={member.isActive} /> Active
        </label>
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" bind:checked={member.isCell} /> Cell
        </label>
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" bind:checked={member.isDepartment} /> Department
        </label>
      </div>

      {#if saveError}
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{saveError}</p>
      {/if}
      <div class="col-span-12">
        <button type="submit" disabled={saving} class="sl-btn sl-btn-primary">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>

    {#if canEraseMember && !isErased}
      <!-- ── Privacy panel ────────────────────────────────────── -->
      <!-- Phase 9 §6 — GDPR data-subject erasure surface. The panel
           appears only for the PII-management roles (owner / admin /
           finance_admin) and only on a member that hasn't already
           been erased. -->
      <section class="sl-reveal sl-reveal-3 mt-12">
        <div class="mb-3 flex items-end justify-between gap-4">
          <div>
            <span class="sl-eyebrow">Privacy &amp; data rights</span>
            <h2 class="sl-display mt-1 text-[20px] text-[var(--ink)]">
              GDPR erasure
            </h2>
          </div>
        </div>

        {#if erasureLoadError}
          <p class="mb-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
            {erasureLoadError}
          </p>
        {/if}

        <div class="sl-card-warm p-5">
          {#if erasureRequest && erasureRequest.status === "pending"}
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="text-[13px] text-[var(--ink)]">
                  An erasure request is scheduled for this member.
                </p>
                <dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
                  <div class="flex justify-between sm:block">
                    <dt class="text-[var(--ink-mute)]">Will apply on</dt>
                    <dd class="sl-mono mt-0.5 text-[var(--ink)]">
                      {formatDateTime(erasureRequest.appliesAt)}
                    </dd>
                  </div>
                  <div class="flex justify-between sm:block">
                    <dt class="text-[var(--ink-mute)]">Window</dt>
                    <dd class="sl-mono mt-0.5 text-[var(--ink)]">
                      {erasureRequest.reversibilityWindowDays} day{erasureRequest.reversibilityWindowDays === 1 ? "" : "s"}
                    </dd>
                  </div>
                  <div class="flex justify-between sm:block">
                    <dt class="text-[var(--ink-mute)]">Scheduled</dt>
                    <dd class="sl-mono mt-0.5 text-[var(--ink)]">
                      {formatDateTime(erasureRequest.createdAt)}
                    </dd>
                  </div>
                  {#if erasureRequest.reason}
                    <div class="col-span-1 sm:col-span-2">
                      <dt class="text-[var(--ink-mute)]">Reason</dt>
                      <dd class="mt-0.5 text-[var(--ink)]">{erasureRequest.reason}</dd>
                    </div>
                  {/if}
                </dl>
              </div>
              <div class="flex flex-col items-end gap-2">
                {#if !cancelConfirming}
                  <button
                    type="button"
                    class="sl-btn sl-btn-ghost"
                    onclick={() => (cancelConfirming = true)}
                  >
                    Cancel request
                  </button>
                {:else}
                  <p class="text-right text-[12px] text-[var(--ink-mute)]">
                    Cancel and keep this member's data?
                  </p>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="sl-btn sl-btn-ghost"
                      disabled={cancelSubmitting}
                      onclick={() => (cancelConfirming = false)}
                    >
                      Keep request
                    </button>
                    <button
                      type="button"
                      class="sl-btn sl-btn-primary"
                      disabled={cancelSubmitting}
                      onclick={cancelErasure}
                    >
                      {cancelSubmitting ? "Cancelling…" : "Cancel erasure"}
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <div class="flex flex-wrap items-center justify-between gap-3">
              <p class="max-w-2xl text-[13px] leading-relaxed text-[var(--ink-mute)]">
                Schedule a permanent PII scrub for this member. The request
                stays cancellable for a reversibility window (default 14 days,
                adjustable below); after the window the cron sweep runs the
                scrub and the contribution ledger entries remain under
                &ldquo;Erased member #{member.referenceCode}&rdquo;.
              </p>
              <button
                type="button"
                class="sl-btn sl-btn-danger-ghost"
                onclick={openErasureModal}
              >
                Request erasure
              </button>
            </div>
            {#if erasureRequest && erasureRequest.status !== "pending"}
              <p class="mt-3 text-[12px] text-[var(--ink-mute)]">
                Most recent request: <span class="sl-badge sl-badge-mute">{erasureRequest.status}</span>
                on {formatDateTime(erasureRequest.updatedAt)}.
                {#if erasureRequest.errorMessage}
                  <span class="text-[var(--bad)]">{erasureRequest.errorMessage}</span>
                {/if}
              </p>
            {/if}
          {/if}

          {#if erasureActionError}
            <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {erasureActionError}
            </p>
          {/if}
        </div>
      </section>
    {/if}

    <section class="sl-reveal sl-reveal-3 mt-12">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Addresses</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {addresses.length} on file
        </span>
      </div>
      <ul class="sl-card divide-y divide-[var(--rule)] overflow-hidden">
        {#each addresses as a}
          <li class="flex items-center justify-between gap-4 px-5 py-4">
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2 text-[14px] text-[var(--ink)]">
                <span>{a.line1 ?? "—"}</span>
                {#if a.isPrimary}
                  <span class="sl-badge sl-badge-accent">primary</span>
                {/if}
                {#if a.dateTo}
                  <span class="sl-badge sl-badge-mute">archived {a.dateTo}</span>
                {/if}
              </p>
              <p class="mt-1 text-[12px] text-[var(--ink-mute)]">
                {[a.line2, a.city, a.regionText, a.postcode, a.countryCode].filter(Boolean).join(", ")}
              </p>
            </div>
            {#if !a.dateTo}
              <button type="button" class="sl-btn sl-btn-danger-ghost" onclick={() => archiveAddress(a.id)}>
                Archive
              </button>
            {/if}
          </li>
        {/each}
        {#if addresses.length === 0}
          <li class="px-5 py-10 text-center text-[13px] text-[var(--ink-mute)]">No addresses on file.</li>
        {/if}
      </ul>

      <form class="sl-card-warm mt-4 grid grid-cols-12 gap-3 p-6" onsubmit={addAddress}>
        <label class="col-span-12 sm:col-span-4">
          <span class="sl-eyebrow" style="font-size:10.5px">Address line 1</span>
          <input type="text" bind:value={addrForm.line1} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-12 sm:col-span-4">
          <span class="sl-eyebrow" style="font-size:10.5px">Address line 2</span>
          <input type="text" bind:value={addrForm.line2} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-6 sm:col-span-2">
          <span class="sl-eyebrow" style="font-size:10.5px">City</span>
          <input type="text" bind:value={addrForm.city} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-6 sm:col-span-2">
          <span class="sl-eyebrow" style="font-size:10.5px">Postcode</span>
          <input type="text" bind:value={addrForm.postcode} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-6 sm:col-span-2">
          <span class="sl-eyebrow" style="font-size:10.5px">Country</span>
          <input type="text" maxlength="2" placeholder="GB" bind:value={addrForm.countryCode} class="sl-input mt-1.5 uppercase" />
        </label>
        <label class="col-span-6 flex items-end gap-2 pb-2 text-[12.5px] text-[var(--ink-soft)] sm:col-span-2">
          <input type="checkbox" bind:checked={addrForm.isPrimary} /> Primary
        </label>
        <div class="col-span-12 sm:col-span-8 flex items-end">
          <button type="submit" class="sl-btn sl-btn-primary w-full justify-center sm:w-auto">
            Add address
          </button>
        </div>
        {#if addrError}
          <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{addrError}</p>
        {/if}
      </form>
    </section>
  {/if}

  {#if modalOpen}
    <!-- ── Erasure modal ─────────────────────────────────────── -->
    <!-- Inline rather than `confirm()` so embedded contexts (mobile
         in-app browsers) get a consistent UX with the rest of the
         page. Click-outside + Escape close; Cancel + Submit
         disable while the request is in flight. -->
    <div
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style="background: rgba(21, 22, 26, 0.42);"
      role="presentation"
      onclick={(e) => { if (e.target === e.currentTarget) closeErasureModal(); }}
    >
      <div
        class="w-full max-w-lg border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="erasure-title"
      >
        <div class="border-b border-[var(--rule)] px-6 py-5">
          <span class="sl-eyebrow" style="color:var(--bad)">Destructive action</span>
          <h2 id="erasure-title" class="mt-2 sl-display text-[22px] leading-tight text-[var(--ink)]">
            Schedule erasure for this member
          </h2>
          <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
            After the reversibility window, the member's personal
            details (name, email, phone, date of birth, address) will
            be permanently scrubbed. The contribution ledger stays
            intact for financial record-keeping and appears as
            &ldquo;Erased member #{member?.referenceCode}&rdquo;.
          </p>
        </div>
        <form class="space-y-4 px-6 py-5" onsubmit={submitErasure}>
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">Reversibility window (days)</span>
            <div class="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                min="1"
                max="365"
                step="1"
                class="sl-input sl-mono w-32"
                bind:value={modalWindowDays}
                disabled={modalSubmitting}
              />
              <span class="text-[12px] text-[var(--ink-mute)]">
                Until then, the request can be cancelled. Default 14.
              </span>
            </div>
          </label>
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">Reason (optional)</span>
            <textarea
              class="sl-input mt-1.5"
              rows="3"
              maxlength="500"
              placeholder="Brief context for the audit log…"
              bind:value={modalReason}
              disabled={modalSubmitting}
            ></textarea>
          </label>

          {#if erasureActionError}
            <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {erasureActionError}
            </p>
          {/if}

          <div class="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onclick={closeErasureModal}
              disabled={modalSubmitting}
              class="sl-btn sl-btn-ghost"
            >
              Cancel
            </button>
            <button type="submit" disabled={modalSubmitting} class="sl-btn sl-btn-danger">
              {modalSubmitting ? "Scheduling…" : "Schedule erasure"}
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}
</div>
