<!-- packages/web/src/routes/zone/audit/+page.svelte -->
<!-- Phase 9 — interactive audit-event search surface. -->
<!-- Reuses /api/tenant/reports/audit-log/data so the search and the -->
<!-- audit-log Excel/PDF export stay aligned. -->
<!-- RELEVANT FILES: packages/api/src/services/reports/audit-log.ts, packages/web/src/lib/audit/access.ts -->

<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";
  import { canSearchAudit } from "$lib/audit/access";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Row = {
    occurredAt: string;
    actorEmail: string | null;
    actorRoleCode: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    reason: string | null;
    before: string | null;
    after: string | null;
  };
  type DataResponse = {
    reportId: string;
    rows: Row[];
    meta: { eventCount?: number } | null;
  };

  // Defensive client-side cap. The endpoint returns every row inside
  // the date window — the form's primary throttle is the window, but
  // a too-wide window on a busy zone could surface tens of thousands
  // of rows. We slice + show a banner so the operator narrows the
  // window. A real server-side paginator is a follow-up.
  const MAX_RESULTS = 1_000;

  function defaultDateFrom(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  }
  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  let auth = $state<AuthorizedContext | null>(null);
  let authLoaded = $state(false);
  let dateFrom = $state(defaultDateFrom());
  let dateTo = $state(todayIso());
  let actorUserId = $state("");
  let action = $state("");
  let entityType = $state("");
  let entityId = $state("");

  let rows = $state<Row[]>([]);
  let totalCount = $state(0);
  let truncated = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  // Race guard against stale fetches (mirrors paying-in-books).
  let refreshToken = 0;

  // Expanded-row tracking. Keyed by `${occurredAt}|${action}|${entityId ?? ""}`
  // since the data endpoint doesn't expose the raw `id`. The tuple is
  // unique-enough for an in-page expansion state.
  let expanded = $state(new Set<string>());

  function rowKey(r: Row): string {
    return `${r.occurredAt}|${r.action}|${r.entityId ?? ""}|${r.actorEmail ?? ""}`;
  }
  function toggleExpanded(key: string) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    expanded = new Set(expanded);
  }

  const canSearch = $derived(canSearchAudit(auth));

  async function loadAuth(signal: AbortSignal) {
    try {
      const me = await api.get<{ auth: AuthorizedContext }>(
        "/api/tenant/me",
        signal,
      );
      auth = me.auth;
    } catch (err) {
      if (isAbortError(err)) return;
      // Not fatal for the page; the access card surfaces the issue.
      loadError =
        err instanceof ApiError ? err.message : "Could not load session.";
    } finally {
      if (!signal.aborted) authLoaded = true;
    }
  }

  async function runSearch(signal: AbortSignal) {
    if (!canSearch) return;
    if (!dateFrom || !dateTo) return;
    if (dateFrom > dateTo) {
      loadError = "From-date must be on or before to-date.";
      rows = [];
      totalCount = 0;
      truncated = false;
      return;
    }
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const params = new URLSearchParams();
      params.set("dateFrom", dateFrom);
      params.set("dateTo", dateTo);
      if (actorUserId.trim()) params.set("actorUserId", actorUserId.trim());
      if (action.trim()) params.set("action", action.trim());
      if (entityType.trim()) params.set("entityType", entityType.trim());
      if (entityId.trim()) params.set("entityId", entityId.trim());
      const res = await api.get<DataResponse>(
        `/api/tenant/reports/audit-log/data?${params.toString()}`,
        signal,
      );
      if (my !== refreshToken) return;
      totalCount =
        typeof res.meta?.eventCount === "number" ? res.meta.eventCount : res.rows.length;
      truncated = res.rows.length > MAX_RESULTS;
      rows = truncated ? res.rows.slice(0, MAX_RESULTS) : res.rows;
      // Reset expanded set so a previously-open row from a stale
      // result doesn't render its panel against an unrelated row.
      expanded = new Set();
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError =
        err instanceof ApiError ? err.message : "Could not load audit events.";
      rows = [];
      totalCount = 0;
      truncated = false;
    } finally {
      if (!signal.aborted && my === refreshToken) loading = false;
    }
  }

  function resetForm() {
    dateFrom = defaultDateFrom();
    dateTo = todayIso();
    actorUserId = "";
    action = "";
    entityType = "";
    entityId = "";
  }

  function submitSearch(evt: SubmitEvent) {
    evt.preventDefault();
    const controller = new AbortController();
    void runSearch(controller.signal);
  }

  // Bootstrap: load auth, then if allowed auto-run the default
  // 7-day search so the page isn't empty on first paint.
  $effect(() => {
    const controller = new AbortController();
    (async () => {
      await loadAuth(controller.signal);
      if (controller.signal.aborted) return;
      if (canSearchAudit(auth)) {
        await runSearch(controller.signal);
      }
    })();
    return () => controller.abort();
  });

  function formatWhen(iso: string): string {
    try {
      const d = new Date(iso);
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(d);
    } catch {
      return iso;
    }
  }

  function actorLabel(r: Row): string {
    return r.actorEmail ?? "(system)";
  }

  function entityLabel(r: Row): string {
    if (!r.entityId) return r.entityType;
    const id = r.entityId.length > 14 ? `${r.entityId.slice(0, 12)}…` : r.entityId;
    return `${r.entityType} · ${id}`;
  }

  async function copyToClipboard(text: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Clipboard permission denied — silent no-op. The JSON is
      // visible in the panel either way.
    }
  }
