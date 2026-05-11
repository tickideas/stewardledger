<script lang="ts">
  // Phase 6 — import dashboard. Lists every job for the active zone with
  // status filtering, links into per-job detail, and offers the new-upload
  // form inline. Uploading drops the user straight onto the new job's
  // detail page where they can review failures, correct the source CSV
  // if needed, schedule, and commit.

  import { goto } from "$app/navigation";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { PUBLIC_API_URL } from "$lib/env";
  import { CHAPTER_ROLES, ZONE_ROLES, type AuthorizedContext } from "@stewardledger/shared";

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

  let jobs = $state<Job[]>([]);
  let total = $state<number | null>(null);
  let status = $state("");
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  // Plain mutable counter — not reactive on purpose. The effect closure
  // captures it as a last-request-wins token; using `$state` would
  // schedule an extra re-render on every fetch.
  let refreshToken = 0;

  // Upload form state.
  let file = $state<File | null>(null);
  let fileType = $state<"statement">("statement");
  let sourceType = $state<"generic_csv" | "bank_csv" | "online_giving">("generic_csv");
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);

  type Chapter = { id: string; referenceCode: string; name: string };
  let auth = $state<AuthorizedContext | null>(null);
  let chapters = $state<Chapter[]>([]);
  let selectedChapterId = $state("");

  const zoneWriteRoles = new Set<string>([
    ZONE_ROLES.ZONE_OWNER,
    ZONE_ROLES.ZONE_ADMIN,
    ZONE_ROLES.ZONE_FINANCE_ADMIN,
  ]);
  const chapterWriteRoles = new Set<string>([
    CHAPTER_ROLES.CHAPTER_ADMIN,
    CHAPTER_ROLES.CHAPTER_TREASURER,
    CHAPTER_ROLES.CHAPTER_BOOKKEEPER,
  ]);
  const canZoneWideUpload = $derived(auth?.roleCodes.some((r) => zoneWriteRoles.has(r)) ?? false);
  const canChapterUpload = $derived(auth?.roleCodes.some((r) => chapterWriteRoles.has(r)) ?? false);
  const selectableChapters = $derived(
    canZoneWideUpload
      ? chapters
      : chapters.filter((chapter) => auth?.chapterIds.includes(chapter.id)),
  );
  const canSubmitUpload = $derived(
    Boolean(file) &&
      !uploading &&
      (canZoneWideUpload || (canChapterUpload && Boolean(selectedChapterId))),
  );

  async function loadUploadContext(signal: AbortSignal) {
    const [me, chapterRes] = await Promise.all([
      api.get<{ auth: AuthorizedContext }>("/api/tenant/me", signal),
      api.get<{ items: Chapter[] }>("/api/tenant/chapters", signal),
    ]);
    auth = me.auth;
    chapters = chapterRes.items;
    const allowed = me.auth.roleCodes.some((r) => zoneWriteRoles.has(r))
      ? chapterRes.items
      : chapterRes.items.filter((chapter) => me.auth.chapterIds.includes(chapter.id));
    if (!me.auth.roleCodes.some((r) => zoneWriteRoles.has(r)) && allowed.length === 1) {
      selectedChapterId = allowed[0].id;
    }
  }

  async function refresh(signal: AbortSignal) {
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
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
    const controller = new AbortController();
    loadUploadContext(controller.signal).catch((err) => {
      if (!isAbortError(err)) uploadError = err instanceof ApiError ? err.message : "Could not load chapters.";
    });
    return () => controller.abort();
  });

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
    if (!file) return;
    uploading = true;
    uploadError = null;
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("fileType", fileType);
      form.set("sourceType", sourceType);
      if (selectedChapterId) form.set("chapterId", selectedChapterId);
      // We use fetch directly (not `api.post`) because multipart bodies
      // shouldn't get a JSON content-type header. PUBLIC_API_URL is the
      // canonical env reference — the previous `VITE_PUBLIC_API_URL`
      // typo silently broke production builds where the API runs on a
      // different host than the SvelteKit app.
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
      await goto(`/imports/${body.importJobId}`);
    } catch (err) {
      uploadError = err instanceof ApiError ? err.message : "Upload failed.";
    } finally {
      uploading = false;
    }
  }

  function statusBadge(s: string): string {
    switch (s) {
      case "committed":
        return "bg-green-100 text-green-700";
      case "scheduled":
        return "bg-blue-100 text-blue-700";
      case "matched":
        return "bg-amber-100 text-amber-700";
      case "failed":
        return "bg-rose-100 text-rose-700";
      case "rolled_back":
        return "bg-slate-200 text-slate-700";
      default:
        return "bg-slate-100 text-slate-700";
    }
  }
