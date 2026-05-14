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

  let chapters = $state<Chapter[]>([]);
  let givingTypes = $state<GivingType[]>([]);
  let paymentMethods = $state<PaymentMethod[]>([]);
  let accounts = $state<Account[]>([]);

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

  let downloading = $state(false);
  let downloadError = $state<string | null>(null);

  /**
   * Fetch the Excel artefact and trigger a download via a blob URL.
   * We can't use `window.open` because the tenant middleware reads the
   * zone from the `x-stewardledger-zone-slug` header on the dev box
   * (and from the Host header in production); browser navigation
   * can't set custom headers. Fetching + saving keeps both dev and
   * prod paths on the same code.
   */
  async function downloadXlsx() {
    downloadController?.abort();
    const controller = new AbortController();
    downloadController = controller;
    downloading = true;
    downloadError = null;
    try {
      const params = currentParams();
      const headers = new Headers();
      const slug = localStorage.getItem("stewardledger.activeZoneSlug");
      if (slug) headers.set("x-stewardledger-zone-slug", slug);
      const res = await fetch(
        `${PUBLIC_API_URL}/api/tenant/reports/${reportId}/export.xlsx?${params.toString()}`,
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
      a.download = parseFilename(res.headers.get("content-disposition")) ?? `${reportId}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so Safari has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      downloadError = err instanceof Error ? err.message : "Download failed.";
    } finally {
      if (!controller.signal.aborted) downloading = false;
    }
  }

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
</script>

<div class="max-w-6xl mx-auto px-6 py-8">
  <div class="flex items-baseline justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight capitalize">
        {reportId.replaceAll("-", " ")}
      </h1>
      <p class="mt-1 text-sm text-slate-600">
        Filter, run, and download as Excel.
      </p>
    </div>
    <a href="/zone/reports" class="text-sm text-slate-600 hover:text-slate-900">← All reports</a>
  </div>

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
          {downloading ? "Downloading…" : "Download Excel"}
        </button>
      {/if}
    </div>
    <div aria-live="polite" class="mt-3 text-sm text-rose-700">
      {#if loadError}
        <p>{loadError}</p>
      {/if}
      {#if downloadError}
        <p>{downloadError}</p>
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
</div>
