<!-- packages/web/src/routes/zone/targets/+page.svelte -->
<!-- Phase 8 — financial target CRUD UI. -->
<!-- Per (zone, chapter?, giving_type, ministry_year) target rows. -->
<!-- RELEVANT FILES: packages/api/src/routes/tenant-targets.ts, packages/web/src/lib/targets/access.ts -->

<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";
  import {
    canWriteFinancialTarget,
    hasChapterWriteTargets,
    hasZoneWriteTargets,
  } from "$lib/targets/access";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Chapter = { id: string; referenceCode: string; name: string };
  type GivingType = {
    id: string;
    name: string;
    shortCode: string | null;
    hasPartnershipTarget: boolean;
    isActive: boolean;
  };
  type MinistryYear = {
    id: string;
    yearLabel: string;
    startDate: string;
    endDate: string;
  };
  type FinancialTarget = {
    id: string;
    chapterId: string | null;
    givingTypeId: string;
    ministryYearId: string;
    fullTarget: string;
    monthlyTarget: string | null;
    weeklyBreakdown: string | null;
    fullTargetCopies: number | null;
    numberOfPartners: number | null;
    currencyCode: string;
    createdAt: string;
    updatedAt: string;
  };

  let targets = $state<FinancialTarget[]>([]);
  let chapters = $state<Chapter[]>([]);
  let givingTypes = $state<GivingType[]>([]);
  let ministryYears = $state<MinistryYear[]>([]);
  let auth = $state<AuthorizedContext | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // Pagination — request PAGE_SIZE+1, slice probe off; same pattern
  // as the paying-in-books page so an exact-multiple total doesn't
  // surface a phantom Next button.
  const PAGE_SIZE = 100;
  let offset = $state(0);
  let pageCount = $state(0);
  let hasMore = $state(false);
  let refreshToken = 0;

  // Filters.
  let chapterFilter = $state("");
  let ministryYearFilter = $state("");
  let givingTypeFilter = $state("");
  let zoneWideOnly = $state(false);

  // Lookups.
  const chapterById = $derived(new Map(chapters.map((c) => [c.id, c])));
  const givingTypeById = $derived(new Map(givingTypes.map((g) => [g.id, g])));
  const ministryYearById = $derived(new Map(ministryYears.map((y) => [y.id, y])));

  // Create form.
  let createOpen = $state(false);
  let createChapterId = $state(""); // "" = zone-wide
  let createGivingTypeId = $state("");
  let createMinistryYearId = $state("");
  let createCurrency = $state("GBP");
  let createFullTarget = $state("");
  let createMonthlyTarget = $state("");
  let createWeeklyBreakdown = $state("");
  let createFullTargetCopies = $state("");
  let createNumberOfPartners = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  // Edit state.
  let editingId = $state<string | null>(null);
  let editFullTarget = $state("");
  let editMonthlyTarget = $state("");
  let editWeeklyBreakdown = $state("");
  let editFullTargetCopies = $state("");
  let editNumberOfPartners = $state("");
  let editError = $state<string | null>(null);
  let saving = $state(false);

  const hasZoneWrite = $derived(hasZoneWriteTargets(auth));
  const hasChapterWriteRole = $derived(hasChapterWriteTargets(auth));

  function canWriteForChapter(chapterId: string | null): boolean {
    return canWriteFinancialTarget(auth, chapterId);
  }

  async function loadAll(signal: AbortSignal) {
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const params = new URLSearchParams();
      if (chapterFilter) params.set("chapterId", chapterFilter);
      if (ministryYearFilter) params.set("ministryYearId", ministryYearFilter);
      if (givingTypeFilter) params.set("givingTypeId", givingTypeFilter);
      if (zoneWideOnly && !chapterFilter) params.set("zoneWideOnly", "true");
      params.set("limit", String(PAGE_SIZE + 1));
      params.set("offset", String(offset));
      const [me, chapterRes, givingTypeRes, ministryYearRes, targetRes] =
        await Promise.all([
          api.get<{ auth: AuthorizedContext }>("/api/tenant/me", signal),
          api.get<{ items: Chapter[] }>("/api/tenant/chapters", signal),
          api.get<{ items: GivingType[] }>("/api/tenant/giving/types", signal),
          api.get<{ items: MinistryYear[] }>(
            "/api/tenant/periods/ministry-years",
            signal,
          ),
          api.get<{ items: FinancialTarget[] }>(
            `/api/tenant/targets?${params.toString()}`,
            signal,
          ),
        ]);
      if (my !== refreshToken) return;
      auth = me.auth;
      chapters = chapterRes.items;
      givingTypes = givingTypeRes.items.filter((g) => g.isActive !== false);
      ministryYears = ministryYearRes.items;
      hasMore = targetRes.items.length > PAGE_SIZE;
      targets = hasMore ? targetRes.items.slice(0, PAGE_SIZE) : targetRes.items;
      pageCount = targets.length;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load targets.";
    } finally {
      if (!signal.aborted && my === refreshToken) loading = false;
    }
  }

  // Reset offset on filter change so a paged-forward user doesn't
  // land on a phantom empty page after narrowing.
  let lastFilterKey = "";
  $effect(() => {
    const key = `${chapterFilter}|${ministryYearFilter}|${givingTypeFilter}|${zoneWideOnly}`;
    if (key !== lastFilterKey) {
      offset = 0;
      lastFilterKey = key;
    }
    const controller = new AbortController();
    void offset;
    loadAll(controller.signal);
    return () => controller.abort();
  });

  function nextPage() {
    if (!hasMore) return;
    offset += PAGE_SIZE;
  }
  function prevPage() {
    offset = Math.max(0, offset - PAGE_SIZE);
  }

  function resetCreateForm() {
    createChapterId = "";
    createGivingTypeId = "";
    createMinistryYearId = "";
    createCurrency = "GBP";
    createFullTarget = "";
    createMonthlyTarget = "";
    createWeeklyBreakdown = "";
    createFullTargetCopies = "";
    createNumberOfPartners = "";
    createError = null;
  }

  function toggleCreate() {
    createOpen = !createOpen;
    if (!createOpen) resetCreateForm();
  }

  async function submitCreate(evt: SubmitEvent) {
    evt.preventDefault();
    if (creating) return;
    creating = true;
    createError = null;
    try {
      await api.post<{ target: FinancialTarget }>("/api/tenant/targets", {
        chapterId: createChapterId === "" ? null : createChapterId,
        givingTypeId: createGivingTypeId,
        ministryYearId: createMinistryYearId,
        currencyCode: createCurrency.trim().toUpperCase(),
        fullTarget: createFullTarget.trim(),
        monthlyTarget: createMonthlyTarget.trim() === "" ? null : createMonthlyTarget.trim(),
        weeklyBreakdown:
          createWeeklyBreakdown.trim() === "" ? null : createWeeklyBreakdown.trim(),
        fullTargetCopies:
          createFullTargetCopies.trim() === "" ? null : Number(createFullTargetCopies),
        numberOfPartners:
          createNumberOfPartners.trim() === "" ? null : Number(createNumberOfPartners),
      });
      resetCreateForm();
      createOpen = false;
      offset = 0;
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create the target.";
    } finally {
      creating = false;
    }
  }

  function beginEdit(t: FinancialTarget) {
    editingId = t.id;
    editFullTarget = t.fullTarget;
    editMonthlyTarget = t.monthlyTarget ?? "";
    editWeeklyBreakdown = t.weeklyBreakdown ?? "";
    editFullTargetCopies = t.fullTargetCopies === null ? "" : String(t.fullTargetCopies);
    editNumberOfPartners = t.numberOfPartners === null ? "" : String(t.numberOfPartners);
    editError = null;
  }

  function cancelEdit() {
    editingId = null;
    editError = null;
  }

  async function saveEdit(t: FinancialTarget) {
    if (saving) return;
    saving = true;
    editError = null;
    try {
      await api.patch<{ target: FinancialTarget }>(`/api/tenant/targets/${t.id}`, {
        fullTarget: editFullTarget.trim(),
        monthlyTarget: editMonthlyTarget.trim() === "" ? null : editMonthlyTarget.trim(),
        weeklyBreakdown:
          editWeeklyBreakdown.trim() === "" ? null : editWeeklyBreakdown.trim(),
        fullTargetCopies:
          editFullTargetCopies.trim() === "" ? null : Number(editFullTargetCopies),
        numberOfPartners:
          editNumberOfPartners.trim() === "" ? null : Number(editNumberOfPartners),
      });
      editingId = null;
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      editError = err instanceof ApiError ? err.message : "Could not save the target.";
    } finally {
      saving = false;
    }
  }

  async function deleteTarget(t: FinancialTarget) {
    const label = chapterLabel(t.chapterId) + " · " + givingTypeLabel(t.givingTypeId);
    if (!confirm(`Delete target for ${label}? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/tenant/targets/${t.id}`);
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not delete the target.";
    }
  }

  function chapterLabel(chapterId: string | null): string {
    if (chapterId === null) return "All chapters (zone-wide)";
    const c = chapterById.get(chapterId);
    if (!c) return chapterId;
    return `${c.referenceCode} · ${c.name}`;
  }

  function givingTypeLabel(givingTypeId: string): string {
    const g = givingTypeById.get(givingTypeId);
    if (!g) return givingTypeId;
    return g.shortCode ? `${g.shortCode} · ${g.name}` : g.name;
  }

  function ministryYearLabel(ministryYearId: string): string {
    return ministryYearById.get(ministryYearId)?.yearLabel ?? ministryYearId;
  }
