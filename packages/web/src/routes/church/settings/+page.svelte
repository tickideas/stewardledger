<script lang="ts">
  // Chapter settings. Three editable blocks:
  //   1. Banking references + primary currency (stored in chapters.metadata).
  //   2. Roster of users with chapter-scope bindings (read + revoke).
  //   3. Invite a new user into a chapter-scope role.
  //
  // Edit gates are mirrored on the server. The client suppresses the UI
  // affordances when the active session can't write so chapter-only
  // treasurers see a read-only page that still surfaces their roster.

  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { session } from "$lib/session.svelte";

  type BankingReference = { label: string; value: string; note?: string };
  type Banking = { primaryCurrency: string | null; references: BankingReference[] };
  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
    updatedAt: string;
    banking: Banking;
  };
  type RosterRow = {
    bindingId: string;
    userId: string;
    email: string;
    name: string | null;
    roleId: string;
    roleCode: string;
    roleName: string;
    grantedAt: string;
  };
  type Invitation = {
    id: string;
    email: string;
    roleCode: string;
    chapterId: string | null;
    expiresAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  };
  type TemplateSourceType = "envelope" | "online" | "bank_import" | "oblation" | "manual";
  type TemplatePayload = {
    sourceType: TemplateSourceType;
    defaultCurrency?: string | null;
    paymentMethodId?: string | null;
    serviceTypeId?: string | null;
    referenceCode?: string;
    notes?: string;
  };
  type BatchTemplate = {
    id: string;
    name: string;
    payload: TemplatePayload;
    createdAt: string;
    updatedAt: string;
  };

  const ZONE_ADMIN_CODES = new Set(["zone_owner", "zone_admin"]);
  const CHAPTER_ADMIN_CODE = "chapter_admin";

  const SOURCE_TYPES: TemplateSourceType[] = [
    "envelope",
    "online",
    "bank_import",
    "oblation",
    "manual",
  ];

  const INVITABLE_CHAPTER_ROLES: Array<{ value: string; label: string }> = [
    { value: "chapter_admin", label: "Chapter admin" },
    { value: "chapter_treasurer", label: "Chapter treasurer" },
    { value: "chapter_bookkeeper", label: "Chapter bookkeeper" },
    { value: "chapter_pastor_viewer", label: "Chapter pastor (read-only)" },
  ];

  const active = useActiveChapter();

  // ─── Permission derivation ───────────────────────────────────────────
  // Driven entirely off the active session + active zone. The server
  // re-validates on every write; this just controls the UI affordances.
  const canEdit = $derived.by(() => {
    const s = session.current;
    if (s.status !== "authenticated") return false;
    if (s.isSuperAdmin) return true;
    const zone = s.zones.find((z) => z.slug === s.activeZoneSlug);
    if (!zone) return false;
    if (zone.zoneRoles.some((r) => ZONE_ADMIN_CODES.has(r))) return true;
    const here = active();
    if (!here) return false;
    return zone.chapterRoles.some(
      (r) => r.chapterId === here.id && r.roleCode === CHAPTER_ADMIN_CODE,
    );
  });

  // ─── Chapter detail + banking ────────────────────────────────────────
  let detail = $state<Chapter | null>(null);
  let loadError = $state<string | null>(null);

  // Editable copy of banking (only flushed back via Save).
  let primaryCurrency = $state<string>("");
  let refs = $state<BankingReference[]>([]);
  let bankingDirty = $state(false);
  let bankingError = $state<string | null>(null);
  let bankingFlash = $state<string | null>(null);
  let savingBanking = $state(false);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function flashBanking(msg: string) {
    bankingFlash = msg;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      bankingFlash = null;
      flashTimer = null;
    }, 4000);
  }

  function seedBanking(b: Banking) {
    primaryCurrency = b.primaryCurrency ?? "";
    refs = b.references.map((r) => ({ ...r }));
    bankingDirty = false;
  }

  // ─── Roster ──────────────────────────────────────────────────────────
  let roster = $state<RosterRow[]>([]);
  let rosterError = $state<string | null>(null);

  // ─── Batch templates ─────────────────────────────────────────────────
  let templates = $state<BatchTemplate[]>([]);
  let templatesError = $state<string | null>(null);
  let tplName = $state("");
  let tplSource = $state<TemplateSourceType>("envelope");
  let tplCurrency = $state("");
  let tplReferenceCode = $state("");
  let tplNotes = $state("");
  let creatingTemplate = $state(false);
  let templateFlash = $state<string | null>(null);
  let templateFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function flashTemplate(msg: string) {
    templateFlash = msg;
    if (templateFlashTimer) clearTimeout(templateFlashTimer);
    templateFlashTimer = setTimeout(() => {
      templateFlash = null;
      templateFlashTimer = null;
    }, 4000);
  }

  // ─── Invitations ─────────────────────────────────────────────────────
  let invitations = $state<Invitation[]>([]);
  let invError = $state<string | null>(null);
  let inviteEmail = $state("");
  let inviteRole = $state<string>("chapter_treasurer");
  let inviting = $state(false);
  let inviteFlash = $state<string | null>(null);
  let inviteFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function flashInvite(msg: string) {
    inviteFlash = msg;
    if (inviteFlashTimer) clearTimeout(inviteFlashTimer);
    inviteFlashTimer = setTimeout(() => {
      inviteFlash = null;
      inviteFlashTimer = null;
    }, 4000);
  }

  // ─── Loaders ─────────────────────────────────────────────────────────
  async function loadDetail(chapterId: string, signal: AbortSignal) {
    try {
      const res = await api.get<{ chapter: Chapter }>(
        `/api/tenant/chapters/${chapterId}`,
        signal,
      );
      detail = res.chapter;
      seedBanking(res.chapter.banking);
      loadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      loadError = err instanceof ApiError ? err.message : "Could not load chapter.";
    }
  }

  async function loadRoster(chapterId: string, signal: AbortSignal) {
    try {
      const res = await api.get<{ items: RosterRow[] }>(
        `/api/tenant/chapters/${chapterId}/roster`,
        signal,
      );
      roster = res.items;
      rosterError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      rosterError = err instanceof ApiError ? err.message : "Could not load roster.";
    }
  }

  async function loadTemplates(chapterId: string, signal: AbortSignal) {
    try {
      const res = await api.get<{ items: BatchTemplate[] }>(
        `/api/tenant/chapters/${chapterId}/batch-templates`,
        signal,
      );
      templates = res.items;
      templatesError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      templatesError = err instanceof ApiError ? err.message : "Could not load templates.";
    }
  }

  async function loadInvitations(chapterId: string, signal: AbortSignal) {
    try {
      const res = await api.get<{ items: Invitation[] }>(
        `/api/tenant/invitations?chapterId=${chapterId}`,
        signal,
      );
      // Open invitations only — accepted / revoked are historical noise here.
      invitations = res.items.filter((i) => !i.acceptedAt && !i.revokedAt);
      invError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      invError = err instanceof ApiError ? err.message : "Could not load invitations.";
    }
  }

  $effect(() => {
    const here = active();
    if (!here) {
      detail = null;
      roster = [];
      invitations = [];
      return;
    }
    const controller = new AbortController();
    loadDetail(here.id, controller.signal);
    loadRoster(here.id, controller.signal);
    loadInvitations(here.id, controller.signal);
    loadTemplates(here.id, controller.signal);
    return () => controller.abort();
  });

  // ─── Banking mutations ───────────────────────────────────────────────
  function addReference() {
    refs = [...refs, { label: "", value: "", note: "" }];
    bankingDirty = true;
  }
  function removeReference(idx: number) {
    refs = refs.filter((_, i) => i !== idx);
    bankingDirty = true;
  }
  function refChange() {
    bankingDirty = true;
  }

  async function saveBanking(e: SubmitEvent) {
    e.preventDefault();
    const here = active();
    if (!here) return;
    savingBanking = true;
    bankingError = null;
    try {
      // Trim labels + values; drop fully-empty rows so the user can leave
      // a half-typed row and have it just disappear on save.
      const cleaned = refs
        .map((r) => ({
          label: r.label.trim(),
          value: r.value.trim(),
          note: r.note?.trim() || undefined,
        }))
        .filter((r) => r.label || r.value);
      for (const r of cleaned) {
        if (!r.label || !r.value) {
          throw new ApiError(400, "incomplete", "Each banking reference needs both a label and a value.");
        }
      }
      const body = {
        primaryCurrency: primaryCurrency.trim() ? primaryCurrency.trim().toUpperCase() : null,
        references: cleaned,
      };
      const res = await api.patch<{ banking: Banking }>(
        `/api/tenant/chapters/${here.id}/banking`,
        body,
      );
      if (detail) detail = { ...detail, banking: res.banking };
      seedBanking(res.banking);
      flashBanking("Banking settings saved.");
    } catch (err) {
      bankingError = err instanceof ApiError ? err.message : "Could not save banking settings.";
    } finally {
      savingBanking = false;
    }
  }

  // ─── Roster mutations ────────────────────────────────────────────────
  async function revokeBinding(b: RosterRow) {
    const here = active();
    if (!here) return;
    if (!confirm(`Remove ${b.roleName} role from ${b.email}?`)) return;
    try {
      await api.delete(`/api/tenant/chapters/${here.id}/roster/${b.bindingId}`);
      roster = roster.filter((r) => r.bindingId !== b.bindingId);
    } catch (err) {
      rosterError = err instanceof ApiError ? err.message : "Could not revoke role.";
    }
  }

  // ─── Invitations ─────────────────────────────────────────────────────
  async function sendInvite(e: SubmitEvent) {
    e.preventDefault();
    const here = active();
    if (!here) return;
    inviting = true;
    invError = null;
    try {
      await api.post(`/api/tenant/invitations`, {
        email: inviteEmail.trim(),
        roleCode: inviteRole,
        chapterId: here.id,
      });
      inviteEmail = "";
      const controller = new AbortController();
      await loadInvitations(here.id, controller.signal);
      flashInvite("Invitation sent.");
    } catch (err) {
      invError = err instanceof ApiError ? err.message : "Could not send invitation.";
    } finally {
      inviting = false;
    }
  }

  async function revokeInvite(inv: Invitation) {
    if (!confirm(`Revoke invitation to ${inv.email}?`)) return;
    try {
      await api.post(`/api/tenant/invitations/${inv.id}/revoke`, {});
      invitations = invitations.filter((i) => i.id !== inv.id);
    } catch (err) {
      invError = err instanceof ApiError ? err.message : "Could not revoke invitation.";
    }
  }

  async function createTemplate(e: SubmitEvent) {
    e.preventDefault();
    const here = active();
    if (!here) return;
    creatingTemplate = true;
    templatesError = null;
    try {
      const payload: TemplatePayload = {
        sourceType: tplSource,
        defaultCurrency: tplCurrency.trim() ? tplCurrency.trim().toUpperCase() : null,
        referenceCode: tplReferenceCode.trim() || undefined,
        notes: tplNotes.trim() || undefined,
      };
      await api.post(`/api/tenant/chapters/${here.id}/batch-templates`, {
        name: tplName.trim(),
        payload,
      });
      tplName = "";
      tplCurrency = "";
      tplReferenceCode = "";
      tplNotes = "";
      tplSource = "envelope";
      const controller = new AbortController();
      await loadTemplates(here.id, controller.signal);
      flashTemplate("Template saved.");
    } catch (err) {
      templatesError = err instanceof ApiError ? err.message : "Could not save template.";
    } finally {
      creatingTemplate = false;
    }
  }

  async function deleteTemplate(t: BatchTemplate) {
    const here = active();
    if (!here) return;
    if (!confirm(`Delete template “${t.name}”?`)) return;
    try {
      await api.delete(`/api/tenant/chapters/${here.id}/batch-templates/${t.id}`);
      templates = templates.filter((x) => x.id !== t.id);
    } catch (err) {
      templatesError = err instanceof ApiError ? err.message : "Could not delete template.";
    }
  }

  function roleLabel(code: string): string {
    return INVITABLE_CHAPTER_ROLES.find((r) => r.value === code)?.label ?? code;
  }
