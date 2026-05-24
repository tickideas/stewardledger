<script lang="ts">
  // Chapter-scoped imports. Forks /zone/imports but with the chapter pinned
  // to the sidebar's active chapter — chapter-scoped uploaders can't pick a
  // different chapter, so we hide the selector. The API enforces the same
  // rule server-side (`canWriteImport` requires the chapter to be in the
  // user's bindings), so this is UX, not security.
  //
  // Detail screens still live at /zone/imports/[id]; the row click takes
  // the user there so we don't fork the deep-detail flow yet.

  import { goto } from "$app/navigation";
  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { PUBLIC_API_URL } from "$lib/env";
  import { importTemplateHref } from "$lib/import-templates";
  import { statusBadgeClass } from "$lib/ui";

  type Job = {
    id: string;
    importFileId: string;
    status: string;
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    duplicateRows: number;
    failedRows: number;
    committedRows: number;
    startedAt: string | null;
    finishedAt: string | null;
    errorMessage: string | null;
    createdAt: string;
  };

  const chapter = useActiveChapter();

  let jobs = $state<Job[]>([]);
  let total = $state<number | null>(null);
  let status = $state("");
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let refreshToken = 0;

  let file = $state<File | null>(null);
  let fileType = $state<"statement">("statement");
  let sourceType = $state<"generic_csv" | "bank_csv" | "online_giving">("generic_csv");
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);

  const canSubmitUpload = $derived(Boolean(file) && !uploading && Boolean(chapter()));
  const chapterTemplateHref = importTemplateHref("chapter");

  async function refresh(signal: AbortSignal) {
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      // The list endpoint already filters to the user's accessible imports
      // server-side; for chapter-scoped users that's their own chapter.
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const res = await api.get<{ items: Job[]; total: number }>(
        `/api/tenant/imports?${params.toString()}`,
        signal,
      );
      if (my !== refreshToken) return;
      jobs = res.items;
      total = res.total;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load imports.";
    } finally {
      if (my === refreshToken) loading = false;
    }
  }

  $effect(() => {
    void status;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  });

  function onFileChange(evt: Event) {
    const input = evt.target as HTMLInputElement;
    file = input.files?.[0] ?? null;
  }

  async function submitUpload(evt: SubmitEvent) {
    evt.preventDefault();
    const here = chapter();
    if (!file || !here) return;
    uploading = true;
    uploadError = null;
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("fileType", fileType);
      form.set("sourceType", sourceType);
      form.set("chapterId", here.id);
      const headers = new Headers();
      const slug = localStorage.getItem("stewardledger.activeZoneSlug");
      if (slug) headers.set("x-stewardledger-zone-slug", slug);
      const res = await fetch(`${PUBLIC_API_URL}/api/tenant/imports`, {
        method: "POST",
        body: form,
        credentials: "include",
        headers,
      });
      const body = await res.json();
      if (!res.ok) {
        throw new ApiError(res.status, body?.error?.code ?? "unknown", body?.error?.message ?? res.statusText);
      }
      await goto(`/zone/imports/${body.importJobId}`);
    } catch (err) {
      uploadError = err instanceof ApiError ? err.message : "Upload failed.";
    } finally {
      uploading = false;
    }
  }
</script>