</script>

<svelte:head><title>Financial targets · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Giving · Financial targets</span>
    <h1 class="mt-3 sl-display text-[52px] leading-[1] text-[var(--ink)]">
      Financial <span class="sl-serif-italic font-light text-[var(--brass-deep)]">targets</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[15px] text-[var(--ink-mute)]">
      Goal amounts per chapter (or zone-wide), giving type, and ministry
      year. The partnership-progress report reads these to compute
      target vs achieved.
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
      {loadError}
    </p>
  {/if}

  <!-- Filter bar. -->
  <div class="sl-reveal sl-reveal-2 mt-8 rounded-xl border bg-white p-4 shadow-sm">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <label class="text-sm">
        <span class="block text-slate-600">Chapter</span>
        <select
          bind:value={chapterFilter}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">All in scope</option>
          {#each chapters as chapter (chapter.id)}
            <option value={chapter.id}>{chapterLabel(chapter.id)}</option>
          {/each}
        </select>
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">Ministry year</span>
        <select
          bind:value={ministryYearFilter}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">All years</option>
          {#each ministryYears as y (y.id)}
            <option value={y.id}>{y.yearLabel}</option>
          {/each}
        </select>
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">Giving type</span>
        <select
          bind:value={givingTypeFilter}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">All types</option>
          {#each givingTypes as g (g.id)}
            <option value={g.id}>{givingTypeLabel(g.id)}</option>
          {/each}
        </select>
      </label>
      <div class="flex items-end justify-between gap-3">
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            bind:checked={zoneWideOnly}
            disabled={chapterFilter !== ""}
            class="rounded"
          />
          <span class="text-slate-600">Zone-wide only</span>
        </label>
        <button
          type="button"
          onclick={toggleCreate}
          disabled={!hasZoneWrite && !hasChapterWriteRole}
          class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {createOpen ? "Cancel" : "New target"}
        </button>
      </div>
    </div>
  </div>

  <!-- Create form. -->
  {#if createOpen}
    <form
      onsubmit={submitCreate}
      class="sl-reveal sl-reveal-3 mt-4 rounded-xl border bg-white p-5 shadow-sm"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label class="text-sm">
          <span class="block text-slate-600">Chapter</span>
          <select
            bind:value={createChapterId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            {#if hasZoneWrite}
              <option value="">Zone-wide (all chapters)</option>
            {/if}
            {#each chapters as chapter (chapter.id)}
              {#if canWriteForChapter(chapter.id)}
                <option value={chapter.id}>{chapterLabel(chapter.id)}</option>
              {/if}
            {/each}
          </select>
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Ministry year</span>
          <select
            bind:value={createMinistryYearId}
            required
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="" disabled>Select a year</option>
            {#each ministryYears as y (y.id)}
              <option value={y.id}>{y.yearLabel}</option>
            {/each}
          </select>
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Giving type</span>
          <select
            bind:value={createGivingTypeId}
            required
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="" disabled>Select a type</option>
            {#each givingTypes as g (g.id)}
              <option value={g.id}>{givingTypeLabel(g.id)}</option>
            {/each}
          </select>
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Currency</span>
          <input
            type="text"
            bind:value={createCurrency}
            required
            maxlength={3}
            placeholder="GBP"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 uppercase"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Full target</span>
          <input
            type="text"
            bind:value={createFullTarget}
            required
            inputmode="decimal"
            placeholder="0.00"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Monthly target (optional)</span>
          <input
            type="text"
            bind:value={createMonthlyTarget}
            inputmode="decimal"
            placeholder="0.00"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Weekly breakdown (optional)</span>
          <input
            type="text"
            bind:value={createWeeklyBreakdown}
            inputmode="decimal"
            placeholder="0.00"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Target copies (optional)</span>
          <input
            type="number"
            bind:value={createFullTargetCopies}
            min="0"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Number of partners (optional)</span>
          <input
            type="number"
            bind:value={createNumberOfPartners}
            min="0"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <div class="flex items-end sm:col-span-2">
          <button
            type="submit"
            disabled={creating}
            class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {creating ? "Saving…" : "Create target"}
          </button>
        </div>
      </div>
      {#if createError}
        <p class="mt-3 text-sm text-rose-700">{createError}</p>
      {/if}
      <p class="mt-2 text-[12px] text-slate-500">
        One target per (chapter or zone-wide, ministry year, giving
        type). Update an existing target instead of creating a duplicate.
      </p>
    </form>
  {/if}

  <!-- Targets list. -->
  <div class="sl-reveal sl-reveal-4 mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
    <table class="min-w-full text-sm" aria-label="Financial targets">
      <thead class="bg-slate-50 text-left text-slate-600">
        <tr>
          <th class="px-3 py-2 font-medium">Scope</th>
          <th class="px-3 py-2 font-medium">Ministry year</th>
          <th class="px-3 py-2 font-medium">Giving type</th>
          <th class="px-3 py-2 font-medium">Currency</th>
          <th class="px-3 py-2 font-medium text-right">Full target</th>
          <th class="px-3 py-2 font-medium text-right">Monthly</th>
          <th class="px-3 py-2 font-medium text-right">Weekly</th>
          <th class="px-3 py-2 font-medium text-right">Partners</th>
          <th class="px-3 py-2 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each targets as target (target.id)}
          <tr class="border-t">
            <td class="px-3 py-2 align-top">{chapterLabel(target.chapterId)}</td>
            <td class="px-3 py-2 align-top">{ministryYearLabel(target.ministryYearId)}</td>
            <td class="px-3 py-2 align-top">{givingTypeLabel(target.givingTypeId)}</td>
            <td class="px-3 py-2 align-top">{target.currencyCode}</td>
            {#if editingId === target.id}
              <td class="px-3 py-2 align-top">
                <input
                  type="text"
                  bind:value={editFullTarget}
                  inputmode="decimal"
                  class="w-full rounded border border-slate-300 px-2 py-1 text-right"
                />
              </td>
              <td class="px-3 py-2 align-top">
                <input
                  type="text"
                  bind:value={editMonthlyTarget}
                  inputmode="decimal"
                  class="w-full rounded border border-slate-300 px-2 py-1 text-right"
                />
              </td>
              <td class="px-3 py-2 align-top">
                <input
                  type="text"
                  bind:value={editWeeklyBreakdown}
                  inputmode="decimal"
                  class="w-full rounded border border-slate-300 px-2 py-1 text-right"
                />
              </td>
              <td class="px-3 py-2 align-top">
                <input
                  type="number"
                  bind:value={editNumberOfPartners}
                  min="0"
                  class="w-full rounded border border-slate-300 px-2 py-1 text-right"
                />
              </td>
              <td class="px-3 py-2 align-top text-right">
                <div class="flex justify-end gap-2">
                  <button
                    type="button"
                    onclick={() => saveEdit(target)}
                    disabled={saving}
                    class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400 disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onclick={cancelEdit}
                    class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400"
                  >
                    Cancel
                  </button>
                </div>
                {#if editError}
                  <p class="mt-1 text-xs text-rose-700">{editError}</p>
                {/if}
              </td>
            {:else}
              <td class="px-3 py-2 align-top text-right font-mono">{target.fullTarget}</td>
              <td class="px-3 py-2 align-top text-right text-slate-500">
                {target.monthlyTarget ?? "—"}
              </td>
              <td class="px-3 py-2 align-top text-right text-slate-500">
                {target.weeklyBreakdown ?? "—"}
              </td>
              <td class="px-3 py-2 align-top text-right text-slate-500">
                {target.numberOfPartners ?? "—"}
              </td>
              <td class="px-3 py-2 align-top text-right">
                {#if canWriteForChapter(target.chapterId)}
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      onclick={() => beginEdit(target)}
                      class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onclick={() => deleteTarget(target)}
                      class="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-rose-700 hover:border-rose-400"
                    >
                      Delete
                    </button>
                  </div>
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
        {#if targets.length === 0 && !loading}
          <tr>
            <td colspan={9} class="px-3 py-8 text-center text-slate-500">
              No targets match the current filters.
            </td>
          </tr>
        {/if}
        {#if loading && targets.length === 0}
          <tr>
            <td colspan={9} class="px-3 py-8 text-center text-slate-500">Loading…</td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>

  {#if pageCount > 0 || offset > 0}
    <div class="sl-reveal sl-reveal-5 mt-4 flex items-center justify-between text-[13px] text-slate-600">
      <span>
        Showing rows {offset + 1}–{offset + pageCount}
        {#if hasMore}(more available){/if}
      </span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={prevPage}
          disabled={offset === 0 || loading}
          class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          type="button"
          onclick={nextPage}
          disabled={!hasMore || loading}
          class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400 disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  {/if}
</div>
