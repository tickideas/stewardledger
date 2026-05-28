<!-- packages/web/src/lib/imports/template-download-centre.svelte -->
<!-- Renders one-click XLSX import-template downloads for import pages. -->
<!-- Keeps /zone/imports and /church/imports using the same template-centre UI. -->
<!-- RELEVANT FILES: packages/web/src/lib/import-templates.ts, packages/web/src/routes/zone/imports/+page.svelte, packages/web/src/routes/church/imports/+page.svelte -->
<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";
  import { downloadImportTemplate, type ImportTemplateSummary } from "$lib/import-templates";

  interface Props {
    surface: "zone" | "church";
  }

  let { surface }: Props = $props();

  let templates = $state<ImportTemplateSummary[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let downloadingKind = $state<string | null>(null);
  let downloadError = $state<string | null>(null);

  async function loadTemplates(signal: AbortSignal) {
    loading = true;
    loadError = null;
    try {
      const res = await api.get<{ items: ImportTemplateSummary[] }>(
        `/api/tenant/imports/templates?surface=${surface}`,
        signal,
      );
      templates = res.items;
    } catch (err) {
      if (!isAbortError(err)) loadError = err instanceof ApiError ? err.message : "Could not load import templates.";
    } finally {
      loading = false;
    }
  }

  async function download(kind: string) {
    downloadingKind = kind;
    downloadError = null;
    try {
      await downloadImportTemplate(kind);
    } catch (err) {
      downloadError = err instanceof Error ? err.message : "Template download failed.";
    } finally {
      downloadingKind = null;
    }
  }

  $effect(() => {
    void surface;
    const controller = new AbortController();
    loadTemplates(controller.signal);
    return () => controller.abort();
  });
</script>

<section class="sl-reveal sl-card mt-6 p-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <span class="sl-eyebrow" style="font-size:10px">XLSX templates</span>
      <h2 class="mt-2 sl-display text-[22px] leading-tight text-[var(--ink)]">Download empty templates</h2>
      <p class="mt-1 max-w-2xl text-[12.5px] text-[var(--ink-mute)]">
        {surface === "church"
          ? "Fill a branded sheet, save the import sheet in the format requested by the importer, then upload below for this chapter and service event."
          : "Use canonical XLSX headers for bank statements, online giving exports, and envelope batches."}
      </p>
    </div>
    {#if loading}
      <span class="sl-mono text-[11px] text-[var(--ink-mute)]">Loading…</span>
    {/if}
  </div>

  {#if loadError}
    <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if templates.length > 0}
    <div class="mt-4 grid gap-3 md:grid-cols-2">
      {#each templates as template (template.kind)}
        <article class="border border-[var(--rule)] bg-[var(--paper-soft)] p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-[14px] font-semibold text-[var(--ink)]">{template.title}</h3>
              <p class="mt-1 text-[12px] text-[var(--ink-mute)]">{template.description}</p>
            </div>
            <button
              type="button"
              class="sl-btn sl-btn-ghost shrink-0"
              disabled={downloadingKind === template.kind}
              onclick={() => download(template.kind)}
            >
              {downloadingKind === template.kind ? "Preparing…" : "Download"}
            </button>
          </div>
          <p class="mt-3 text-[11.5px] text-[var(--ink-mute)]">{template.uploadHint}</p>
          <p class="mt-2 sl-mono text-[10.5px] text-[var(--ink-mute)]">
            Required: {template.requiredColumns.join(", ")}
          </p>
        </article>
      {/each}
    </div>
  {:else if !loading}
    <p class="mt-3 text-[12px] text-[var(--ink-mute)]">No templates are registered yet.</p>
  {/if}

  {#if downloadError}
    <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{downloadError}</p>
  {/if}
</section>
