<!-- packages/web/src/routes/zone/partnership-progress/+page.svelte -->
<!-- Phase 8 — bespoke partnership-progress dashboard. -->
<!-- Reads the partnership-progress report endpoint and presents -->
<!-- per-target progress bars grouped by chapter. -->
<!-- RELEVANT FILES: packages/api/src/services/reports/partnership-progress.ts, packages/web/src/lib/partnership-progress/url.ts -->

<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";
  import { PUBLIC_API_URL } from "$lib/env";
  import { buildPartnershipProgressQuery } from "$lib/partnership-progress/url";

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

  type Row = {
    chapterReferenceCode: string | null;
    chapterName: string;
    givingTypeShortCode: string | null;
    givingTypeName: string;
    ministryYearLabel: string;
    currencyCode: string;
    fullTarget: string;
    monthlyTarget: string | null;
    weeklyBreakdown: string | null;
    achieved: string;
    percentProgress: string;
    weeklyAverageActual: string;
    monthlyAverageActual: string;
    projectedFullYear: string;
    fullTargetCopies: number | null;
    numberOfPartners: number | null;
  };
  type DataResponse = {
    reportId: string;
    rows: Row[];
  };

  let chapters = $state<Chapter[]>([]);
  let givingTypes = $state<GivingType[]>([]);
  let ministryYears = $state<MinistryYear[]>([]);
  let ministryYearId = $state("");
  let chapterFilter = $state("");
  let givingTypeFilter = $state("");
  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let refreshToken = 0;

  // Bootstrap: load dropdown sources + pick the current ministry
  // year (the one whose [start, end] window contains today). If
  // none match, fall back to the most recent year.
  async function loadBootstrap(signal: AbortSignal) {
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const [chapterRes, givingTypeRes, ministryYearRes] = await Promise.all([
        api.get<{ items: Chapter[] }>("/api/tenant/chapters", signal),
        api.get<{ items: GivingType[] }>("/api/tenant/giving/types", signal),
        api.get<{ items: MinistryYear[] }>(
          "/api/tenant/periods/ministry-years",
          signal,
        ),
      ]);
      if (my !== refreshToken) return;
      chapters = chapterRes.items;
      givingTypes = givingTypeRes.items.filter(
        (g) => g.hasPartnershipTarget && g.isActive,
      );
      ministryYears = ministryYearRes.items;
      const today = new Date().toISOString().slice(0, 10);
      const current = ministryYears.find(
        (y) => y.startDate <= today && today <= y.endDate,
      );
      const fallback = ministryYears.length > 0 ? ministryYears[ministryYears.length - 1] : null;
      const picked = current ?? fallback;
      if (picked && ministryYearId === "") ministryYearId = picked.id;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load filters.";
    } finally {
      if (!signal.aborted && my === refreshToken) loading = false;
    }
  }

  async function loadRows(signal: AbortSignal) {
    if (ministryYearId === "") {
      rows = [];
      return;
    }
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const query = buildPartnershipProgressQuery({
        ministryYearId,
        chapterId: chapterFilter,
        givingTypeId: givingTypeFilter,
      });
      const res = await api.get<DataResponse>(
        `/api/tenant/reports/partnership-progress/data?${query}`,
        signal,
      );
      if (my !== refreshToken) return;
      rows = res.rows;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError =
        err instanceof ApiError ? err.message : "Could not load partnership progress.";
    } finally {
      if (!signal.aborted && my === refreshToken) loading = false;
    }
  }

  // First effect: load filter sources once.
  $effect(() => {
    const controller = new AbortController();
    loadBootstrap(controller.signal);
    return () => controller.abort();
  });

  // Second effect: re-run the report whenever filters change.
  $effect(() => {
    const controller = new AbortController();
    void ministryYearId;
    void chapterFilter;
    void givingTypeFilter;
    loadRows(controller.signal);
    return () => controller.abort();
  });

  // Group rows by chapter for the card layout. Zone-wide targets
  // (chapter_reference_code = null) collect under a synthetic
  // "Zone-wide" group rendered first. The group key is the chapter
  // reference code (unique per zone) — not the display name, which
  // can collide when two chapters happen to share a name.
  type Group = { key: string; label: string; subLabel: string; rows: Row[] };
  const grouped = $derived<Group[]>((() => {
    const byKey = new Map<string, Group>();
    for (const row of rows) {
      const isZoneWide = row.chapterReferenceCode === null;
      const key = isZoneWide ? "__zone__" : row.chapterReferenceCode!;
      const label = isZoneWide ? "Zone-wide targets" : row.chapterName;
      const subLabel = isZoneWide ? "Applies to every chapter" : row.chapterReferenceCode!;
      const bucket = byKey.get(key) ?? { key, label, subLabel, rows: [] };
      bucket.rows.push(row);
      byKey.set(key, bucket);
    }
    // Zone-wide first, then chapters by ref code.
    const zone = byKey.get("__zone__");
    const others = Array.from(byKey.entries())
      .filter(([k]) => k !== "__zone__")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, g]) => g);
    return zone ? [zone, ...others] : others;
  })());

  const totalTargets = $derived(rows.length);
  const ministryYearLabel = $derived(
    ministryYears.find((y) => y.id === ministryYearId)?.yearLabel ?? "",
  );

  function formatMoney(amount: string, currencyCode: string): string {
    // Render with the user's locale but force the currency the
    // target was set in — partnership-progress can carry per-row
    // currencies and the dashboard must not collapse them to a
    // single locale default.
    try {
      const num = Number(amount);
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
        currencyDisplay: "code",
      }).format(num);
    } catch {
      return `${currencyCode} ${amount}`;
    }
  }

  function percentNumeric(percentDisplay: string): number {
    // The report formats percent as e.g. "47.3%" or "999.9%".
    const trimmed = percentDisplay.replace("%", "").trim();
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 0;
  }

  function progressBarWidth(percentDisplay: string): string {
    // Cap the visual bar at 100% so a 200%-progress target doesn't
    // blow out the layout. The textual "% progress" still shows
    // the true value.
    const n = percentNumeric(percentDisplay);
    const capped = Math.max(0, Math.min(100, n));
    return `${capped.toFixed(1)}%`;
  }

  function progressBarColor(percentDisplay: string): string {
    const n = percentNumeric(percentDisplay);
    if (n >= 100) return "var(--brass-deep)";
    if (n >= 66) return "var(--brass)";
    if (n >= 33) return "var(--ink-mute)";
    return "var(--bad)";
  }

  function givingTypeLabel(row: Row): string {
    return row.givingTypeShortCode
      ? `${row.givingTypeShortCode} · ${row.givingTypeName}`
      : row.givingTypeName;
  }

  const exportHref = $derived(() => {
    if (ministryYearId === "") return "";
    const query = buildPartnershipProgressQuery({
      ministryYearId,
      chapterId: chapterFilter,
      givingTypeId: givingTypeFilter,
    });
    return `${PUBLIC_API_URL}/api/tenant/reports/partnership-progress/export.xlsx?${query}`;
  });
