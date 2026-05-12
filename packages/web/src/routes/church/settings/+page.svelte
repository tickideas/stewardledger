<script lang="ts">
  // Chapter settings. Today this is read-only: we surface the chapter's
  // registry record (reference code, country, start date) so chapter
  // admins can confirm what's on file. Editable settings — banking
  // defaults, roster invitations, batch templates — are deferred until the
  // API ships the corresponding PATCH endpoints.

  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";

  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
  };

  const active = useActiveChapter();

  let detail = $state<Chapter | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    const here = active();
    if (!here) {
      detail = null;
      return;
    }
    const controller = new AbortController();
    api
      .get<{ items: Chapter[] }>("/api/tenant/chapters", controller.signal)
      .then((res) => {
        detail = res.items.find((c) => c.id === here.id) ?? null;
        loadError = null;
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        loadError = err instanceof ApiError ? err.message : "Could not load chapter.";
      });
    return () => controller.abort();
  });
</script>

<svelte:head><title>Settings · {active()?.name ?? "Chapter"} · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <p class="sl-eyebrow" style="font-size:10.5px">§ Chapter VI · Admin</p>
    <h1 class="sl-display mt-2 text-[40px] leading-[1.05] tracking-tight text-[var(--ink)]">
      {active()?.name ?? "Chapter"} <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">settings</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Currency defaults, batch templates, banking references, and roster
      invitations for this chapter. Read-only for now.
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

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
        {#if detail.dateTo}
          <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
            <dt class="text-[var(--ink-mute)]">End date</dt>
            <dd class="sl-mono text-[12.5px] text-[var(--ink)]">{detail.dateTo}</dd>
          </div>
        {/if}
      </dl>
    </div>
  {/if}

  <div class="sl-reveal sl-reveal-3 mt-8 max-w-2xl rounded-[3px] border border-dashed border-[var(--rule-strong)] bg-[var(--card-warm)] px-5 py-4">
    <span class="sl-eyebrow">Coming next</span>
    <ul class="mt-3 space-y-1.5 text-[13px] text-[var(--ink-soft)]">
      <li>· Banking references and currency defaults</li>
      <li>· Batch templates (Sunday close, midweek, etc.)</li>
      <li>· Roster invitations and chapter-role assignments</li>
    </ul>
  </div>
</div>