</script>

<div class="max-w-6xl mx-auto px-6 py-8">
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Imports</h1>
      <p class="mt-1 text-sm text-slate-600">
        Bank statements and online-giving exports. Preview, schedule, commit, and rollback CSV imports.
      </p>
    </div>
  </div>

  <form onsubmit={submitUpload} class="mt-6 rounded-xl border bg-white p-5 shadow-sm">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-5">
      <label class="text-sm">
        <span class="block text-slate-600">File</span>
        <input
          type="file"
          accept=".csv,.tsv"
          onchange={onFileChange}
          class="mt-1 w-full text-sm"
          required
        />
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">File type</span>
        <select bind:value={fileType} class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
          <option value="statement">Bank statement</option>
        </select>
        <span class="mt-1 block text-xs text-slate-500">Member, target, and setup imports are deferred.</span>
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">Source</span>
        <select bind:value={sourceType} class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
          <option value="generic_csv">Generic CSV</option>
          <option value="bank_csv">Bank CSV</option>
          <option value="online_giving">Online giving export</option>
        </select>
        <span class="mt-1 block text-xs text-slate-500">Export spreadsheets as CSV before upload.</span>
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">Chapter</span>
        <select bind:value={selectedChapterId} class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
          {#if canZoneWideUpload}
            <option value="">Zone-wide / file includes chapter column</option>
          {/if}
          {#each selectableChapters as chapter (chapter.id)}
            <option value={chapter.id}>{chapter.referenceCode} · {chapter.name}</option>
          {/each}
        </select>
        {#if !canZoneWideUpload}
          <span class="mt-1 block text-xs text-slate-500">Required for chapter-scoped uploaders.</span>
        {/if}
      </label>
      <div class="flex items-end">
        <button
          type="submit"
          disabled={!canSubmitUpload}
          class="w-full inline-flex justify-center items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Upload + parse"}
        </button>
      </div>
    </div>
    {#if uploadError}
      <p class="mt-3 text-sm text-red-600">{uploadError}</p>
    {/if}
  </form>

  <div class="mt-6 flex gap-3 items-center">
    <select bind:value={status} class="rounded-lg border border-slate-300 px-3 py-2 text-sm">
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
      <span class="text-xs text-slate-500">{total} jobs</span>
    {/if}
  </div>

  {#if loadError}
    <p class="mt-4 text-sm text-red-600">{loadError}</p>
  {/if}

  <table class="mt-4 w-full text-sm">
    <thead class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
      <tr>
        <th class="py-2">Created</th>
        <th class="py-2">Status</th>
        <th class="py-2 text-right">Rows</th>
        <th class="py-2 text-right">Matched</th>
        <th class="py-2 text-right">Failed</th>
        <th class="py-2 text-right">Duplicates</th>
        <th class="py-2 text-right">Committed</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-slate-200">
      {#each jobs as job (job.id)}
        <tr class="hover:bg-slate-50">
          <td class="py-3 text-xs text-slate-500">
            <a href={`/imports/${job.id}`} class="hover:underline">
              {new Date(job.createdAt).toLocaleString()}
            </a>
          </td>
          <td class="py-3">
            <span class={`inline-block px-2 py-0.5 rounded-full text-xs ${statusBadge(job.status)}`}>
              {job.status}
            </span>
          </td>
          <td class="py-3 text-right font-mono text-slate-700">{job.totalRows}</td>
          <td class="py-3 text-right font-mono text-slate-700">{job.matchedRows}</td>
          <td class="py-3 text-right font-mono text-rose-700">{job.failedRows}</td>
          <td class="py-3 text-right font-mono text-amber-700">{job.duplicateRows}</td>
          <td class="py-3 text-right font-mono text-green-700">{job.committedRows}</td>
        </tr>
      {/each}
      {#if !loading && jobs.length === 0}
        <tr>
          <td colspan="7" class="py-8 text-center text-sm text-slate-500">
            No imports yet. Upload a statement above to begin.
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
</div>
