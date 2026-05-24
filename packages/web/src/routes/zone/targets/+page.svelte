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
  import { parseOptionalCount } from "$lib/targets/numeric";
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
      const fullTargetCopies = parseOptionalCount(
        createFullTargetCopies,
        "Target copies",
      );
      const numberOfPartners = parseOptionalCount(
        createNumberOfPartners,
        "Number of partners",
      );
      await api.post<{ target: FinancialTarget }>("/api/tenant/targets", {
        chapterId: createChapterId === "" ? null : createChapterId,
        givingTypeId: createGivingTypeId,
        ministryYearId: createMinistryYearId,
        currencyCode: createCurrency.trim().toUpperCase(),
        fullTarget: createFullTarget.trim(),
        monthlyTarget: createMonthlyTarget.trim() === "" ? null : createMonthlyTarget.trim(),
        weeklyBreakdown:
          createWeeklyBreakdown.trim() === "" ? null : createWeeklyBreakdown.trim(),
        fullTargetCopies,
        numberOfPartners,
      });
      resetCreateForm();
      createOpen = false;
      offset = 0;
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      if (err instanceof ApiError) createError = err.message;
      else if (err instanceof Error) createError = err.message;
      else createError = "Could not create the target.";
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
      const fullTargetCopies = parseOptionalCount(
        editFullTargetCopies,
        "Target copies",
      );
      const numberOfPartners = parseOptionalCount(
        editNumberOfPartners,
        "Number of partners",
      );
      await api.patch<{ target: FinancialTarget }>(`/api/tenant/targets/${t.id}`, {
        fullTarget: editFullTarget.trim(),
        monthlyTarget: editMonthlyTarget.trim() === "" ? null : editMonthlyTarget.trim(),
        weeklyBreakdown:
          editWeeklyBreakdown.trim() === "" ? null : editWeeklyBreakdown.trim(),
        fullTargetCopies,
        numberOfPartners,
      });
      editingId = null;
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      if (err instanceof ApiError) editError = err.message;
      else if (err instanceof Error) editError = err.message;
      else editError = "Could not save the target.";
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
  <div class="sl-reveal sl-reveal-2 sl-card-warm mt-8 p-6">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
        <select bind:value={chapterFilter} class="sl-select mt-1.5">
          <option value="">All in scope</option>
          {#each chapters as chapter (chapter.id)}
            <option value={chapter.id}>{chapterLabel(chapter.id)}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Ministry year</span>
        <select bind:value={ministryYearFilter} class="sl-select mt-1.5">
          <option value="">All years</option>
          {#each ministryYears as y (y.id)}
            <option value={y.id}>{y.yearLabel}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Giving type</span>
        <select bind:value={givingTypeFilter} class="sl-select mt-1.5">
          <option value="">All types</option>
          {#each givingTypes as g (g.id)}
            <option value={g.id}>{givingTypeLabel(g.id)}</option>
          {/each}
        </select>
      </label>
      <div class="flex items-center justify-between gap-3">
        <label class="flex items-center gap-2 text-[12.5px] text-[var(--ink-mute)]">
          <input
            type="checkbox"
            bind:checked={zoneWideOnly}
            disabled={chapterFilter !== ""}
            class="rounded"
          />
          <span>Zone-wide only</span>
        </label>
        <button
          type="button"
          onclick={toggleCreate}
          disabled={!hasZoneWrite && !hasChapterWriteRole}
          class="sl-btn sl-btn-primary"
        >
          {#if createOpen}Cancel{:else}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
            </svg>
            New target
          {/if}
        </button>
      </div>
    </div>
  </div>

  <!-- Create form. -->
  {#if createOpen}
    <form onsubmit={submitCreate} class="sl-reveal sl-card-warm mt-4 p-6">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
          <select bind:value={createChapterId} class="sl-select mt-1.5">
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
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Ministry year</span>
          <select bind:value={createMinistryYearId} required class="sl-select mt-1.5">
            <option value="" disabled>Select a year</option>
            {#each ministryYears as y (y.id)}
              <option value={y.id}>{y.yearLabel}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Giving type</span>
          <select bind:value={createGivingTypeId} required class="sl-select mt-1.5">
            <option value="" disabled>Select a type</option>
            {#each givingTypes as g (g.id)}
              <option value={g.id}>{givingTypeLabel(g.id)}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Currency</span>
          <input type="text" bind:value={createCurrency} required maxlength={3} placeholder="GBP" class="sl-input mt-1.5 uppercase" />
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Full target</span>
          <input type="text" bind:value={createFullTarget} required inputmode="decimal" placeholder="0.00" class="sl-input sl-num mt-1.5" />
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Monthly target (optional)</span>
          <input type="text" bind:value={createMonthlyTarget} inputmode="decimal" placeholder="0.00" class="sl-input sl-num mt-1.5" />
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Weekly breakdown (optional)</span>
          <input type="text" bind:value={createWeeklyBreakdown} inputmode="decimal" placeholder="0.00" class="sl-input sl-num mt-1.5" />
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Target copies (optional)</span>
          <!-- type="text" + inputmode keeps the bound value a string so
               the submit handler's .trim() / nullish-coalesce logic
               works the same way it does for the money fields. -->
          <input type="text" bind:value={createFullTargetCopies} inputmode="numeric" pattern="[0-9]*" placeholder="0" class="sl-input sl-num mt-1.5" />
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Number of partners (optional)</span>
          <input type="text" bind:value={createNumberOfPartners} inputmode="numeric" pattern="[0-9]*" placeholder="0" class="sl-input sl-num mt-1.5" />
        </label>
        <div class="flex items-end sm:col-span-2">
          <button type="submit" disabled={creating} class="sl-btn sl-btn-primary w-full justify-center">
            {creating ? "Saving…" : "Create target"}
          </button>
        </div>
      </div>
      {#if createError}
        <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
      {/if}
      <p class="mt-3 text-[11.5px] text-[var(--ink-mute)]">
        One target per (chapter or zone-wide, ministry year, giving
        type). Update an existing target instead of creating a duplicate.
      </p>
    </form>
  {/if}

  <!-- Targets list. -->
  <div class="sl-reveal sl-reveal-4 mt-8">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Targets on file</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {pageCount} {pageCount === 1 ? "row" : "rows"}{hasMore ? " · more available" : ""}
      </span>
    </div>
    <div class="sl-card overflow-hidden">
      <table class="sl-table" aria-label="Financial targets">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Ministry year</th>
            <th>Giving type</th>
            <th>Currency</th>
            <th class="!text-right">Full target</th>
            <th class="!text-right">Monthly</th>
            <th class="!text-right">Weekly</th>
            <th class="!text-right">Partners</th>
            <th class="!text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each targets as target (target.id)}
            <tr>
              <td>{chapterLabel(target.chapterId)}</td>
              <td>{ministryYearLabel(target.ministryYearId)}</td>
              <td>{givingTypeLabel(target.givingTypeId)}</td>
              <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{target.currencyCode}</td>
              {#if editingId === target.id}
                <td>
                  <input type="text" bind:value={editFullTarget} inputmode="decimal" class="sl-input sl-num text-right" />
                </td>
                <td>
                  <input type="text" bind:value={editMonthlyTarget} inputmode="decimal" class="sl-input sl-num text-right" />
                </td>
                <td>
                  <input type="text" bind:value={editWeeklyBreakdown} inputmode="decimal" class="sl-input sl-num text-right" />
                </td>
                <td>
                  <input type="text" bind:value={editNumberOfPartners} inputmode="numeric" pattern="[0-9]*" class="sl-input sl-num text-right" />
                </td>
                <td class="text-right">
                  <div class="flex justify-end gap-2">
                    <button type="button" onclick={() => saveEdit(target)} disabled={saving} class="sl-btn sl-btn-primary">
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button type="button" onclick={cancelEdit} class="sl-btn sl-btn-ghost">
                      Cancel
                    </button>
                  </div>
                  {#if editError}
                    <p class="mt-2 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-2 py-1 text-[12px] text-[var(--bad)]">{editError}</p>
                  {/if}
                </td>
              {:else}
                <td class="sl-num text-right text-[var(--ink)]">{target.fullTarget}</td>
                <td class="sl-num text-right text-[var(--ink-mute)]">{target.monthlyTarget ?? "—"}</td>
                <td class="sl-num text-right text-[var(--ink-mute)]">{target.weeklyBreakdown ?? "—"}</td>
                <td class="sl-num text-right text-[var(--ink-mute)]">{target.numberOfPartners ?? "—"}</td>
                <td class="text-right">
                  {#if canWriteForChapter(target.chapterId)}
                    <div class="flex justify-end gap-2">
                      <button type="button" onclick={() => beginEdit(target)} class="sl-btn sl-btn-ghost">
                        Edit
                      </button>
                      <button type="button" onclick={() => deleteTarget(target)} class="sl-btn sl-btn-ghost" style="color:var(--bad)">
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
              <td colspan={9} class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
                No targets match the current filters.
              </td>
            </tr>
          {/if}
          {#if loading && targets.length === 0}
            <tr>
              <td colspan={9} class="py-12 text-center text-[13px] text-[var(--ink-mute)]">Loading…</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>

  {#if pageCount > 0 || offset > 0}
    <div class="sl-reveal sl-reveal-5 mt-4 flex items-center justify-between text-[13px] text-[var(--ink-mute)]">
      <span class="sl-mono text-[11.5px]" style="letter-spacing:0.04em">
        Showing rows {offset + 1}–{offset + pageCount}
        {#if hasMore}(more available){/if}
      </span>
      <div class="flex items-center gap-2">
        <button type="button" onclick={prevPage} disabled={offset === 0 || loading} class="sl-btn sl-btn-ghost">
          Previous
        </button>
        <button type="button" onclick={nextPage} disabled={!hasMore || loading} class="sl-btn sl-btn-ghost">
          Next
        </button>
      </div>
    </div>
  {/if}
</div>
