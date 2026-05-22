<script lang="ts">
  // Phase 7 — generic per-report page. Drives a filter form from the
  // report's column metadata, renders the row table from the data
  // endpoint, and offers an Excel download.
  //
  // The filter UI is intentionally minimal in PR-1: each registered
  // report exposes well-known filter keys (memberId, dateFrom/dateTo,
  // chapterId, isActive, status, importJobId) that this page maps to
  // input controls. Reports adding novel filters will surface them on
  // the filter form via a thin per-report dispatch when they land.

  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { PUBLIC_API_URL } from "$lib/env";

  type Column = {
    key: string;
    label: string;
    kind: "text" | "number" | "money" | "date" | "datetime";
    pii?: boolean;
  };
  type Subtotal = { currencyCode: string; total: string };
  type DataResponse = {
    reportId: string;
    filters: Record<string, unknown>;
    columns: Column[];
    rows: Array<Record<string, unknown>>;
    subtotals: Subtotal[];
    meta: Record<string, unknown> | null;
  };

  type Chapter = { id: string; referenceCode: string; name: string };
  type GivingType = { id: string; name: string; shortCode: string | null; isActive: boolean };
  type PaymentMethod = { id: string; code: string; name: string; isActive: boolean };
  type Account = { id: string; name: string; currencyCode: string };

  const reportId = $derived(page.params.id ?? "");

  let data = $state<DataResponse | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  // Persisted across re-submits so the previous run can be aborted
  // when the treasurer mashes "Run report" twice in a row.
  let runController: AbortController | null = null;
  let downloadController: AbortController | null = null;

  // Filter form state — superset across the registered reports. New
  // filters land here as new state vars + a SHAPES entry below.
  // Date defaults are evaluated at module load; that's fine for a
  // session-bound page, but a tab kept open past midnight would carry
  // a stale `today`. The reset happens on the next reload either way,
  // so it's an explicit not-yet-addressed product call rather than a
  // bug worth onMount-recomputing for a v1 export tool.
  let memberId = $state("");
  let dateFrom = $state(`${new Date().getFullYear()}-01-01`);
  let dateTo = $state(new Date().toISOString().slice(0, 10));
  let includeVoided = $state(false);
  let chapterId = $state("");
  let isActive = $state<"" | "true" | "false">("");
  let importJobId = $state("");
  let importStatus = $state("");
  let givingTypeId = $state("");
  let paymentMethodId = $state("");
  let pivotBy = $state<"givingType" | "category" | "month">("givingType");
  let ministryYearId = $state("");
  let partnershipYearId = $state("");
  let accountId = $state("");
  let sourceType = $state<"" | "envelope" | "online" | "bank_import" | "oblation" | "manual">("");
  let topN = $state(20);
  let partnershipOnly = $state(false);
  let actorUserId = $state("");
  let entityType = $state("");
  let entityId = $state("");
  let action = $state("");

  let chapters = $state<Chapter[]>([]);
  let givingTypes = $state<GivingType[]>([]);
  let paymentMethods = $state<PaymentMethod[]>([]);
  let accounts = $state<Account[]>([]);

  // Saved filters for this report. The picker is rendered as a row
  // of pills above the form; clicking one populates the form fields
  // by writing each known key back to its bound state.
  type SavedFilter = {
    id: string;
    name: string;
    filters: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };
  let savedFilters = $state<SavedFilter[]>([]);
  let savedFiltersError = $state<string | null>(null);
  let saveOpen = $state(false);
  let saveName = $state("");
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // Async export jobs for this report. Polled while any job is
  // queued / running; otherwise refreshed on-demand after a queue
  // action.
  type JobSummary = {
    id: string;
    reportId: string;
    format: "xlsx" | "pdf";
    status: "queued" | "running" | "completed" | "failed";
    rowCount: number | null;
    byteCount: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    expiresAt: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
  let jobs = $state<JobSummary[]>([]);
  let jobsError = $state<string | null>(null);
  let queueingFormat = $state<"xlsx" | "pdf" | null>(null);
  let queueError = $state<string | null>(null);

  // Map report id → which filter inputs to surface. Keeps the form
  // honest: the registry chooses what the report needs; this picks
  // which inputs render. Adding a report drops a new entry here.
  const SHAPES: Record<string, string[]> = {
    "member-statement": ["memberId", "dateFrom", "dateTo", "includeVoided"],
    "member-finance-summary": [
      "chapterId",
      "memberId",
      "dateFrom",
      "dateTo",
      "paymentMethodId",
      "givingTypeId",
    ],
    "import-reconciliation": ["importJobId", "dateFrom", "dateTo", "importStatus"],
    "member-list": ["chapterId", "isActive"],
    "giving-by-chapter": [
      "dateFrom",
      "dateTo",
      "pivotBy",
      "chapterId",
      "ministryYearId",
      "partnershipYearId",
    ],
    "general-ledger": [
      "dateFrom",
      "dateTo",
      "chapterId",
      "accountId",
      "givingTypeId",
      "paymentMethodId",
      "sourceType",
    ],
    "envelope-ledger": [
      "dateFrom",
      "dateTo",
      "chapterId",
      "memberId",
    ],
    "online-giving-ledger": [
      "dateFrom",
      "dateTo",
      "chapterId",
      "paymentMethodId",
      "givingTypeId",
      "accountId",
      "sourceType",
    ],
    "top-partners": [
      "dateFrom",
      "dateTo",
      "chapterId",
      "topN",
      "partnershipOnly",
    ],
    "top-chapters": [
      "dateFrom",
      "dateTo",
      "topN",
      "partnershipOnly",
    ],
    "audit-log": [
      "dateFrom",
      "dateTo",
      "actorUserId",
      "entityType",
      "entityId",
      "action",
    ],
    "weekly-finance": [
      "dateFrom",
      "dateTo",
      "chapterId",
    ],
    "partnership-progress": [
      "ministryYearId",
      "chapterId",
      "givingTypeId",
    ],
  };
  // Reports that hard-restrict source-type to a subset of the full
  // enum surface only their valid options. Server-side schemas
  // still reject mismatched values, but it's nicer UX to not even
  // show them.
  const onlineOnlySource = $derived(reportId === "online-giving-ledger");
  const visible = $derived(SHAPES[reportId] ?? []);

  $effect(() => {
    const controller = new AbortController();
    Promise.all([
      visible.includes("chapterId")
        ? api.get<{ items: Chapter[] }>("/api/tenant/chapters", controller.signal)
        : Promise.resolve({ items: [] }),
      visible.includes("givingTypeId")
        ? api.get<{ items: GivingType[] }>("/api/tenant/giving/types", controller.signal)
        : Promise.resolve({ items: [] }),
      visible.includes("paymentMethodId")
        ? api.get<{ items: PaymentMethod[] }>(
            "/api/tenant/giving/payment-methods",
            controller.signal,
          )
        : Promise.resolve({ items: [] }),
      visible.includes("accountId")
        ? api.get<{ items: Account[] }>("/api/tenant/giving/accounts", controller.signal)
        : Promise.resolve({ items: [] }),
    ])
      .then(([chapterRes, givingTypeRes, paymentMethodRes, accountRes]) => {
        chapters = chapterRes.items;
        givingTypes = givingTypeRes.items.filter((item) => item.isActive !== false);
        paymentMethods = paymentMethodRes.items.filter((item) => item.isActive !== false);
        accounts = accountRes.items;
      })
      .catch((err) => {
        if (!isAbortError(err)) {
          // Non-fatal — the report may not need setup lookups.
        }
      });
    return () => controller.abort();
  });

  function currentParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (visible.includes("memberId") && memberId) params.set("memberId", memberId);
    if (visible.includes("dateFrom") && dateFrom) params.set("dateFrom", dateFrom);
    if (visible.includes("dateTo") && dateTo) params.set("dateTo", dateTo);
    if (visible.includes("includeVoided")) params.set("includeVoided", String(includeVoided));
    if (visible.includes("chapterId") && chapterId) params.set("chapterId", chapterId);
    if (visible.includes("isActive") && isActive) params.set("isActive", isActive);
    if (visible.includes("importJobId") && importJobId) params.set("importJobId", importJobId);
    if (visible.includes("importStatus") && importStatus) params.set("status", importStatus);
    if (visible.includes("paymentMethodId") && paymentMethodId) params.set("paymentMethodId", paymentMethodId);
    if (visible.includes("givingTypeId") && givingTypeId) params.set("givingTypeId", givingTypeId);
    if (visible.includes("pivotBy")) params.set("pivotBy", pivotBy);
    if (visible.includes("ministryYearId") && ministryYearId)
      params.set("ministryYearId", ministryYearId);
    if (visible.includes("partnershipYearId") && partnershipYearId)
      params.set("partnershipYearId", partnershipYearId);
    if (visible.includes("accountId") && accountId) params.set("accountId", accountId);
    if (visible.includes("sourceType") && sourceType) params.set("sourceType", sourceType);
    if (visible.includes("topN")) params.set("topN", String(topN));
    if (visible.includes("partnershipOnly"))
      params.set("partnershipOnly", String(partnershipOnly));
    if (visible.includes("actorUserId") && actorUserId) params.set("actorUserId", actorUserId);
    if (visible.includes("entityType") && entityType) params.set("entityType", entityType);
    if (visible.includes("entityId") && entityId) params.set("entityId", entityId);
    if (visible.includes("action") && action) params.set("action", action);
    return params;
  }

  async function runReport(signal: AbortSignal) {
    loading = true;
    loadError = null;
    try {
      const params = currentParams();
      const res = await api.get<DataResponse>(
        `/api/tenant/reports/${reportId}/data?${params.toString()}`,
        signal,
      );
      if (signal.aborted) return;
      data = res;
    } catch (err) {
      if (isAbortError(err)) return;
      loadError = err instanceof ApiError ? err.message : "Could not run report.";
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  let downloadingFormat = $state<"xlsx" | "pdf" | null>(null);
  const downloading = $derived(downloadingFormat !== null);
  let downloadError = $state<string | null>(null);

  /**
   * Fetch a report artefact (Excel or PDF) and trigger a download
   * via a blob URL. We can't use `window.open` because the tenant
   * middleware reads the zone from the `x-stewardledger-zone-slug`
   * header on the dev box (and from the Host header in production);
   * browser navigation can't set custom headers. Fetching + saving
   * keeps both dev and prod paths on the same code.
   */
  async function downloadArtefact(format: "xlsx" | "pdf") {
    downloadController?.abort();
    const controller = new AbortController();
    downloadController = controller;
    downloadingFormat = format;
    downloadError = null;
    try {
      const params = currentParams();
      const headers = new Headers();
      const slug = localStorage.getItem("stewardledger.activeZoneSlug");
      if (slug) headers.set("x-stewardledger-zone-slug", slug);
      const res = await fetch(
        `${PUBLIC_API_URL}/api/tenant/reports/${reportId}/export.${format}?${params.toString()}`,
        { method: "GET", credentials: "include", headers, signal: controller.signal },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        parseFilename(res.headers.get("content-disposition")) ?? `${reportId}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so Safari has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      downloadError = err instanceof Error ? err.message : "Download failed.";
    } finally {
      if (!controller.signal.aborted) downloadingFormat = null;
    }
  }
  const downloadXlsx = () => downloadArtefact("xlsx");
  const downloadPdf = () => downloadArtefact("pdf");

  function parseFilename(disposition: string | null): string | null {
    if (!disposition) return null;
    // Anchor to `^filename=` or `;\s*filename=` so a future header
    // value like `inline; xfilename="..."` can't accidentally match.
    const match = /(?:^|;\s*)filename="?([^";]+)"?/i.exec(disposition);
    return match?.[1] ?? null;
  }

  function renderCell(value: unknown, col: Column): string {
    if (value === null || value === undefined) return "";
    if (col.kind === "money" && typeof value === "string") return value;
    if (col.kind === "datetime" && typeof value === "string") return value.replace("T", " ").replace(/\..*$/, "");
    return String(value);
  }

  function onSubmit(evt: SubmitEvent) {
    evt.preventDefault();
    runController?.abort();
    const controller = new AbortController();
    runController = controller;
    void runReport(controller.signal);
  }

  $effect(() => {
    return () => {
      runController?.abort();
      downloadController?.abort();
    };
  });

  // ─── Saved filters ──────────────────────────────────────────

  /**
   * Refresh the saved-filter list. Called on page load (per
   * report) and after each create / delete so the picker stays
   * in sync without a full page reload.
   */
  async function refreshSavedFilters(signal?: AbortSignal): Promise<void> {
    if (!reportId) return;
    savedFiltersError = null;
    try {
      const res = await api.get<{ items: SavedFilter[] }>(
        `/api/tenant/reports/${reportId}/saved-filters`,
        signal,
      );
      savedFilters = res.items;
    } catch (err) {
      if (isAbortError(err)) return;
      // Non-fatal — the rest of the page still works.
      savedFiltersError =
        err instanceof ApiError ? err.message : "Could not load saved filters.";
    }
  }

  $effect(() => {
    void reportId;
    const controller = new AbortController();
    void refreshSavedFilters(controller.signal);
    return () => controller.abort();
  });

  /**
   * Reset every filter input ahead of an `applySavedFilter` call so
   * fields not present in the saved payload don't carry over from
   * the user's prior tweaks. Each value below is deliberately the
   * *empty / neutral* state — NOT the page's first-load date
   * defaults (`${year}-01-01` / today). Recomputing those on every
   * apply would make a saved filter that omits `dateFrom` /
   * `dateTo` non-deterministic: the same pill click on different
   * days would produce different runs.
   *
   * `currentParams()` already drops empty strings so a missing
   * date here translates to a missing date in the next request,
   * which is what "the saved filter doesn't constrain on date"
   * means.
   */
  function resetFiltersToDefaults(): void {
    memberId = "";
    dateFrom = "";
    dateTo = "";
    includeVoided = false;
    chapterId = "";
    isActive = "";
    importJobId = "";
    importStatus = "";
    givingTypeId = "";
    paymentMethodId = "";
    pivotBy = "givingType";
    ministryYearId = "";
    partnershipYearId = "";
    accountId = "";
    sourceType = "";
    topN = 20;
    partnershipOnly = false;
    actorUserId = "";
    entityType = "";
    entityId = "";
    action = "";
  }

  /**
   * Mutate the form's bound state from a saved-filter payload.
   * Resets every input to its default first so keys omitted by
   * the saved payload don't carry over from the prior form state
   * — otherwise a treasurer applying "Annual 2024" after
   * tweaking `chapterId` would silently include the stale
   * chapterId in the next run.
   *
   * Booleans and numbers come back as their JS type (the API
   * stores parsed Zod output); strings are passed through.
   */
  function applySavedFilter(saved: SavedFilter): void {
    resetFiltersToDefaults();
    const f = saved.filters;
    const get = (k: string): unknown => f[k];
    if ("memberId" in f) memberId = String(get("memberId") ?? "");
    if ("dateFrom" in f) dateFrom = String(get("dateFrom") ?? "");
    if ("dateTo" in f) dateTo = String(get("dateTo") ?? "");
    if ("includeVoided" in f) includeVoided = Boolean(get("includeVoided"));
    if ("chapterId" in f) chapterId = String(get("chapterId") ?? "");
    if ("isActive" in f) {
      const v = get("isActive");
      isActive = v === true || v === "true" ? "true" : v === false || v === "false" ? "false" : "";
    }
    if ("importJobId" in f) importJobId = String(get("importJobId") ?? "");
    if ("status" in f) importStatus = String(get("status") ?? "");
    if ("paymentMethodId" in f) paymentMethodId = String(get("paymentMethodId") ?? "");
    if ("givingTypeId" in f) givingTypeId = String(get("givingTypeId") ?? "");
    if ("pivotBy" in f) {
      const v = String(get("pivotBy") ?? "givingType");
      pivotBy = v === "category" || v === "month" ? v : "givingType";
    }
    if ("ministryYearId" in f) ministryYearId = String(get("ministryYearId") ?? "");
    if ("partnershipYearId" in f)
      partnershipYearId = String(get("partnershipYearId") ?? "");
    if ("accountId" in f) accountId = String(get("accountId") ?? "");
    if ("sourceType" in f) {
      const v = String(get("sourceType") ?? "");
      sourceType = v === "" || v === "envelope" || v === "online" || v === "bank_import" || v === "oblation" || v === "manual"
        ? v
        : "";
    }
    if ("topN" in f) {
      const n = Number(get("topN"));
      if (Number.isFinite(n)) topN = n;
    }
    if ("partnershipOnly" in f) partnershipOnly = Boolean(get("partnershipOnly"));
    if ("actorUserId" in f) actorUserId = String(get("actorUserId") ?? "");
    if ("entityType" in f) entityType = String(get("entityType") ?? "");
    if ("entityId" in f) entityId = String(get("entityId") ?? "");
    if ("action" in f) action = String(get("action") ?? "");
  }

  /**
   * Build the filter payload to persist. We re-use `currentParams()`
   * so the saved shape is byte-identical to what the report would
   * see at run time — the API re-validates against the spec's Zod
   * schema, which expects parsed types (number / boolean) rather
   * than the URL-encoded string form. We coerce here for the keys
   * the schemas treat as non-string.
   */
  function snapshotFilters(): Record<string, unknown> {
    const params = currentParams();
    const out: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      if (key === "includeVoided" || key === "partnershipOnly") {
        out[key] = value === "true";
      } else if (key === "topN") {
        const n = Number(value);
        out[key] = Number.isFinite(n) ? n : value;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async function submitSave(evt: SubmitEvent): Promise<void> {
    evt.preventDefault();
    if (saving || !saveName.trim()) return;
    saving = true;
    saveError = null;
    try {
      await api.post<{ savedFilter: SavedFilter }>(
        `/api/tenant/reports/${reportId}/saved-filters`,
        { name: saveName.trim(), filters: snapshotFilters() },
      );
      saveName = "";
      saveOpen = false;
      await refreshSavedFilters();
    } catch (err) {
      saveError = err instanceof ApiError ? err.message : "Could not save.";
    } finally {
      saving = false;
    }
  }

  async function deleteSaved(saved: SavedFilter): Promise<void> {
    if (!confirm(`Delete saved filter "${saved.name}"?`)) return;
    try {
      await api.delete(`/api/tenant/reports/${reportId}/saved-filters/${saved.id}`);
      await refreshSavedFilters();
    } catch (err) {
      savedFiltersError =
        err instanceof ApiError ? err.message : "Could not delete.";
    }
  }

  // ─── Async export jobs ───────────────────────────────────────────

  async function refreshJobs(signal?: AbortSignal): Promise<void> {
    if (!reportId) return;
    jobsError = null;
    try {
      const res = await api.get<{ items: JobSummary[] }>(
        `/api/tenant/reports/jobs?reportId=${encodeURIComponent(reportId)}&limit=10`,
        signal,
      );
      jobs = res.items;
    } catch (err) {
      if (isAbortError(err)) return;
      jobsError = err instanceof ApiError ? err.message : "Could not load jobs.";
    }
  }

  $effect(() => {
    void reportId;
    const controller = new AbortController();
    void refreshJobs(controller.signal);
    return () => controller.abort();
  });

  // Poll while any job is in flight. The interval restarts whenever
  // `jobs` changes so a finished poll doesn't keep firing.
  $effect(() => {
    const inFlight = jobs.some(
      (j) => j.status === "queued" || j.status === "running",
    );
    if (!inFlight) return;
    const handle = setInterval(() => {
      void refreshJobs();
    }, 5_000);
    return () => clearInterval(handle);
  });

  async function queueJob(format: "xlsx" | "pdf"): Promise<void> {
    if (queueingFormat) return;
    queueingFormat = format;
    queueError = null;
    try {
      // Same coercions as the saved-filters path; keep them in
      // snapshotFilters() so queue + save can't drift.
      await api.post<{ job: JobSummary }>(
        `/api/tenant/reports/${reportId}/jobs`,
        { format, filters: snapshotFilters() },
      );
      await refreshJobs();
    } catch (err) {
      queueError = err instanceof ApiError ? err.message : "Could not queue.";
    } finally {
      queueingFormat = null;
    }
  }

  let downloadingJobId = $state<string | null>(null);
  let jobDownloadError = $state<string | null>(null);

  /**
   * Stream a queued-job artefact through `fetch` (with the tenant
   * zone slug header) and save it as a blob. A plain `<a href>`
   * would skip the `x-stewardledger-zone-slug` header that the
   * tenant middleware needs on the dev box, so the download would
   * 404 in environments where the zone is not resolved from Host.
   */
  async function downloadJobArtefact(job: JobSummary) {
    if (downloadingJobId) return;
    downloadingJobId = job.id;
    jobDownloadError = null;
    try {
      const headers = new Headers();
      const slug = localStorage.getItem("stewardledger.activeZoneSlug");
      if (slug) headers.set("x-stewardledger-zone-slug", slug);
      const res = await fetch(
        `${PUBLIC_API_URL}/api/tenant/reports/jobs/${job.id}/download`,
        { method: "GET", credentials: "include", headers },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        parseFilename(res.headers.get("content-disposition")) ??
        `${job.reportId}.${job.format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      jobDownloadError = err instanceof Error ? err.message : "Download failed.";
    } finally {
      downloadingJobId = null;
    }
  }

  function formatRelative(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    }).format(d);
  }
</script>

<div class="max-w-6xl mx-auto px-6 py-8">
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight capitalize">
        {reportId.replaceAll("-", " ")}
      </h1>
      <p class="mt-1 text-sm text-slate-600">
        Filter, run, and download as Excel or PDF.
      </p>
    </div>
    <a href="/zone/reports" class="text-sm text-slate-600 hover:text-slate-900">← All reports</a>
  </div>

  {#if savedFilters.length > 0 || savedFiltersError}
    <div class="mt-6 rounded-xl border bg-white p-4 shadow-sm">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-sm font-medium text-slate-900">Saved filters</h2>
        <span class="text-[11px] text-slate-500">
          Personal — visible only to you in this zone.
        </span>
      </div>
      {#if savedFiltersError}
        <p class="mt-2 text-[13px] text-rose-700">{savedFiltersError}</p>
      {/if}
      {#if savedFilters.length > 0}
        <div class="mt-3 flex flex-wrap gap-2">
          {#each savedFilters as saved (saved.id)}
            <span
              class="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 text-[12.5px] text-slate-700"
            >
              <button
                type="button"
                onclick={() => applySavedFilter(saved)}
                class="hover:text-slate-900"
                title="Apply these filters"
              >{saved.name}</button>
              <button
                type="button"
                onclick={() => deleteSaved(saved)}
                aria-label={`Delete ${saved.name}`}
                title={`Delete "${saved.name}"`}
                class="text-slate-400 hover:text-rose-700"
              >×</button>
            </span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <form onsubmit={onSubmit} class="mt-6 rounded-xl border bg-white p-5 shadow-sm">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-4">
      {#if visible.includes("memberId")}
        <label class="text-sm sm:col-span-2">
          <span class="block text-slate-600">Member ID</span>
          <input
            type="text"
            bind:value={memberId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="member uuid"
            required={reportId === "member-statement"}
          />
        </label>
      {/if}
      {#if visible.includes("dateFrom")}
        <label class="text-sm">
          <span class="block text-slate-600">From</span>
          <input
            type="date"
            bind:value={dateFrom}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      {/if}
      {#if visible.includes("dateTo")}
        <label class="text-sm">
          <span class="block text-slate-600">To</span>
          <input
            type="date"
            bind:value={dateTo}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      {/if}
      {#if visible.includes("includeVoided")}
        <label class="flex items-end text-sm">
          <input
            type="checkbox"
            bind:checked={includeVoided}
            class="mr-2 rounded"
          />
          <span>Include voided</span>
        </label>
      {/if}
      {#if visible.includes("chapterId")}
        <label class="text-sm">
          <span class="block text-slate-600">Chapter</span>
          <select
            bind:value={chapterId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All chapters in scope</option>
            {#each chapters as chapter (chapter.id)}
              <option value={chapter.id}>{chapter.referenceCode} · {chapter.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if visible.includes("isActive")}
        <label class="text-sm">
          <span class="block text-slate-600">Active</span>
          <select
            bind:value={isActive}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
        </label>
      {/if}
      {#if visible.includes("paymentMethodId")}
        <label class="text-sm">
          <span class="block text-slate-600">Payment method</span>
          <select
            bind:value={paymentMethodId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All methods</option>
            {#each paymentMethods as method (method.id)}
              <option value={method.id}>{method.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if visible.includes("givingTypeId")}
        <label class="text-sm">
          <span class="block text-slate-600">Giving type</span>
          <select
            bind:value={givingTypeId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All giving types</option>
            {#each givingTypes as type (type.id)}
              <option value={type.id}>{type.shortCode ? `${type.shortCode} · ${type.name}` : type.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if visible.includes("importJobId")}
        <label class="text-sm sm:col-span-2">
          <span class="block text-slate-600">Import job ID (optional)</span>
          <input
            type="text"
            bind:value={importJobId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="leave empty to use date range"
          />
        </label>
      {/if}
      {#if visible.includes("pivotBy")}
        <label class="text-sm">
          <span class="block text-slate-600">Pivot by</span>
          <select
            bind:value={pivotBy}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="givingType">Giving type</option>
            <option value="category">Category</option>
            <option value="month">Month</option>
          </select>
        </label>
      {/if}
      {#if visible.includes("ministryYearId")}
        <label class="text-sm">
          <span class="block text-slate-600">Ministry year ID (optional)</span>
          <input
            type="text"
            bind:value={ministryYearId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="clamp to a ministry year"
          />
        </label>
      {/if}
      {#if visible.includes("partnershipYearId")}
        <label class="text-sm">
          <span class="block text-slate-600">Partnership year ID (optional)</span>
          <input
            type="text"
            bind:value={partnershipYearId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="clamp to a partnership year"
          />
        </label>
      {/if}
      {#if visible.includes("topN")}
        <label class="text-sm">
          <span class="block text-slate-600">Top N</span>
          <input
            type="number"
            min="1"
            max="200"
            bind:value={topN}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      {/if}
      {#if visible.includes("partnershipOnly")}
        <label class="flex items-end text-sm">
          <input
            type="checkbox"
            bind:checked={partnershipOnly}
            class="mr-2 rounded"
          />
          <span>Partnership only</span>
        </label>
      {/if}
      {#if visible.includes("accountId")}
        <label class="text-sm">
          <span class="block text-slate-600">Account</span>
          <select
            bind:value={accountId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All accounts</option>
            {#each accounts as account (account.id)}
              <option value={account.id}>{account.name} ({account.currencyCode})</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if visible.includes("sourceType")}
        <label class="text-sm">
          <span class="block text-slate-600">Source</span>
          <select
            bind:value={sourceType}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All sources</option>
            {#if onlineOnlySource}
              <option value="online">Online</option>
              <option value="bank_import">Bank import</option>
            {:else}
              <option value="envelope">Envelope</option>
              <option value="online">Online</option>
              <option value="bank_import">Bank import</option>
              <option value="oblation">Oblation</option>
              <option value="manual">Manual</option>
            {/if}
          </select>
        </label>
      {/if}
      {#if visible.includes("actorUserId")}
        <label class="text-sm sm:col-span-2">
          <span class="block text-slate-600">Actor user ID</span>
          <input
            type="text"
            bind:value={actorUserId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="user id (optional)"
          />
        </label>
      {/if}
      {#if visible.includes("entityType")}
        <label class="text-sm">
          <span class="block text-slate-600">Entity type</span>
          <input
            type="text"
            bind:value={entityType}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="e.g. member, contribution"
          />
        </label>
      {/if}
      {#if visible.includes("entityId")}
        <label class="text-sm">
          <span class="block text-slate-600">Entity ID</span>
          <input
            type="text"
            bind:value={entityId}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="optional"
          />
        </label>
      {/if}
      {#if visible.includes("action")}
        <label class="text-sm">
          <span class="block text-slate-600">Action</span>
          <input
            type="text"
            bind:value={action}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="e.g. member.update"
          />
        </label>
      {/if}
      {#if visible.includes("importStatus")}
        <label class="text-sm">
          <span class="block text-slate-600">Status</span>
          <select
            bind:value={importStatus}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">Any</option>
            <option value="committed">Committed</option>
            <option value="scheduled">Scheduled</option>
            <option value="matched">Matched</option>
            <option value="failed">Failed</option>
            <option value="rolled_back">Rolled back</option>
          </select>
        </label>
      {/if}
    </div>
    <div class="mt-4 flex items-center gap-3">
      <button
        type="submit"
        disabled={loading}
        class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {loading ? "Running…" : "Run report"}
      </button>
      {#if data}
        <button
          type="button"
          onclick={downloadXlsx}
          disabled={downloading}
          class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          {downloadingFormat === "xlsx" ? "Downloading…" : "Download Excel"}
        </button>
        <button
          type="button"
          onclick={downloadPdf}
          disabled={downloading}
          class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          {downloadingFormat === "pdf" ? "Downloading…" : "Download PDF"}
        </button>
      {/if}
      <span class="ml-2 inline-flex items-center gap-2 text-[12px] text-slate-500">
        or generate in background:
      </span>
      <button
        type="button"
        onclick={() => void queueJob("xlsx")}
        disabled={queueingFormat !== null}
        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[13px] text-slate-700 hover:border-slate-400 disabled:opacity-50"
      >
        {queueingFormat === "xlsx" ? "Queueing…" : "Queue Excel"}
      </button>
      <button
        type="button"
        onclick={() => void queueJob("pdf")}
        disabled={queueingFormat !== null}
        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[13px] text-slate-700 hover:border-slate-400 disabled:opacity-50"
      >
        {queueingFormat === "pdf" ? "Queueing…" : "Queue PDF"}
      </button>
    </div>
    <div aria-live="polite" class="mt-3 text-sm text-rose-700">
      {#if loadError}
        <p>{loadError}</p>
      {/if}
      {#if downloadError}
        <p>{downloadError}</p>
      {/if}
      {#if queueError}
        <p>{queueError}</p>
      {/if}
    </div>

    <div class="mt-4 border-t border-slate-200 pt-4">
      {#if !saveOpen}
        <button
          type="button"
          onclick={() => {
            saveOpen = true;
            saveError = null;
          }}
          class="text-[13px] text-slate-600 hover:text-slate-900"
        >+ Save current filters as…</button>
      {:else}
        <!--
          Inline save form. Treated as a sub-form: we don't nest a
          <form> inside the main filter form (HTML doesn't allow it);
          instead we handle the click on the Save button and
          submitSave's own preventDefault is unused. Pressing Enter
          in the name field would submit the OUTER form (Run report),
          so we trap Enter explicitly.
        -->
        <div class="flex flex-wrap items-center gap-2">
          <input
            type="text"
            bind:value={saveName}
            placeholder="e.g. Monthly close"
            maxlength={80}
            disabled={saving}
            onkeydown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                void submitSave(new SubmitEvent("submit"));
              }
            }}
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-[13px]"
          />
          <button
            type="button"
            onclick={(ev) => {
              ev.preventDefault();
              void submitSave(new SubmitEvent("submit"));
            }}
            disabled={saving || !saveName.trim()}
            class="rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >{saving ? "Saving…" : "Save"}</button>
          <button
            type="button"
            onclick={() => {
              saveOpen = false;
              saveName = "";
              saveError = null;
            }}
            disabled={saving}
            class="text-[13px] text-slate-500 hover:text-slate-900"
          >Cancel</button>
          {#if saveError}
            <p class="text-[13px] text-rose-700">{saveError}</p>
          {/if}
        </div>
      {/if}
    </div>
  </form>

  {#if data}
    <div class="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
      <table class="min-w-full text-sm" aria-label="Report rows">
        <thead class="bg-slate-50 text-left text-slate-600">
          <tr>
            {#each data.columns as col (col.key)}
              <th class="px-3 py-2 font-medium">{col.label}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each data.rows as row, i (i)}
            <tr class="border-t">
              {#each data.columns as col (col.key)}
                <td class="px-3 py-2 align-top text-slate-800">
                  {renderCell(row[col.key], col)}
                </td>
              {/each}
            </tr>
          {/each}
          {#if data.rows.length === 0}
            <tr>
              <td colspan={data.columns.length} class="px-3 py-8 text-center text-slate-500">
                No rows match the current filters.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>

    {#if data.subtotals.length > 0}
      <div class="mt-4 rounded-xl border bg-white p-4 shadow-sm">
        <h2 class="text-sm font-semibold text-slate-900">Totals per currency</h2>
        <dl class="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {#each data.subtotals as sub (sub.currencyCode)}
            <div>
              <dt class="text-slate-600">{sub.currencyCode}</dt>
              <dd class="font-mono text-slate-900">{sub.total}</dd>
            </div>
          {/each}
        </dl>
      </div>
    {/if}
  {/if}

  {#if jobs.length > 0 || jobsError}
    <div class="mt-6 rounded-xl border bg-white p-4 shadow-sm">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-sm font-medium text-slate-900">My recent jobs</h2>
        <span class="text-[11px] text-slate-500">
          Background exports for this report. Queued / running rows refresh
          every 5 s.
        </span>
      </div>
      {#if jobsError}
        <p class="mt-2 text-[13px] text-rose-700">{jobsError}</p>
      {/if}
      {#if jobDownloadError}
        <p class="mt-2 text-[13px] text-rose-700">{jobDownloadError}</p>
      {/if}
      {#if jobs.length > 0}
        <ul class="mt-3 divide-y divide-slate-200">
          {#each jobs as job (job.id)}
            <li class="flex items-center justify-between gap-3 py-2 text-[13px]">
              <div class="flex items-baseline gap-2">
                <span class="font-mono uppercase text-slate-500">{job.format}</span>
                <span
                  class="rounded-full px-2 py-[1px] text-[11px]"
                  class:bg-slate-100={job.status === "queued"}
                  class:text-slate-600={job.status === "queued"}
                  class:bg-amber-100={job.status === "running"}
                  class:text-amber-800={job.status === "running"}
                  class:bg-emerald-100={job.status === "completed"}
                  class:text-emerald-800={job.status === "completed"}
                  class:bg-rose-100={job.status === "failed"}
                  class:text-rose-800={job.status === "failed"}
                >{job.status}</span>
                <span class="text-slate-500">{formatRelative(job.createdAt)}</span>
                {#if job.rowCount !== null}
                  <span class="text-slate-500">· {job.rowCount} rows</span>
                {/if}
                {#if job.errorMessage}
                  <span class="text-rose-700">— {job.errorMessage}</span>
                {/if}
              </div>
              <div class="flex items-center gap-3">
                {#if job.status === "completed"}
                  <button
                    type="button"
                    onclick={() => downloadJobArtefact(job)}
                    disabled={downloadingJobId === job.id}
                    class="text-slate-700 underline hover:text-slate-900 disabled:opacity-60"
                  >{downloadingJobId === job.id ? "Downloading…" : "Download"}</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
