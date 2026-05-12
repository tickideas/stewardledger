<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";

  type Summary = { id: string; title: string; description: string };

  let items = $state<Summary[]>([]);
  let loadError = $state<string | null>(null);

  $effect(() => {
    const controller = new AbortController();
    api
      .get<{ items: Summary[] }>("/api/tenant/reports", controller.signal)
      .then((res) => {
        items = res.items;
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        loadError = err instanceof ApiError ? err.message : "Could not load reports.";
      });
    return () => controller.abort();
  });
</script>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Output · Reports</span>
    <h1 class="mt-3 sl-display text-[52px] leading-[1] text-[var(--ink)]">
      Reports <span class="sl-serif-italic font-light text-[var(--brass-deep)]">library</span>
    </h1>
    <p class="mt-3 max-w-xl text-[15px] text-[var(--ink-mute)]">
      Statement, ledger, and member reports. Excel exports for now;
      PDF lands in a follow-up. Every report is server-driven — adding one
      on the API automatically lights it up here.
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  <div class="sl-reveal sl-reveal-2 mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
    {#each items as report, i (report.id)}
      <a
        href={`/zone/reports/${report.id}`}
        class="group sl-card relative block overflow-hidden p-6 transition-all duration-200 hover:-translate-y-0.5"
        style={`animation: sl-fade-up 700ms cubic-bezier(0.2,0.7,0.2,1) both; animation-delay: ${i * 70}ms; box-shadow: var(--shadow-card)`}
      >
        <span
          class="sl-mono absolute right-5 top-5 text-[10.5px] text-[var(--ink-faint)]"
          style="letter-spacing:0.1em"
        >
          № {String(i + 1).padStart(2, "0")}
        </span>
        <span class="sl-eyebrow">Report</span>
        <h2 class="mt-3 sl-display text-[22px] leading-tight text-[var(--ink)] group-hover:text-[var(--brass-deep)]">
          {report.title}
        </h2>
        <div class="mt-3 h-px w-10 bg-[var(--brass)] transition-all duration-300 group-hover:w-20"></div>
        <p class="mt-4 text-[13.5px] leading-relaxed text-[var(--ink-mute)]">{report.description}</p>
        <div class="mt-6 flex items-center gap-2 text-[12px] text-[var(--ink)]">
          <span>Open</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" class="transition-transform duration-200 group-hover:translate-x-1">
            <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </a>
    {/each}
    {#if items.length === 0 && !loadError}
      <div class="col-span-full sl-card flex flex-col items-center justify-center p-16 text-center">
        <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">∅</span>
        <p class="mt-4 sl-display text-[18px] italic text-[var(--ink)]">No reports registered.</p>
      </div>
    {/if}
  </div>
</div>