</script>

<svelte:head><title>Audit search · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Insight · Audit search</span>
    <h1 class="mt-3 sl-display text-[52px] leading-[1] text-[var(--ink)]">
      Audit <span class="sl-serif-italic font-light text-[var(--brass-deep)]">search</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[15px] text-[var(--ink-mute)]">
      Every sensitive write in this zone — chapter edits, member
      changes, contribution posts, import rollbacks — lands in the
      audit log. Narrow by date, actor, action, or entity, and
      expand a row to read its before / after payload.
    </p>
  </div>

  {#if !authLoaded}
    <p class="sl-reveal sl-reveal-2 mt-8 text-[13px] text-slate-500">Loading…</p>
  {:else if !canSearch}
    <div
      class="sl-reveal sl-reveal-2 mt-8 rounded-xl border border-[var(--bad)] bg-[var(--bad-soft)] p-6"
    >
      <h2 class="text-[15px] font-medium text-[var(--bad)]">
        Audit search requires zone admin access.
      </h2>
      <p class="mt-2 max-w-xl text-[13px] text-[var(--ink-mute)]">
        Only zone owners, zone admins, and zone finance admins can read
        the audit trail. Ask a zone owner to grant the role you need.
      </p>
    </div>
  {:else}
    {#if loadError}
      <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
        {loadError}
      </p>
    {/if}

    <!-- Filter form. -->
    <form
      onsubmit={submitSearch}
      class="sl-reveal sl-reveal-2 mt-8 rounded-xl border bg-white p-4 shadow-sm"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label class="text-sm">
          <span class="block text-slate-600">From</span>
          <input
            type="date"
            bind:value={dateFrom}
            required
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">To</span>
          <input
            type="date"
            bind:value={dateTo}
            required
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Action</span>
          <input
            type="text"
            bind:value={action}
            placeholder="e.g. chapter.banking.update"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 sl-mono text-[13px]"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Entity type</span>
          <input
            type="text"
            bind:value={entityType}
            placeholder="e.g. contribution"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 sl-mono text-[13px]"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Entity id</span>
          <input
            type="text"
            bind:value={entityId}
            placeholder="entity row id"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 sl-mono text-[13px]"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Actor user id</span>
          <input
            type="text"
            bind:value={actorUserId}
            placeholder="user.id (not email)"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 sl-mono text-[13px]"
          />
        </label>
      </div>
      <div class="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
        <button
          type="button"
          onclick={resetForm}
          class="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:border-slate-400"
        >
          Reset
        </button>
        <p class="ml-auto text-[12px] text-[var(--ink-mute)]">
          Date window is the primary throttle. Free-text fields match
          exactly — they're the underlying column values, not a
          partial search.
        </p>
      </div>
    </form>

    <!-- Results header. -->
    <div class="sl-reveal sl-reveal-3 mt-8 flex items-baseline justify-between gap-3">
      <h2 class="text-[15px] font-medium text-[var(--ink)]">
        Results
      </h2>
      <span class="sl-mono text-[12px] text-[var(--ink-mute)]">
        {totalCount} event{totalCount === 1 ? "" : "s"}{truncated
          ? ` · showing first ${MAX_RESULTS}`
          : ""}
      </span>
    </div>

    {#if truncated}
      <p class="mt-2 border-l-2 border-[var(--brass-deep)] bg-[var(--paper-soft)] px-3 py-2 text-[12.5px] text-[var(--ink-mute)]">
        Showing the first {MAX_RESULTS} of {totalCount} events. Narrow
        the date range, actor, or entity to see more.
      </p>
    {/if}

    {#if loading && rows.length === 0}
      <p class="mt-6 text-[13px] text-slate-500">Loading…</p>
    {:else if rows.length === 0 && !loadError}
      <div
        class="sl-reveal sl-reveal-4 mt-6 rounded-xl border bg-white p-6 text-center text-[13px] text-slate-500 shadow-sm"
      >
        No audit events match these filters.
      </div>
    {:else}
      <ul class="sl-reveal sl-reveal-4 mt-4 space-y-2">
        {#each rows as row (rowKey(row))}
          {@const key = rowKey(row)}
          {@const isOpen = expanded.has(key)}
          <li class="rounded-xl border bg-white shadow-sm">
            <button
              type="button"
              onclick={() => toggleExpanded(key)}
              aria-expanded={isOpen}
              class="flex w-full items-start gap-4 px-4 py-3 text-left hover:bg-[var(--paper-soft)]"
            >
              <span
                class="sl-mono text-[11.5px] whitespace-nowrap text-[var(--ink-mute)]"
                title={row.occurredAt}
              >
                {formatWhen(row.occurredAt)}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13.5px] text-[var(--ink)]">
                  <span class="sl-mono text-[12.5px] text-[var(--brass-deep)]">{row.action}</span>
                  <span class="ml-2 text-[var(--ink-mute)]">·</span>
                  <span class="ml-2 sl-mono text-[12.5px] text-[var(--ink-mute)]">{entityLabel(row)}</span>
                </span>
                <span class="block truncate text-[12px] text-[var(--ink-mute)]">
                  {actorLabel(row)}{row.actorRoleCode ? ` · ${row.actorRoleCode}` : ""}
                  {#if row.reason}
                    <span class="ml-2 italic">"{row.reason}"</span>
                  {/if}
                </span>
              </span>
              <span class="sl-mono text-[11px] text-[var(--ink-mute)]" aria-hidden="true">
                {isOpen ? "▾" : "▸"}
              </span>
            </button>
            {#if isOpen}
              <div class="border-t border-[var(--rule)] bg-[var(--paper-soft)] px-4 py-3">
                <dl class="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
                  <div>
                    <dt class="flex items-center justify-between text-[var(--ink-mute)]">
                      <span>Before</span>
                      {#if row.before}
                        <button
                          type="button"
                          onclick={() => copyToClipboard(row.before ?? "")}
                          class="text-[11px] text-[var(--brass-deep)] hover:underline"
                        >
                          Copy JSON
                        </button>
                      {/if}
                    </dt>
                    <dd>
                      <pre class="sl-mono mt-1 max-h-72 overflow-auto rounded-md border bg-white p-2 text-[11.5px] whitespace-pre-wrap text-[var(--ink)]">{row.before ?? "(none)"}</pre>
                    </dd>
                  </div>
                  <div>
                    <dt class="flex items-center justify-between text-[var(--ink-mute)]">
                      <span>After</span>
                      {#if row.after}
                        <button
                          type="button"
                          onclick={() => copyToClipboard(row.after ?? "")}
                          class="text-[11px] text-[var(--brass-deep)] hover:underline"
                        >
                          Copy JSON
                        </button>
                      {/if}
                    </dt>
                    <dd>
                      <pre class="sl-mono mt-1 max-h-72 overflow-auto rounded-md border bg-white p-2 text-[11.5px] whitespace-pre-wrap text-[var(--ink)]">{row.after ?? "(none)"}</pre>
                    </dd>
                  </div>
                  <div class="sm:col-span-2 grid grid-cols-2 gap-2 text-[11.5px] text-[var(--ink-mute)] sm:grid-cols-4">
                    <div>
                      <dt>Entity type</dt>
                      <dd class="sl-mono text-[var(--ink)]">{row.entityType}</dd>
                    </div>
                    <div>
                      <dt>Entity id</dt>
                      <dd class="sl-mono break-all text-[var(--ink)]">{row.entityId ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Actor role</dt>
                      <dd class="sl-mono text-[var(--ink)]">{row.actorRoleCode ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Occurred at (UTC)</dt>
                      <dd class="sl-mono text-[var(--ink)]">{row.occurredAt}</dd>
                    </div>
                  </div>
                </dl>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
