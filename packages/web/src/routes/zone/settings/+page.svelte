<!-- packages/web/src/routes/zone/settings/+page.svelte -->
<!-- Phase 9 — zone-owner settings: retention policy + per-zone export bundle. -->
<!-- The retention panel is read-everywhere-admin / write-owner-only; the -->
<!-- export panel is owner-only end to end. -->
<!-- RELEVANT FILES: packages/api/src/routes/tenant-zones.ts, packages/api/src/routes/tenant-exports.ts, packages/web/src/lib/retention/access.ts, packages/web/src/lib/exports/access.ts -->

<script lang="ts">
  import { api, ApiError, currentZoneSlug, isAbortError } from "$lib/api";
  import { canRequestExport } from "$lib/exports/access";
  import {
    canEditRetention,
    canReadRetention,
  } from "$lib/retention/access";
  import {
    DEFAULT_RETENTION_POLICY,
    RETENTION_DIMENSIONS,
    type AuthorizedContext,
    type RetentionDimension,
    type ZoneRetentionPolicy,
  } from "@stewardledger/shared";

  // ─── Auth resolution ─────────────────────────────────────────────────
  // Same pattern as `/zone/audit`: hit `/api/tenant/me` once on mount,
  // gate every panel off the resolved `AuthorizedContext`. Failure to
  // resolve is distinct from "no permission" so the access-denied card
  // doesn't mask a session/network outage.
  let auth = $state<AuthorizedContext | null>(null);
  let authLoaded = $state(false);
  let authError = $state<string | null>(null);

  const canRead = $derived(canReadRetention(auth));
  const canWrite = $derived(canEditRetention(auth));
  const canExport = $derived(canRequestExport(auth));

  async function loadAuth(signal: AbortSignal) {
    try {
      const me = await api.get<{ auth: AuthorizedContext }>(
        "/api/tenant/me",
        signal,
      );
      auth = me.auth;
      authError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      authError = err instanceof ApiError ? err.message : "Could not load session.";
      auth = null;
    } finally {
      if (!signal.aborted) authLoaded = true;
    }
  }

  // ─── Retention panel ────────────────────────────────────────────────
  //
  // Form state is the hydrated effective shape; server-defaulted dimensions
  // render as the constant from `@stewardledger/shared`. The Save button
  // PUTs the merged shape — the API merges onto prior state, but sending
  // the full effective shape keeps the wire payload self-describing.
  const DIMENSION_META: Record<
    RetentionDimension,
    { label: string; description: string; neverPurgeNote?: string }
  > = {
    audit_events: {
      label: "Audit log",
      description:
        "How long to keep audit-event rows before they are permanently deleted. Default: 5 years (1825 days).",
    },
    import_files: {
      label: "Uploaded import files",
      description:
        "How long to keep the raw bank-statement / CSV bytes in object storage. The parsed rows live longer. Default: 1 year (365 days).",
    },
    import_rows: {
      label: "Parsed import rows",
      description:
        "How long to keep the per-row parse output for completed imports. Non-terminal jobs are always protected. Default: 90 days.",
    },
    report_jobs: {
      label: "Report job artefacts",
      description:
        "How long the downloadable report bundles (Excel/PDF) stay available before cleanup tombstones them. Default: 7 days.",
    },
    member_soft_deletes: {
      label: "Soft-deleted members",
      description:
        "How long soft-deleted member rows are kept before the GDPR purge runs. Set 0 to never purge.",
      neverPurgeNote: "Setting 0 keeps soft-deleted members indefinitely.",
    },
  };

  let policy = $state<ZoneRetentionPolicy | null>(null);
  let policyDraft = $state<Record<RetentionDimension, number>>({
    audit_events: 0,
    import_files: 0,
    import_rows: 0,
    report_jobs: 0,
    member_soft_deletes: 0,
  });
  let policyLoadError = $state<string | null>(null);
  let policySaveError = $state<string | null>(null);
  let policySavedFlash = $state<string | null>(null);
  let policySaving = $state(false);
  // Tracked so the lifecycle teardown effect can clear it; otherwise a
  // quick nav-away mid-flash would try to mutate state on an unmounted
  // component when the timer fires.
  let policyFlashTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadPolicy(signal?: AbortSignal) {
    try {
      const res = await api.get<{ policy: ZoneRetentionPolicy }>(
        "/api/tenant/zones/retention-policy",
        signal,
      );
      policy = res.policy;
      seedDraft(res.policy);
      policyLoadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      policyLoadError =
        err instanceof ApiError ? err.message : "Could not load retention policy.";
    }
  }

  function seedDraft(p: ZoneRetentionPolicy) {
    for (const dim of RETENTION_DIMENSIONS) {
      policyDraft[dim] = p[dim].retainDays;
    }
  }

  const policyDirty = $derived.by(() => {
    if (!policy) return false;
    return RETENTION_DIMENSIONS.some(
      (dim) => policyDraft[dim] !== policy![dim].retainDays,
    );
  });

  const policyMatchesDefaults = $derived(
    RETENTION_DIMENSIONS.every(
      (dim) =>
        policyDraft[dim] === DEFAULT_RETENTION_POLICY[dim].retainDays,
    ),
  );

  function restoreDefaults() {
    if (!policy) return;
    for (const dim of RETENTION_DIMENSIONS) {
      policyDraft[dim] = DEFAULT_RETENTION_POLICY[dim].retainDays;
    }
  }

  async function savePolicy(e: SubmitEvent) {
    e.preventDefault();
    if (!canWrite) return;
    policySaving = true;
    policySaveError = null;
    policySavedFlash = null;
    try {
      // Send the full effective shape. The API merges onto stored
      // state and compacts before persisting; sending every dimension
      // keeps the wire payload self-describing for the audit row.
      const payload = Object.fromEntries(
        RETENTION_DIMENSIONS.map((dim) => [
          dim,
          { retainDays: policyDraft[dim] },
        ]),
      );
      const res = await api.put<{ policy: ZoneRetentionPolicy }>(
        "/api/tenant/zones/retention-policy",
        payload,
      );
      policy = res.policy;
      seedDraft(res.policy);
      policySavedFlash = "Retention policy saved.";
      if (policyFlashTimer) clearTimeout(policyFlashTimer);
      policyFlashTimer = setTimeout(() => {
        policySavedFlash = null;
        policyFlashTimer = null;
      }, 4000);
    } catch (err) {
      policySaveError =
        err instanceof ApiError ? err.message : "Could not save retention policy.";
    } finally {
      policySaving = false;
    }
  }

  // ─── Export panel ───────────────────────────────────────────────────
  type ExportSummary = {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "expired";
    byteCount: number | null;
    tableCount: number | null;
    fileCount: number | null;
    artefactCount: number | null;
    sha256: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    expiresAt: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    emailSentAt: string | null;
    requestedByUserId: string | null;
  };

  let exports = $state<ExportSummary[]>([]);
  let exportsLoadError = $state<string | null>(null);
  let exportRequestError = $state<string | null>(null);
  let exportRequesting = $state(false);
  let copiedSha = $state<string | null>(null);
  // Download is a native browser flow via a hidden <a> link — the
  // browser handles the save dialog + bytes-to-disk. There's no
  // JS-observable failure event for a same-origin download, so
  // upstream errors (expired / 4xx) surface as the browser's own
  // error UI rather than a panel-level message. The spinner is
  // cleared on a short timer below.
  let downloadingExportId = $state<string | null>(null);

  // Auto-refresh while any export is non-terminal so the badge / size
  // catches up without the owner reloading.
  //
  // `pollController` owns the lifetime of every polled fetch: each
  // `loadExports` call passes its signal so a quick nav-away aborts
  // the in-flight request instead of resolving against an unmounted
  // page (which would briefly surface state on the wrong route).
  // The lifecycle teardown effect aborts + nulls the controller.
  //
  // Polling cadence is anchored in `finally` so a transient API
  // error (network blip, 503) doesn't permanently strand the
  // owner watching a `running` bundle — the next tick still fires.
  let pollHandle: ReturnType<typeof setTimeout> | null = null;
  let pollController: AbortController | null = null;
  const TERMINAL = new Set(["completed", "failed", "expired"]);
  const POLL_INTERVAL_MS = 5000;

  function hasInFlight(rows: ExportSummary[]): boolean {
    return rows.some((r) => !TERMINAL.has(r.status));
  }

  function schedulePoll() {
    if (pollHandle) {
      clearTimeout(pollHandle);
      pollHandle = null;
    }
    if (!hasInFlight(exports)) return;
    if (pollController === null || pollController.signal.aborted) return;
    pollHandle = setTimeout(() => {
      void loadExports(pollController?.signal);
    }, POLL_INTERVAL_MS);
  }

  async function loadExports(signal?: AbortSignal) {
    if (!canExport) return;
    try {
      const res = await api.get<{ exports: ExportSummary[] }>(
        "/api/tenant/zones/exports?limit=10",
        signal,
      );
      exports = res.exports;
      exportsLoadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      exportsLoadError =
        err instanceof ApiError ? err.message : "Could not load export bundles.";
    } finally {
      if (!signal?.aborted) schedulePoll();
    }
  }

  async function requestExport() {
    if (!canExport) return;
    exportRequesting = true;
    exportRequestError = null;
    try {
      const res = await api.post<{ export: ExportSummary }>(
        "/api/tenant/zones/exports",
        {},
      );
      // Optimistically prepend; the next poll reconciles.
      exports = [res.export, ...exports];
      schedulePoll();
    } catch (err) {
      if (err instanceof ApiError && err.code === "rate_limited") {
        const cooldownUntil =
          (err.details?.cooldownUntil as string | undefined) ?? null;
        exportRequestError = cooldownUntil
          ? `An export was generated in the last 24h. Try again after ${formatRelativeDateTime(cooldownUntil)}.`
          : err.message;
      } else {
        exportRequestError =
          err instanceof ApiError ? err.message : "Could not request export.";
      }
    } finally {
      exportRequesting = false;
    }
  }

  async function copySha(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      copiedSha = value;
      setTimeout(() => {
        if (copiedSha === value) copiedSha = null;
      }, 1500);
    } catch {
      // Clipboard permission can be denied; ignore — the value is
      // visible inline so the user can copy manually.
    }
  }

  /**
   * Trigger a download via the same-origin SvelteKit proxy at
   * `/zone/settings/exports/:id/download/+server.ts`. The proxy
   * pipes the upstream `ReadableStream` straight to the browser
   * with `Content-Disposition: attachment`, so the browser's
   * native download path streams to disk — the page never
   * materialises the (potentially multi-GB) `.tar.gz` in JS heap.
   *
   * Routing through the same origin also avoids the
   * `x-stewardledger-zone-slug` resolution drift the Codex bot
   * flagged: we pass the active slug as a query param, and the
   * proxy reads its own `Host` header (production) or forwards the
   * header for split-host dev. Both cases stay in sync with
   * `currentZoneSlug()` from `$lib/api`.
   *
   * Use a hidden `<a>` element rather than navigating the page
   * (`window.location.href`) so a 4xx upstream (expired /
   * not_ready) doesn't replace the settings UI with a JSON error
   * blob. The browser fires the download via the `attachment`
   * Content-Disposition header without unmounting the page; on a
   * 4xx the browser surfaces its own error UI and the settings
   * page stays interactive.
   */
  function downloadExport(row: ExportSummary) {
    if (row.status !== "completed") return;
    downloadingExportId = row.id;
    const slug = currentZoneSlug();
    const params = new URLSearchParams();
    if (slug) params.set("zone", slug);
    const href = `/zone/settings/exports/${encodeURIComponent(row.id)}/download${
      params.toString() ? `?${params.toString()}` : ""
    }`;
    // A hidden link rather than `window.location.href` keeps the
    // settings page mounted and lets the browser stream the file
    // directly to disk via the attachment Content-Disposition.
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // We don't get a completion event for a native download, but
    // clearing the spinner immediately is a worse UX than leaving
    // it briefly active. Tuck the reset behind a short timeout so
    // a slow connection still shows the spinner long enough to
    // confirm the action took effect.
    setTimeout(() => {
      if (downloadingExportId === row.id) downloadingExportId = null;
    }, 1500);
  }

  function formatBytes(n: number | null): string {
    if (n === null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatDateTime(iso: string | null): string {
    if (!iso) return "—";
    return iso.replace("T", " ").replace(/\..*$/, "");
  }

  function formatRelativeDateTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function statusLabel(status: ExportSummary["status"]): string {
    switch (status) {
      case "queued":
        return "Queued";
      case "running":
        return "Running";
      case "completed":
        return "Ready";
      case "failed":
        return "Failed";
      case "expired":
        return "Expired";
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────
  $effect(() => {
    const controller = new AbortController();
    void loadAuth(controller.signal);
    return () => controller.abort();
  });

  // Re-fetch panels once auth resolves so each gated request fires with
  // a known role context instead of racing the /me response. The export
  // panel's initial load + every subsequent poll share `pollController`
  // so unmount aborts both in flight and any future poll tick. The
  // retention flash timer is cleared in the same teardown so a
  // mid-flash nav-away can't update state on an unmounted page.
  $effect(() => {
    if (!authLoaded || !auth) return;
    const controller = new AbortController();
    pollController = new AbortController();
    if (canRead) void loadPolicy(controller.signal);
    if (canExport) void loadExports(pollController.signal);
    return () => {
      controller.abort();
      pollController?.abort();
      pollController = null;
      if (pollHandle) {
        clearTimeout(pollHandle);
        pollHandle = null;
      }
      if (policyFlashTimer) {
        clearTimeout(policyFlashTimer);
        policyFlashTimer = null;
      }
    };
  });
</script>

<svelte:head><title>Zone settings · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Zone administration</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      Zone <span class="sl-serif-italic font-light text-[var(--brass-deep)]">settings</span>
    </h1>
    <p class="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Control how long this zone's data is kept and generate a complete
      archive for backup or migration.
    </p>
  </div>

  {#if authError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
      {authError}
    </p>
  {/if}

  {#if authLoaded && !authError && !canRead && !canExport}
    <p class="mt-6 sl-card-warm px-4 py-3 text-[13px] text-[var(--ink-soft)]">
      Zone settings are owner / admin only. Ask a zone owner to grant you access.
    </p>
  {/if}

  <div class="mt-8 grid grid-cols-1 gap-8">
    <!-- ── Retention panel ──────────────────────────────────────── -->
    {#if authLoaded && canRead}
      <section class="sl-reveal sl-reveal-2">
        <div class="flex items-end justify-between gap-4">
          <div>
            <span class="sl-eyebrow">Data retention</span>
            <h2 class="sl-display mt-1 text-[24px] text-[var(--ink)]">Retention policy</h2>
          </div>
          {#if !canWrite}
            <span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
              Read-only — owner can edit
            </span>
          {/if}
        </div>

        {#if policyLoadError}
          <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
            {policyLoadError}
          </p>
        {/if}

        {#if policy}
          <form class="mt-4 sl-card-warm p-5" onsubmit={savePolicy}>
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              {#each RETENTION_DIMENSIONS as dim (dim)}
                <label class="block">
                  <span class="sl-eyebrow" style="font-size:10.5px">
                    {DIMENSION_META[dim].label}
                  </span>
                  <div class="mt-1.5 flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max="36500"
                      step="1"
                      class="sl-input sl-mono w-32"
                      disabled={!canWrite || policySaving}
                      bind:value={policyDraft[dim]}
                    />
                    <span class="text-[12px] text-[var(--ink-mute)]">days</span>
                  </div>
                  <p class="mt-2 text-[12px] leading-relaxed text-[var(--ink-mute)]">
                    {DIMENSION_META[dim].description}
                    {#if DIMENSION_META[dim].neverPurgeNote && policyDraft[dim] === 0}
                      <span class="block mt-1 text-[var(--brass-deep)]">
                        {DIMENSION_META[dim].neverPurgeNote}
                      </span>
                    {/if}
                  </p>
                </label>
              {/each}
            </div>

            {#if policySaveError}
              <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
                {policySaveError}
              </p>
            {/if}
            {#if policySavedFlash}
              <p class="mt-4 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">
                {policySavedFlash}
              </p>
            {/if}

            {#if canWrite}
              <div class="mt-5 flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  class="sl-btn sl-btn-ghost"
                  disabled={policyMatchesDefaults || policySaving}
                  onclick={restoreDefaults}
                >
                  Restore defaults
                </button>
                <button
                  type="submit"
                  class="sl-btn sl-btn-primary"
                  disabled={!policyDirty || policySaving}
                >
                  {policySaving ? "Saving…" : "Save retention policy"}
                </button>
              </div>
            {/if}
          </form>
        {/if}
      </section>
    {/if}

    <!-- ── Export panel ────────────────────────────────────────── -->
    {#if authLoaded && !authError}
      <section class="sl-reveal sl-reveal-3">
        <div class="flex items-end justify-between gap-4">
          <div>
            <span class="sl-eyebrow">Data portability</span>
            <h2 class="sl-display mt-1 text-[24px] text-[var(--ink)]">
              Export this zone's data
            </h2>
            <p class="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--ink-mute)]">
              Generates a complete <code class="sl-mono text-[12px]">.tar.gz</code> archive
              of every record, uploaded file, and stored report for this zone. Owner-only.
              Bundles expire 7 days after completion and one bundle per zone per 24 hours.
            </p>
          </div>
        </div>

        {#if !canExport}
          <p class="mt-4 sl-card-warm px-4 py-3 text-[13px] text-[var(--ink-soft)]">
            Owner-only action — ask a zone owner to generate a bundle if you need one.
          </p>
        {:else}
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              class="sl-btn sl-btn-primary"
              disabled={exportRequesting || hasInFlight(exports)}
              onclick={requestExport}
            >
              {exportRequesting ? "Requesting…" : "Request export"}
            </button>
            {#if hasInFlight(exports)}
              <span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
                Bundle in progress — wait for it to finish before requesting another.
              </span>
            {/if}
          </div>

          {#if exportRequestError}
            <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {exportRequestError}
            </p>
          {/if}
          {#if exportsLoadError}
            <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
              {exportsLoadError}
            </p>
          {/if}

          <div class="mt-5 sl-card overflow-hidden">
            <table class="sl-table">
              <thead>
                <tr>
                  <th>Requested</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Expires</th>
                  <th>SHA-256</th>
                  <th aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {#if exports.length === 0}
                  <tr>
                    <td colspan="6" class="text-center text-[var(--ink-mute)]">
                      No exports yet.
                    </td>
                  </tr>
                {/if}
                {#each exports as row (row.id)}
                  <tr>
                    <td class="sl-mono text-[12px]">{formatDateTime(row.createdAt)}</td>
                    <td>
                      <span class="sl-badge sl-badge-mute">{statusLabel(row.status)}</span>
                      {#if row.errorMessage}
                        <span class="ml-2 text-[12px] text-[var(--bad)]">
                          {row.errorMessage}
                        </span>
                      {/if}
                    </td>
                    <td class="sl-mono text-[12px]">{formatBytes(row.byteCount)}</td>
                    <td class="sl-mono text-[12px]">{formatDateTime(row.expiresAt)}</td>
                    <td>
                      {#if row.sha256}
                        <button
                          type="button"
                          class="sl-btn sl-btn-ghost sl-mono text-[11px]"
                          title={row.sha256}
                          onclick={() => copySha(row.sha256!)}
                        >
                          {copiedSha === row.sha256 ? "Copied!" : `${row.sha256.slice(0, 12)}…`}
                        </button>
                      {:else}
                        <span class="text-[var(--ink-mute)]">—</span>
                      {/if}
                    </td>
                    <td class="text-right">
                      {#if row.status === "completed"}
                        <button
                          type="button"
                          class="sl-btn sl-btn-ghost"
                          disabled={downloadingExportId === row.id}
                          onclick={() => downloadExport(row)}
                        >
                          {downloadingExportId === row.id ? "Downloading…" : "Download"}
                        </button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {/if}
  </div>
</div>