</script>

<svelte:head><title>Partnership progress · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Insight · Partnership progress</span>
    <h1 class="mt-3 sl-display text-[52px] leading-[1] text-[var(--ink)]">
      Partnership
      <span class="sl-serif-italic font-light text-[var(--brass-deep)]">progress</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[15px] text-[var(--ink-mute)]">
      Target vs achieved for partnership-tagged giving types in the
      selected ministry year. Zone-wide targets aggregate every
      chapter's contributions; chapter-scoped targets read only their
      chapter's totals.
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
        <span class="block text-slate-600">Ministry year</span>
        <select
          bind:value={ministryYearId}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="" disabled>Select a year</option>
          {#each ministryYears as y (y.id)}
            <option value={y.id}>{y.yearLabel}</option>
          {/each}
        </select>
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">Chapter</span>
        <select
          bind:value={chapterFilter}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">All chapters</option>
          {#each chapters as chapter (chapter.id)}
            <option value={chapter.id}>{chapter.referenceCode} · {chapter.name}</option>
          {/each}
        </select>
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">Giving type</span>
        <select
          bind:value={givingTypeFilter}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">All partnership types</option>
          {#each givingTypes as g (g.id)}
            <option value={g.id}>
              {g.shortCode ? `${g.shortCode} · ${g.name}` : g.name}
            </option>
          {/each}
        </select>
      </label>
      <div class="flex items-end justify-end">
        {#if exportHref()}
          <a
            href={exportHref()}
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:border-slate-400"
            download
          >
            Download .xlsx
          </a>
        {/if}
      </div>
    </div>
  </div>

  {#if loading && rows.length === 0}
    <p class="sl-reveal sl-reveal-3 mt-6 text-[13px] text-slate-500">Loading…</p>
  {:else if ministryYearId === ""}
    <p class="sl-reveal sl-reveal-3 mt-6 text-[13px] text-slate-500">
      Select a ministry year to see progress.
    </p>
  {:else if rows.length === 0}
    <div class="sl-reveal sl-reveal-3 mt-6 rounded-xl border bg-white p-6 text-center text-[13px] text-slate-500 shadow-sm">
      No partnership targets for {ministryYearLabel}
      {#if chapterFilter}in the selected chapter{/if}
      {#if givingTypeFilter}for the selected type{/if}.
      Set targets on <a href="/zone/targets" class="underline">/zone/targets</a>
      to populate this dashboard.
    </div>
  {:else}
    <!-- Header summary. -->
    <div class="sl-reveal sl-reveal-3 mt-8 text-[13px] text-[var(--ink-mute)]">
      <span class="sl-mono">{totalTargets}</span> target{totalTargets === 1 ? "" : "s"}
      · {ministryYearLabel}
    </div>

    <!-- One card per group; one row per target inside. -->
    <div class="sl-reveal sl-reveal-4 mt-4 space-y-6">
      {#each grouped as group (group.key)}
        <section class="sl-card rounded-xl border bg-white p-5 shadow-sm">
          <header class="flex items-baseline justify-between gap-3 border-b pb-3">
            <div>
              <h2 class="text-[18px] font-medium text-[var(--ink)]">{group.label}</h2>
              <p class="mt-0.5 text-[12px] text-[var(--ink-mute)]">{group.subLabel}</p>
            </div>
            <span class="sl-mono text-[12px] text-[var(--ink-mute)]">
              {group.rows.length} target{group.rows.length === 1 ? "" : "s"}
            </span>
          </header>

          <div class="mt-4 space-y-5">
            {#each group.rows as row, i (i)}
              <div>
                <div class="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <div class="text-[var(--ink)]">{givingTypeLabel(row)}</div>
                  <div class="sl-mono text-[13px] text-[var(--ink)]">
                    {row.percentProgress}
                  </div>
                </div>
                <!-- Progress bar. -->
                <div
                  class="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--paper-soft)]"
                  role="progressbar"
                  aria-valuenow={Math.max(
                    0,
                    Math.min(100, percentNumeric(row.percentProgress)),
                  )}
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuetext={row.percentProgress}
                  aria-label="{givingTypeLabel(row)} progress"
                >
                  <div
                    class="h-full rounded-full transition-all"
                    style="width: {progressBarWidth(row.percentProgress)}; background-color: {progressBarColor(
                      row.percentProgress,
                    )};"
                  ></div>
                </div>
                <!-- Detail grid. -->
                <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-4">
                  <div>
                    <dt class="text-[var(--ink-mute)]">Achieved</dt>
                    <dd class="sl-num mt-0.5 text-[var(--ink)]">
                      {formatMoney(row.achieved, row.currencyCode)}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-[var(--ink-mute)]">Target</dt>
                    <dd class="sl-num mt-0.5 text-[var(--ink)]">
                      {formatMoney(row.fullTarget, row.currencyCode)}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-[var(--ink-mute)]">Weekly avg</dt>
                    <dd class="sl-num mt-0.5 text-[var(--ink-mute)]">
                      {formatMoney(row.weeklyAverageActual, row.currencyCode)}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-[var(--ink-mute)]">Projected EOY</dt>
                    <dd class="sl-num mt-0.5 text-[var(--ink-mute)]">
                      {formatMoney(row.projectedFullYear, row.currencyCode)}
                    </dd>
                  </div>
                  {#if row.numberOfPartners !== null}
                    <div>
                      <dt class="text-[var(--ink-mute)]">Partners</dt>
                      <dd class="sl-num mt-0.5 text-[var(--ink-mute)]">
                        {row.numberOfPartners}
                      </dd>
                    </div>
                  {/if}
                  {#if row.fullTargetCopies !== null}
                    <div>
                      <dt class="text-[var(--ink-mute)]">Target copies</dt>
                      <dd class="sl-num mt-0.5 text-[var(--ink-mute)]">
                        {row.fullTargetCopies}
                      </dd>
                    </div>
                  {/if}
                </dl>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>
