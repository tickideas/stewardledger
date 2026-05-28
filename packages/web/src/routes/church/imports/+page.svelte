<!-- packages/web/src/routes/church/imports/+page.svelte -->
<!-- Chapter-scoped import dashboard for statements and envelope batches. -->
<!-- Exists so chapter uploaders can preview, schedule, and commit files within their active chapter. -->
<!-- RELEVANT FILES: packages/api/src/routes/tenant-imports.ts, packages/api/src/services/imports/index.ts, packages/web/src/lib/imports/template-download-centre.svelte -->

<script lang="ts">

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { PUBLIC_API_URL } from "$lib/env";
  import TemplateDownloadCentre from "$lib/imports/template-download-centre.svelte";
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

  type ServiceEvent = { id: string; chapterId: string | null; serviceTypeId: string; serviceDate: string };
  type ServiceType = { id: string; name: string };

  let jobs = $state<Job[]>([]);
  let total = $state<number | null>(null);
  let status = $state("");
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let refreshToken = 0;

  const initialFileType =
    page.url.searchParams.get("fileType") === "envelope_batch" ? "envelope_batch" : "statement";
  let file = $state<File | null>(null);
  let fileType = $state<"statement" | "envelope_batch">(initialFileType);
  let sourceType = $state<"generic_csv" | "bank_csv" | "online_giving" | "envelope_batch">(
    initialFileType === "envelope_batch" ? "envelope_batch" : "generic_csv",
  );
  let serviceEvents = $state<ServiceEvent[]>([]);
  let serviceTypes = $state<ServiceType[]>([]);
  let selectedServiceEventId = $state("");
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);

  const canSubmitUpload = $derived(Boolean(file) && !uploading && Boolean(chapter()) && Boolean(selectedServiceEventId));

  async function loadServiceEvents(chapterId: string, signal: AbortSignal) {
    try {
      const params = new URLSearchParams({ chapterId, limit: "100" });
      const [eventRes, serviceTypeRes] = await Promise.all([
        api.get<{ items: ServiceEvent[] }>(`/api/tenant/giving/service-events?${params.toString()}`, signal),
        api.get<{ items: ServiceType[] }>("/api/tenant/giving/service-types", signal),
      ]);
      serviceEvents = eventRes.items;
      serviceTypes = serviceTypeRes.items;
      selectedServiceEventId = "";
    } catch (err) {
      if (!isAbortError(err)) uploadError = err instanceof ApiError ? err.message : "Could not load service events.";
    }
  }

  async function refresh(signal: AbortSignal) {
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      // The list endpoint already filters to the user's accessible imports
      // server-side; for chapter-scoped users that's their own chapter.
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      params.set("fileType", fileType);
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
    void fileType;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  });

  $effect(() => {
    const here = chapter();
    if (!here) {
      serviceEvents = [];
      selectedServiceEventId = "";
      return;
    }
    const controller = new AbortController();
    loadServiceEvents(here.id, controller.signal);
    return () => controller.abort();
  });

  function onFileChange(evt: Event) {
    const input = evt.target as HTMLInputElement;
    file = input.files?.[0] ?? null;
  }

  function onFileTypeChange(evt: Event) {
    const next = (evt.target as HTMLSelectElement).value as "statement" | "envelope_batch";
    if (next === fileType) return;
    fileType = next;
    sourceType = next === "envelope_batch" ? "envelope_batch" : "generic_csv";
    file = null;
    uploadError = null;
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
      form.set("serviceEventId", selectedServiceEventId);
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

  function serviceEventLabel(event: ServiceEvent): string {
    const serviceType = serviceTypes.find((type) => type.id === event.serviceTypeId)?.name ?? "Service";
    return `${event.serviceDate} · ${serviceType}`;
  }
</script>

<svelte:head><title>Import contributions · {chapter()?.name ?? "Chapter"} · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Chapter ledger · Import contributions</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      Import <span class="sl-serif-italic font-light text-[var(--brass-deep)]">contributions</span>
    </h1>
    <p class="mt-2 max-w-2xl text-[14px] text-[var(--ink-mute)]">
      Upload your chapter's bank, online-giving, or envelope spreadsheet files.
      Each file is previewed and matched before it posts to the contribution ledger.
    </p>
  </div>

  <form onsubmit={submitUpload} class="sl-reveal sl-reveal-2 sl-card-warm mt-8 p-6">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12 lg:items-end">
      <label class="block lg:col-span-8">
        <span class="sl-eyebrow" style="font-size:10.5px">File</span>
        <input
          type="file"
          accept={fileType === "envelope_batch" ? ".csv" : ".csv,.tsv"}
          onchange={onFileChange}
          required
          class="mt-1.5 block w-full text-[12px] text-[var(--ink-mute)] file:mr-3 file:rounded-[2px] file:border file:border-[var(--rule-strong)] file:bg-[var(--card)] file:px-3 file:py-2 file:text-[12px] file:text-[var(--ink)] hover:file:bg-[var(--paper-soft)]"
        />
      </label>
      <label class="block lg:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">File type</span>
        <select value={fileType} onchange={onFileTypeChange} class="sl-select mt-1.5">
          <option value="statement">Bank statement</option>
          <option value="envelope_batch">Envelope spreadsheet</option>
        </select>
      </label>
      <label class="block lg:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Source</span>
        <select bind:value={sourceType} class="sl-select mt-1.5">
          {#if fileType === "envelope_batch"}
            <option value="envelope_batch">Envelope spreadsheet CSV</option>
          {:else}
            <option value="generic_csv">Generic CSV</option>
            <option value="bank_csv">Bank CSV</option>
            <option value="online_giving">Online giving export</option>
          {/if}
        </select>
      </label>
      <label class="block lg:col-span-5">
        <span class="sl-eyebrow" style="font-size:10.5px">Service event</span>
        <select bind:value={selectedServiceEventId} required class="sl-select mt-1.5">
          <option value="" disabled>Pick service event</option>
          {#each serviceEvents as event (event.id)}
            <option value={event.id}>{serviceEventLabel(event)}</option>
          {/each}
        </select>
      </label>
      <div class="flex sm:col-span-2 sm:justify-end lg:col-span-3">
        <button type="submit" disabled={!canSubmitUpload} class="sl-btn sl-btn-primary w-full justify-center sm:w-auto">
          {uploading ? "Uploading…" : "Upload + parse"}
        </button>
      </div>
    </div>
    <p class="mt-3 text-[11px] text-[var(--ink-mute)]">
      {#if fileType === "envelope_batch"}
        Envelope spreadsheets post as physical envelope contributions for {chapter()?.name ?? "this chapter"} after review.
      {:else}
        Staged for {chapter()?.name ?? "this chapter"} only. Pick the service event before upload so posted rows report against the right service.
      {/if}
    </p>
    {#if uploadError}
      <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{uploadError}</p>
    {/if}
  </form>

  <TemplateDownloadCentre surface="church" />

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
              No {fileType === "envelope_batch" ? "envelope spreadsheet imports" : "statement imports"} yet.
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
</div>