</script>

<svelte:head><title>Settings · {active()?.name ?? "Chapter"} · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <p class="sl-eyebrow" style="font-size:10.5px">§ Chapter VI · Admin</p>
    <h1 class="sl-display mt-2 text-[40px] leading-[1.05] tracking-tight text-[var(--ink)]">
      {active()?.name ?? "Chapter"} <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">settings</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Currency defaults, banking references, and roster invitations for this
      chapter. {#if !canEdit}<span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">READ-ONLY</span>{/if}
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  <!-- ─── Chapter record ─────────────────────────────────────────── -->
  {#if detail}
    <div class="sl-reveal sl-reveal-2 mt-8 sl-card max-w-2xl overflow-hidden">
      <div class="border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
        <span class="sl-eyebrow">Chapter on file</span>
      </div>
      <dl class="divide-y divide-[var(--rule)] text-[13.5px]">
        <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
          <dt class="text-[var(--ink-mute)]">Reference code</dt>
          <dd class="sl-mono text-[12.5px] text-[var(--ink)]" style="letter-spacing:0.04em">{detail.referenceCode}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
          <dt class="text-[var(--ink-mute)]">Name</dt>
          <dd class="text-[var(--ink)]">{detail.name}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
          <dt class="text-[var(--ink-mute)]">Country</dt>
          <dd class="sl-mono text-[12.5px] text-[var(--ink)]">{detail.countryCode ?? "—"}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
          <dt class="text-[var(--ink-mute)]">Start date</dt>
          <dd class="sl-mono text-[12.5px] text-[var(--ink)]">{detail.dateFrom}</dd>
        </div>
      </dl>
    </div>

    <!-- ─── Banking ────────────────────────────────────────────── -->
    <form class="sl-reveal sl-reveal-3 mt-10 max-w-3xl" onsubmit={saveBanking}>
      <div class="flex items-end justify-between gap-4">
        <div>
          <span class="sl-eyebrow">Banking</span>
          <h2 class="sl-display mt-1 text-[24px] tracking-tight text-[var(--ink)]">References &amp; currency</h2>
        </div>
        {#if canEdit}
          <button type="submit" disabled={!bankingDirty || savingBanking} class="sl-btn sl-btn-primary">
            {savingBanking ? "Saving…" : "Save"}
          </button>
        {/if}
      </div>

      <div class="mt-4 sl-card overflow-hidden">
        <div class="grid grid-cols-12 gap-4 px-6 py-5">
          <label class="col-span-12 sm:col-span-4">
            <span class="sl-eyebrow" style="font-size:10.5px">Primary currency</span>
            <input
              type="text"
              maxlength="3"
              placeholder="GBP"
              bind:value={primaryCurrency}
              oninput={refChange}
              disabled={!canEdit}
              class="sl-input mt-1.5 sl-mono uppercase"
              style="letter-spacing:0.08em"
            />
            <span class="mt-1 block text-[11px] text-[var(--ink-mute)]">ISO 4217 — leave empty to use the zone default.</span>
          </label>
        </div>

        <div class="border-t border-[var(--rule)]">
          <div class="flex items-center justify-between px-6 py-3 bg-[var(--paper-soft)]">
            <span class="sl-eyebrow">Banking references</span>
            <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
              {refs.length} {refs.length === 1 ? "row" : "rows"}
            </span>
          </div>
          {#if refs.length === 0}
            <p class="px-6 py-5 text-[13px] text-[var(--ink-mute)]">
              No banking references yet. {canEdit ? "Add one to record account names, sort codes, or online giving descriptors." : ""}
            </p>
          {/if}
          {#each refs as r, i (i)}
            <div class="grid grid-cols-12 gap-3 border-t border-[var(--rule)] px-6 py-4">
              <label class="col-span-12 sm:col-span-3">
                <span class="sl-eyebrow" style="font-size:10.5px">Label</span>
                <input
                  type="text"
                  required
                  maxlength="80"
                  bind:value={r.label}
                  oninput={refChange}
                  disabled={!canEdit}
                  class="sl-input mt-1.5"
                  placeholder="Main current"
                />
              </label>
              <label class="col-span-12 sm:col-span-4">
                <span class="sl-eyebrow" style="font-size:10.5px">Value</span>
                <input
                  type="text"
                  required
                  maxlength="200"
                  bind:value={r.value}
                  oninput={refChange}
                  disabled={!canEdit}
                  class="sl-input mt-1.5 sl-mono"
                  placeholder="12-34-56 / 12345678"
                />
              </label>
              <label class="col-span-12 sm:col-span-4">
                <span class="sl-eyebrow" style="font-size:10.5px">Note</span>
                <input
                  type="text"
                  maxlength="280"
                  bind:value={r.note}
                  oninput={refChange}
                  disabled={!canEdit}
                  class="sl-input mt-1.5"
                  placeholder="optional"
                />
              </label>
              {#if canEdit}
                <div class="col-span-12 flex items-end justify-end sm:col-span-1">
                  <button
                    type="button"
                    class="sl-btn sl-btn-ghost"
                    onclick={() => removeReference(i)}
                    title="Remove"
                  >Remove</button>
                </div>
              {/if}
            </div>
          {/each}
          {#if canEdit}
            <div class="border-t border-[var(--rule)] px-6 py-3">
              <button type="button" class="sl-btn sl-btn-ghost" onclick={addReference}>+ Add reference</button>
            </div>
          {/if}
        </div>
      </div>

      {#if bankingError}
        <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{bankingError}</p>
      {/if}
      {#if bankingFlash}
        <p class="mt-3 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">{bankingFlash}</p>
      {/if}
    </form>

    <!-- ─── Roster ────────────────────────────────────────────── -->
    <section class="sl-reveal sl-reveal-4 mt-12 max-w-3xl">
      <span class="sl-eyebrow">Roster</span>
      <h2 class="sl-display mt-1 text-[24px] tracking-tight text-[var(--ink)]">Chapter team</h2>

      {#if rosterError}
        <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{rosterError}</p>
      {/if}

      <div class="mt-4 sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Granted</th>
              {#if canEdit}<th aria-label="Actions"></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each roster as r (r.bindingId)}
              <tr>
                <td class="sl-mono text-[12px]">{r.email}</td>
                <td class="text-[var(--ink-soft)]">{r.name ?? "—"}</td>
                <td>
                  <span class="sl-badge sl-badge-mute">{r.roleName}</span>
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">{r.grantedAt.slice(0, 10)}</td>
                {#if canEdit}
                  <td class="text-right">
                    <button type="button" class="sl-btn sl-btn-ghost" onclick={() => revokeBinding(r)}>
                      Revoke
                    </button>
                  </td>
                {/if}
              </tr>
            {/each}
            {#if roster.length === 0}
              <tr>
                <td colspan={canEdit ? 5 : 4} class="py-10 text-center text-[13px] text-[var(--ink-mute)]">
                  No chapter-scoped users yet.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </section>

    <!-- ─── Invitations ────────────────────────────────────────── -->
    {#if canEdit}
      <section class="sl-reveal sl-reveal-5 mt-12 max-w-3xl">
        <span class="sl-eyebrow">Invitations</span>
        <h2 class="sl-display mt-1 text-[24px] tracking-tight text-[var(--ink)]">Invite a teammate</h2>

        <form class="mt-4 sl-card-warm grid grid-cols-12 gap-3 p-6" onsubmit={sendInvite}>
          <label class="col-span-12 sm:col-span-5">
            <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
            <input
              type="email"
              required
              bind:value={inviteEmail}
              class="sl-input mt-1.5"
              placeholder="teammate@example.com"
            />
          </label>
          <label class="col-span-12 sm:col-span-5">
            <span class="sl-eyebrow" style="font-size:10.5px">Role</span>
            <select bind:value={inviteRole} class="sl-input mt-1.5">
              {#each INVITABLE_CHAPTER_ROLES as r (r.value)}
                <option value={r.value}>{r.label}</option>
              {/each}
            </select>
          </label>
          <div class="col-span-12 flex items-end sm:col-span-2">
            <button type="submit" disabled={inviting} class="sl-btn sl-btn-primary w-full justify-center">
              {inviting ? "Sending…" : "Send invite"}
            </button>
          </div>
          {#if invError}
            <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{invError}</p>
          {/if}
          {#if inviteFlash}
            <p class="col-span-12 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">{inviteFlash}</p>
          {/if}
        </form>

        {#if invitations.length > 0}
          <div class="mt-6">
            <div class="mb-2 flex items-center justify-between">
              <span class="sl-eyebrow">Open invitations</span>
              <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
                {invitations.length} {invitations.length === 1 ? "open" : "open"}
              </span>
            </div>
            <div class="sl-card overflow-hidden">
              <table class="sl-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th aria-label="Actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each invitations as inv (inv.id)}
                    <tr>
                      <td class="sl-mono text-[12px]">{inv.email}</td>
                      <td><span class="sl-badge sl-badge-mute">{roleLabel(inv.roleCode)}</span></td>
                      <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">{inv.expiresAt.slice(0, 10)}</td>
                      <td class="text-right">
                        <button type="button" class="sl-btn sl-btn-ghost" onclick={() => revokeInvite(inv)}>Revoke</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </section>
    {/if}

    <!-- ─── Batch templates ───────────────────────────────────── -->
    <section class="sl-reveal sl-reveal-6 mt-12 max-w-3xl">
      <span class="sl-eyebrow">Batch templates</span>
      <h2 class="sl-display mt-1 text-[24px] tracking-tight text-[var(--ink)]">Sunday-close presets</h2>
      <p class="mt-2 max-w-2xl text-[13px] text-[var(--ink-mute)]">
        Save the batch shape your treasurer runs every week. Pick one from the “New batch”
        flow on contributions to prefill the form.
      </p>

      {#if templatesError}
        <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{templatesError}</p>
      {/if}

      <div class="mt-4 sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th>Currency</th>
              <th>Reference</th>
              {#if canEdit}<th aria-label="Actions"></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each templates as t (t.id)}
              <tr>
                <td><span class="sl-display text-[14px] text-[var(--ink)]">{t.name}</span></td>
                <td><span class="sl-badge sl-badge-mute">{t.payload.sourceType}</span></td>
                <td class="sl-mono text-[12px]">{t.payload.defaultCurrency ?? "—"}</td>
                <td class="sl-mono text-[12px] text-[var(--ink-mute)]">{t.payload.referenceCode ?? "—"}</td>
                {#if canEdit}
                  <td class="text-right">
                    <button type="button" class="sl-btn sl-btn-ghost" onclick={() => deleteTemplate(t)}>Delete</button>
                  </td>
                {/if}
              </tr>
            {/each}
            {#if templates.length === 0}
              <tr>
                <td colspan={canEdit ? 5 : 4} class="py-10 text-center text-[13px] text-[var(--ink-mute)]">
                  No templates yet.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>

      {#if canEdit}
        <form class="mt-6 sl-card-warm grid grid-cols-12 gap-3 p-6" onsubmit={createTemplate}>
          <label class="col-span-12 sm:col-span-4">
            <span class="sl-eyebrow" style="font-size:10.5px">Name</span>
            <input
              type="text"
              required
              maxlength="80"
              bind:value={tplName}
              class="sl-input mt-1.5"
              placeholder="Sunday close"
            />
          </label>
          <label class="col-span-6 sm:col-span-3">
            <span class="sl-eyebrow" style="font-size:10.5px">Source</span>
            <select bind:value={tplSource} class="sl-input mt-1.5">
              {#each SOURCE_TYPES as s (s)}
                <option value={s}>{s}</option>
              {/each}
            </select>
          </label>
          <label class="col-span-6 sm:col-span-2">
            <span class="sl-eyebrow" style="font-size:10.5px">Currency</span>
            <input
              type="text"
              maxlength="3"
              bind:value={tplCurrency}
              class="sl-input mt-1.5 sl-mono uppercase"
              style="letter-spacing:0.08em"
              placeholder="GBP"
            />
          </label>
          <div class="col-span-12 flex items-end sm:col-span-3">
            <button type="submit" disabled={creatingTemplate} class="sl-btn sl-btn-primary w-full justify-center">
              {creatingTemplate ? "Saving…" : "Save template"}
            </button>
          </div>
          <label class="col-span-12 sm:col-span-6">
            <span class="sl-eyebrow" style="font-size:10.5px">Reference (optional)</span>
            <input type="text" maxlength="80" bind:value={tplReferenceCode} class="sl-input mt-1.5" placeholder="e.g. paying-in book" />
          </label>
          <label class="col-span-12 sm:col-span-6">
            <span class="sl-eyebrow" style="font-size:10.5px">Notes (optional)</span>
            <input type="text" maxlength="4000" bind:value={tplNotes} class="sl-input mt-1.5" placeholder="e.g. cash + cheque cycle" />
          </label>
          {#if templateFlash}
            <p class="col-span-12 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">{templateFlash}</p>
          {/if}
        </form>
      {/if}
    </section>
  {/if}
</div>