<svelte:head><title>Imports · {chapter()?.name ?? "Chapter"} · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Chapter pipeline · Imports</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      {chapter()?.name ?? "Chapter"} <span class="sl-serif-italic font-light text-[var(--brass-deep)]">imports</span>
    </h1>
    <p class="mt-2 max-w-2xl text-[14px] text-[var(--ink-mute)]">
      Upload your chapter's bank or online-giving exports. Each file is
      previewed and matched before any rows commit to the ledger.
    </p>
  </div>

  <!-- New upload. Same form-shaped wrapper as the zonal /zone/imports page
       (mirrors the "Filter bar" pattern on /zone/paying-in-books). -->
  <form onsubmit={submitUpload} class="sl-reveal sl-reveal-2 sl-card-warm mt-8 p-6">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end lg:grid-cols-4">
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">File</span>
        <input
          type="file"
          accept=".csv,.tsv"
          onchange={onFileChange}
          required
          class="mt-1.5 block w-full text-[12px] text-[var(--ink-mute)] file:mr-3 file:rounded-[2px] file:border file:border-[var(--rule-strong)] file:bg-[var(--card)] file:px-3 file:py-2 file:text-[12px] file:text-[var(--ink)] hover:file:bg-[var(--paper-soft)]"
        />
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">File type</span>
        <select bind:value={fileType} class="sl-select mt-1.5">
          <option value="statement">Bank statement</option>
        </select>
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Source</span>
        <select bind:value={sourceType} class="sl-select mt-1.5">
          <option value="generic_csv">Generic CSV</option>
          <option value="bank_csv">Bank CSV</option>
          <option value="online_giving">Online giving export</option>
        </select>
      </label>
      <div class="flex justify-end">
        <button type="submit" disabled={!canSubmitUpload} class="sl-btn sl-btn-primary">
          {uploading ? "Uploading…" : "Upload + parse"}
        </button>
      </div>
    </div>
    <p class="mt-3 text-[11px] text-[var(--ink-mute)]">
      Staged for {chapter()?.name ?? "this chapter"} only — files are reviewed before any rows commit.
    </p>
    <div class="mt-4 border-t border-[var(--rule)] pt-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span class="sl-eyebrow" style="font-size:10px">CSV template</span>
          <p class="mt-1 text-[12px] text-[var(--ink-mute)]">
            Chapter uploads use <span class="sl-mono">date, member reference, giving type code, amount, reference, currency, description</span>.
          </p>
        </div>
        <a href={chapterTemplateHref} download="stewardledger-chapter-import-template.csv" class="sl-btn sl-btn-ghost">
          Download template
        </a>
      </div>
    </div>
    {#if uploadError}
      <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{uploadError}</p>
    {/if}
  </form>

  <div class="sl-reveal sl-reveal-3 mt-8 flex flex-wrap items-center gap-3">
    <select bind:value={status} class="sl-select w-56">
      <option value="">All statuses</option>
      <option value="received">Received</option>
      <option value="parsed">Parsed</option>
      <option value="matched">Matched</option>
      <option value="scheduled">Scheduled</option>
      <option value="committed">Committed</option>
      <option value="failed">Failed</option>
      <option value="rolled_back">Rolled back</option>
    </select>
    {#if total !== null}
      <span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {total} {total === 1 ? "job" : "jobs"}
      </span>
    {/if}
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  <div class="sl-reveal mt-6 sl-card overflow-hidden">
    <table class="sl-table">
      <thead>
        <tr>
          <th>Created</th>
          <th>Status</th>
          <th class="!text-right">Rows</th>
          <th class="!text-right">Matched</th>
          <th class="!text-right">Failed</th>
          <th class="!text-right">Duplicates</th>
          <th class="!text-right">Committed</th>
        </tr>
      </thead>
      <tbody>
        {#each jobs as job (job.id)}
          <tr>
            <td>
              <a href={`/zone/imports/${job.id}`} class="sl-mono text-[12px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
                {new Date(job.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
              </a>
            </td>
            <td><span class={statusBadgeClass(job.status)}>{job.status.replace("_", " ")}</span></td>
            <td class="text-right sl-mono sl-num text-[var(--ink)]">{job.totalRows}</td>
            <td class="text-right sl-mono sl-num text-[var(--ink-soft)]">{job.matchedRows}</td>
            <td class="text-right sl-mono sl-num" style="color:var(--bad)">{job.failedRows}</td>
            <td class="text-right sl-mono sl-num" style="color:var(--warn)">{job.duplicateRows}</td>
            <td class="text-right sl-mono sl-num" style="color:var(--ok)">{job.committedRows}</td>
          </tr>
        {/each}
        {#if !loading && jobs.length === 0}
          <tr>
            <td colspan="7" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
              No imports yet. Upload a statement above to begin.
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
</div>
