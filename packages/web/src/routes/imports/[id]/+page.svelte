<script lang="ts">
  // Import job detail. Shows summary, per-row preview with failures, and
  // the operator buttons: Schedule (only when 0 failed), Commit (only
  // after schedule), Rollback (only after commit).

  import { page } from "$app/stores";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { formatMoney } from "@stewardledger/shared";

  type Job = {
    id: string;
    status: string;
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    duplicateRows: number;
    failedRows: number;
    committedRows: number;
    errorMessage: string | null;
    createdAt: string;
  };

  type ImportFile = {
    id: string;
    originalFileName: string;
    sizeBytes: number;
    checksumSha256: string;
    fileType: string;
    sourceType: string | null;
    uploadedAt: string;
  };

  // Mirrors the canonical `ParsedRow["parsed"]` shape on the server
  // (packages/api/src/services/imports/parsers.ts). Kept manual rather
  // than imported because `parsers.ts` lives behind the API package and
  // SvelteKit avoids reaching across the package boundary for types.
  type ImportRowParsed = {
    amount: string | null;
    contributionDate: string | null;
    memberReferenceCode: string | null;
    memberName: string | null;
    chapterReferenceCode: string | null;
    givingTypeName: string | null;
    givingTypeShortCode: string | null;
    givingCategoryName: string | null;
    externalTransactionId: string | null;
    currencyCode: string | null;
    paymentMethodCode: string | null;
    description: string | null;
  };

  type Row = {
    id: string;
    rowNumber: number;
    raw: Record<string, string>;
    parsed: ImportRowParsed;
    matchStatus: "pending" | "matched" | "partial" | "unmatched";
    validationStatus: "pending" | "valid" | "invalid";
    isDuplicate: boolean;
    currencyCode: string | null;
    failures: { code: string; details: unknown }[];
  };

  const importId = $derived($page.params.id);

  let job = $state<Job | null>(null);
  let file = $state<ImportFile | null>(null);
  let rows = $state<Row[]>([]);
  let rowTotal = $state<number | null>(null);
  let rowFilter = $state<"all" | "matched" | "unmatched" | "invalid" | "duplicate">("all");
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let busy = $state(false);
  let rollbackReason = $state("");
  let rollbackOpen = $state(false);

  async function loadAll(signal: AbortSignal) {
    loading = true;
    loadError = null;
    try {
      const detail = await api.get<{ job: Job; file: ImportFile }>(
        `/api/tenant/imports/${importId}`,
        signal,
      );
      job = detail.job;
      file = detail.file;
      const params = new URLSearchParams();
      if (rowFilter === "matched") params.set("matchStatus", "matched");
      else if (rowFilter === "unmatched") params.set("matchStatus", "unmatched");
      else if (rowFilter === "invalid") params.set("validationStatus", "invalid");
      else if (rowFilter === "duplicate") params.set("isDuplicate", "true");
      params.set("limit", "200");
      const rowRes = await api.get<{ items: Row[]; total: number }>(
        `/api/tenant/imports/${importId}/rows?${params.toString()}`,
        signal,
      );
      rows = rowRes.items;
      rowTotal = rowRes.total;
    } catch (err) {
      if (isAbortError(err)) return;
      loadError = err instanceof ApiError ? err.message : "Could not load.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void importId;
    void rowFilter;
    const controller = new AbortController();
    loadAll(controller.signal);
    return () => controller.abort();
  });

  async function doAction(path: string, body?: unknown) {
    busy = true;
    actionError = null;
    try {
      await api.post(path, body ?? {});
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Action failed.";
    } finally {
      busy = false;
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

  function rowBadge(r: Row): string {
    if (r.isDuplicate) return "bg-amber-100 text-amber-700";
    if (r.validationStatus === "invalid") return "bg-rose-100 text-rose-700";
    if (r.matchStatus === "matched") return "bg-green-100 text-green-700";
    return "bg-slate-100 text-slate-700";
  }

  function fmtParsedAmount(r: Row): string {
    const amount = r.parsed.amount;
    const currency = r.currencyCode;
    if (!amount || !currency) return amount ?? "—";
    try {
      return formatMoney({ amount, currency });
    } catch {
      return amount;
    }
  }
</script>

<div class="max-w-6xl mx-auto px-6 py-8">
  <div class="text-sm text-slate-500">
    <a href="/imports" class="hover:underline">← All imports</a>
  </div>

  {#if loadError}
    <p class="mt-4 text-sm text-red-600">{loadError}</p>
  {/if}

  {#if job && file}
    <div class="mt-2 flex items-baseline justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{file.originalFileName}</h1>
        <p class="mt-1 text-xs text-slate-500">
          {file.fileType} · {file.sourceType ?? "—"} · {file.sizeBytes} bytes ·
          {new Date(file.uploadedAt).toLocaleString()}
        </p>
        <p class="mt-1 text-xs font-mono text-slate-400">sha256: {file.checksumSha256}</p>
      </div>
      <span class={`inline-block px-2 py-1 rounded-full text-xs ${statusBadge(job.status)}`}>
        {job.status}
      </span>
    </div>

    <div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-6">
      <div class="rounded-lg border bg-white p-3">
        <div class="text-xs uppercase tracking-wide text-slate-500">Rows</div>
        <div class="mt-1 text-lg font-semibold text-slate-900">{job.totalRows}</div>
      </div>
      <div class="rounded-lg border bg-white p-3">
        <div class="text-xs uppercase tracking-wide text-slate-500">Matched</div>
        <div class="mt-1 text-lg font-semibold text-green-700">{job.matchedRows}</div>
      </div>
      <div class="rounded-lg border bg-white p-3">
        <div class="text-xs uppercase tracking-wide text-slate-500">Unmatched</div>
        <div class="mt-1 text-lg font-semibold text-slate-700">{job.unmatchedRows}</div>
      </div>
      <div class="rounded-lg border bg-white p-3">
        <div class="text-xs uppercase tracking-wide text-slate-500">Failed</div>
        <div class="mt-1 text-lg font-semibold text-rose-700">{job.failedRows}</div>
      </div>
      <div class="rounded-lg border bg-white p-3">
        <div class="text-xs uppercase tracking-wide text-slate-500">Duplicates</div>
        <div class="mt-1 text-lg font-semibold text-amber-700">{job.duplicateRows}</div>
      </div>
      <div class="rounded-lg border bg-white p-3">
        <div class="text-xs uppercase tracking-wide text-slate-500">Committed</div>
        <div class="mt-1 text-lg font-semibold text-green-700">{job.committedRows}</div>
      </div>
    </div>

    {#if job.errorMessage}
      <p class="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{job.errorMessage}</p>
    {/if}

    <div class="mt-6 flex flex-wrap gap-2">
      {#if job.status === "matched"}
        <button
          disabled={busy || job.failedRows > 0}
          onclick={() => doAction(`/api/tenant/imports/${job!.id}/schedule`)}
          class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          Schedule for commit
        </button>
        {#if job.failedRows > 0}
          <span class="text-xs text-rose-600 self-center">
            Resolve {job.failedRows} failed row{job.failedRows === 1 ? "" : "s"} first.
          </span>
        {/if}
      {/if}
      {#if job.status === "scheduled"}
        <button
          disabled={busy}
          onclick={() => doAction(`/api/tenant/imports/${job!.id}/commit`)}
          class="rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50"
        >
          Commit ({job.matchedRows - job.duplicateRows} contributions)
        </button>
      {/if}
      {#if job.status === "committed"}
        <button
          disabled={busy}
          onclick={() => (rollbackOpen = !rollbackOpen)}
          class="rounded-lg border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
        >
          Roll back
        </button>
      {/if}
    </div>

    {#if rollbackOpen && job.status === "committed"}
      <div class="mt-3 rounded-xl border bg-rose-50 p-4">
        <p class="text-sm font-medium text-rose-900">Reverse every contribution posted by this job.</p>
        <p class="mt-1 text-xs text-rose-700">
          Each contribution will be voided (audit-logged); the rollback frees the source rows so a
          corrected re-upload can replace them.
        </p>
        <input
          type="text"
          placeholder="Rollback reason (required)"
          bind:value={rollbackReason}
          class="mt-3 w-full rounded-lg border border-rose-200 px-3 py-2 text-sm"
        />
        <div class="mt-3 flex gap-2">
          <button
            disabled={busy || !rollbackReason.trim()}
            onclick={() =>
              doAction(`/api/tenant/imports/${job!.id}/rollback`, { reason: rollbackReason })}
            class="rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:opacity-50"
          >
            Confirm rollback
          </button>
          <button
            type="button"
            onclick={() => {
              rollbackOpen = false;
              rollbackReason = "";
            }}
            class="rounded-lg border px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    {#if actionError}
      <p class="mt-3 text-sm text-red-600">{actionError}</p>
    {/if}

    <div class="mt-8 flex items-baseline justify-between">
      <h2 class="text-lg font-medium">Rows</h2>
      <select bind:value={rowFilter} class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
        <option value="all">All rows</option>
        <option value="matched">Matched only</option>
        <option value="unmatched">Unmatched</option>
        <option value="invalid">Failed</option>
        <option value="duplicate">Duplicates</option>
      </select>
    </div>

    <table class="mt-3 w-full text-xs">
      <thead class="text-left uppercase tracking-wide text-slate-500 border-b">
        <tr>
          <th class="py-2">#</th>
          <th class="py-2">Date</th>
          <th class="py-2">Member</th>
          <th class="py-2">Giving type</th>
          <th class="py-2 text-right">Amount</th>
          <th class="py-2">External ref</th>
          <th class="py-2">Status</th>
          <th class="py-2">Notes</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        {#each rows as row (row.id)}
          <tr class="align-top hover:bg-slate-50">
            <td class="py-2 font-mono text-slate-400">{row.rowNumber}</td>
            <td class="py-2 text-slate-700">{row.parsed.contributionDate ?? "—"}</td>
            <td class="py-2 text-slate-700">
              {row.parsed.memberReferenceCode ?? row.parsed.memberName ?? "—"}
            </td>
            <td class="py-2 text-slate-700">
              {row.parsed.givingTypeShortCode ?? row.parsed.givingTypeName ?? "—"}
            </td>
            <td class="py-2 text-right font-mono text-slate-700">{fmtParsedAmount(row)}</td>
            <td class="py-2 font-mono text-slate-500">{row.parsed.externalTransactionId ?? "—"}</td>
            <td class="py-2">
              <span class={`inline-block px-2 py-0.5 rounded-full ${rowBadge(row)}`}>
                {row.isDuplicate ? "duplicate" : row.validationStatus === "invalid" ? "failed" : row.matchStatus}
              </span>
            </td>
            <td class="py-2 text-slate-500">
              {#each row.failures as f}
                <div class="text-rose-700">{f.code}</div>
              {/each}
              {#if row.failures.length === 0}—{/if}
            </td>
          </tr>
        {/each}
        {#if rows.length === 0}
          <tr><td colspan="8" class="py-6 text-center text-slate-500">No rows to display.</td></tr>
        {/if}
      </tbody>
    </table>
    {#if rowTotal !== null && rows.length < rowTotal}
      <p class="mt-2 text-xs text-slate-500">Showing {rows.length} of {rowTotal} rows.</p>
    {/if}
  {/if}
</div>
