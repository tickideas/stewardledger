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
        return "sl-badge-ok";
      case "scheduled":
        return "sl-badge-info";
      case "matched":
        return "sl-badge-warn";
      case "failed":
        return "sl-badge-bad";
      case "rolled_back":
        return "sl-badge-mute";
      default:
        return "sl-badge-mute";
    }
  }

  function rowBadge(r: Row): string {
    if (r.isDuplicate) return "sl-badge-warn";
    if (r.validationStatus === "invalid") return "sl-badge-bad";
    if (r.matchStatus === "matched") return "sl-badge-ok";
    return "sl-badge-mute";
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

<svelte:head><title>Import job · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <a href="/zone/imports" class="sl-btn sl-btn-ghost">← All imports</a>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  {#if job && file}
    <div class="sl-reveal sl-reveal-1 mt-4 flex flex-wrap items-end justify-between gap-6">
      <div>
        <span class="sl-eyebrow">§ Pipeline · Import job</span>
        <h1 class="mt-3 sl-display text-[36px] leading-[1] text-[var(--ink)]">{file.originalFileName}</h1>
        <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">
          {file.fileType} · {file.sourceType ?? "—"} · {file.sizeBytes} bytes ·
          {new Date(file.uploadedAt).toLocaleString()}
        </p>
        <p class="mt-1 sl-mono text-[11px] text-[var(--ink-faint)]">sha256: {file.checksumSha256}</p>
      </div>
      <span class={`sl-badge ${statusBadge(job.status)}`}>{job.status}</span>
    </div>

    <div class="sl-reveal sl-reveal-2 mt-8 grid grid-cols-2 gap-4 sm:grid-cols-6">
      <div class="sl-card p-4">
        <div class="sl-eyebrow" style="font-size:10px">Rows</div>
        <div class="sl-num mt-1 sl-display text-[22px] text-[var(--ink)]">{job.totalRows}</div>
      </div>
      <div class="sl-card p-4">
        <div class="sl-eyebrow" style="font-size:10px">Matched</div>
        <div class="sl-num mt-1 sl-display text-[22px]" style="color:var(--ok)">{job.matchedRows}</div>
      </div>
      <div class="sl-card p-4">
        <div class="sl-eyebrow" style="font-size:10px">Unmatched</div>
        <div class="sl-num mt-1 sl-display text-[22px] text-[var(--ink-soft)]">{job.unmatchedRows}</div>
      </div>
      <div class="sl-card p-4">
        <div class="sl-eyebrow" style="font-size:10px">Failed</div>
        <div class="sl-num mt-1 sl-display text-[22px]" style="color:var(--bad)">{job.failedRows}</div>
      </div>
      <div class="sl-card p-4">
        <div class="sl-eyebrow" style="font-size:10px">Duplicates</div>
        <div class="sl-num mt-1 sl-display text-[22px]" style="color:var(--warn)">{job.duplicateRows}</div>
      </div>
      <div class="sl-card p-4">
        <div class="sl-eyebrow" style="font-size:10px">Committed</div>
        <div class="sl-num mt-1 sl-display text-[22px]" style="color:var(--ok)">{job.committedRows}</div>
      </div>
    </div>

    {#if job.errorMessage}
      <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{job.errorMessage}</p>
    {/if}

    <div class="mt-6 flex flex-wrap items-center gap-3">
      {#if job.status === "matched"}
        <button disabled={busy || job.failedRows > 0} onclick={() => doAction(`/api/tenant/imports/${job!.id}/schedule`)} class="sl-btn sl-btn-primary">
          Schedule for commit
        </button>
        {#if job.failedRows > 0}
          <span class="text-[12px] text-[var(--bad)]">
            Resolve {job.failedRows} failed row{job.failedRows === 1 ? "" : "s"} first.
          </span>
        {/if}
      {/if}
      {#if job.status === "scheduled"}
        <button disabled={busy} onclick={() => doAction(`/api/tenant/imports/${job!.id}/commit`)} class="sl-btn sl-btn-accent">
          Commit ({job.matchedRows - job.duplicateRows} contributions)
        </button>
      {/if}
      {#if job.status === "committed"}
        <button disabled={busy} onclick={() => (rollbackOpen = !rollbackOpen)} class="sl-btn sl-btn-danger-ghost">
          Roll back
        </button>
      {/if}
    </div>

    {#if rollbackOpen && job.status === "committed"}
      <div class="sl-reveal mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] p-5">
        <p class="text-[14px] font-medium" style="color:var(--bad)">Reverse every contribution posted by this job.</p>
        <p class="mt-1 text-[12.5px]" style="color:var(--bad)">
          Each contribution will be voided (audit-logged); the rollback frees the source rows so a
          corrected re-upload can replace them.
        </p>
        <input
          type="text"
          placeholder="Rollback reason (required)"
          bind:value={rollbackReason}
          class="sl-input mt-3"
        />
        <div class="mt-3 flex gap-2">
          <button
            disabled={busy || !rollbackReason.trim()}
            onclick={() => doAction(`/api/tenant/imports/${job!.id}/rollback`, { reason: rollbackReason })}
            class="sl-btn sl-btn-danger"
          >
            Confirm rollback
          </button>
          <button
            type="button"
            onclick={() => { rollbackOpen = false; rollbackReason = ""; }}
            class="sl-btn sl-btn-ghost"
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    {#if actionError}
      <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{actionError}</p>
    {/if}

    <div class="sl-reveal sl-reveal-3 mt-10">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Rows</span>
        <select bind:value={rowFilter} class="sl-select w-48">
          <option value="all">All rows</option>
          <option value="matched">Matched only</option>
          <option value="unmatched">Unmatched</option>
          <option value="invalid">Failed</option>
          <option value="duplicate">Duplicates</option>
        </select>
      </div>
      <div class="sl-card overflow-x-auto">
        <table class="sl-table text-[12.5px]">
          <thead>
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Member</th>
              <th>Giving type</th>
              <th class="!text-right">Amount</th>
              <th>External ref</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.id)}
              <tr>
                <td class="sl-mono text-[var(--ink-faint)]">{row.rowNumber}</td>
                <td class="sl-mono text-[var(--ink-soft)]">{row.parsed.contributionDate ?? "—"}</td>
                <td>{row.parsed.memberReferenceCode ?? row.parsed.memberName ?? "—"}</td>
                <td>{row.parsed.givingTypeShortCode ?? row.parsed.givingTypeName ?? "—"}</td>
                <td class="sl-num text-right text-[var(--ink)]">{fmtParsedAmount(row)}</td>
                <td class="sl-mono text-[var(--ink-mute)]">{row.parsed.externalTransactionId ?? "—"}</td>
                <td>
                  <span class={`sl-badge ${rowBadge(row)}`}>
                    {row.isDuplicate ? "duplicate" : row.validationStatus === "invalid" ? "failed" : row.matchStatus}
                  </span>
                </td>
                <td class="text-[var(--ink-mute)]">
                  {#each row.failures as f}
                    <div style="color:var(--bad)">{f.code}</div>
                  {/each}
                  {#if row.failures.length === 0}—{/if}
                </td>
              </tr>
            {/each}
            {#if rows.length === 0}
              <tr><td colspan="8" class="py-10 text-center text-[var(--ink-mute)]">No rows to display.</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
      {#if rowTotal !== null && rows.length < rowTotal}
        <p class="mt-2 text-[11.5px] text-[var(--ink-mute)]">Showing {rows.length} of {rowTotal} rows.</p>
      {/if}
    </div>
  {/if}
</div>
