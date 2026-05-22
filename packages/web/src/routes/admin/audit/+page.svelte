<!-- packages/web/src/routes/admin/audit/+page.svelte -->
<!-- Platform-scope audit-event search. Surfaces rows the audit_events -->
<!-- CHECK constraint partitions as `zone_id IS NULL AND action LIKE 'platform.%'`. -->
<!-- Super-admin only; mirrors the /zone/audit shape but against /api/admin/audit-events. -->
<!-- RELEVANT FILES: packages/api/src/routes/admin-audit.ts, packages/web/src/routes/zone/audit/+page.svelte -->

<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$lib/api";

  type Row = {
    id: string;
    occurredAt: string;
    actorEmail: string | null;
    actorRoleCode: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    reason: string | null;
    before: unknown;
    after: unknown;
    ipAddress: string | null;
    userAgent: string | null;
  };
  type ListResponse = { items: Row[] };

  // Known platform audit actions — surfaced in the action dropdown as
  // a convenience. Free-text input is still allowed for forward compat.
  const KNOWN_ACTIONS = [
    "platform.admin.invite",
    "platform.admin.invite_revoke",
    "platform.admin.invite_accept",
    "platform.admin.grant",
    "platform.admin.revoke",
    "platform.admin.elevate",
    "platform.admin.demote",
  ];

  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }
  function defaultDateFrom(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  }

  let dateFrom = $state(defaultDateFrom());
  let dateTo = $state(todayIso());
  let action = $state("");
  let actorUserId = $state("");
  let entityType = $state("");
  let entityId = $state("");

  let rows = $state<Row[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let expanded = $state(new Set<string>());

  function toggleExpanded(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    expanded = new Set(expanded);
  }

  async function search(): Promise<void> {
    if (!dateFrom || !dateTo) return;
    if (dateFrom > dateTo) {
      loadError = "From-date must be on or before to-date.";
      return;
    }
    loading = true;
    loadError = null;
    try {
      const params = new URLSearchParams();
      params.set("dateFrom", dateFrom);
      params.set("dateTo", dateTo);
      if (action.trim()) params.set("action", action.trim());
      if (actorUserId.trim()) params.set("actorUserId", actorUserId.trim());
      if (entityType.trim()) params.set("entityType", entityType.trim());
      if (entityId.trim()) params.set("entityId", entityId.trim());
      const res = await api.get<ListResponse>(
        `/api/admin/audit-events?${params.toString()}`,
      );
      rows = res.items;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load audit events.";
      rows = [];
    } finally {
      loading = false;
    }
  }

  function reset(): void {
    dateFrom = defaultDateFrom();
    dateTo = todayIso();
    action = "";
    actorUserId = "";
    entityType = "";
    entityId = "";
    search();
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function fmtJson(value: unknown): string {
    if (value === null || value === undefined) return "—";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  onMount(() => {
    void search();
  });
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <!-- Title block -->
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Section III · Access</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      Audit <span class="sl-serif-italic font-light text-[var(--brass-deep)]">trail</span>
    </h1>
    <p class="mt-2 max-w-xl text-[14px] text-[var(--ink-mute)]">
      Platform-scope events only — every grant, revoke, promote, demote, and
      invitation lifecycle action taken from <code class="sl-mono">/admin/administrators</code>.
      Tenant-scope events live on each zone's audit page.
    </p>
  </div>

  <!-- Filters -->
  <div class="sl-reveal sl-reveal-2 mt-8 sl-card-warm p-6">
    <div class="mb-4 flex items-center gap-3">
      <span class="sl-eyebrow">Filters</span>
      <span class="h-px flex-1 bg-[var(--rule)]"></span>
    </div>
    <form
      class="grid grid-cols-12 gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        search();
      }}
    >
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">From</span>
        <input type="date" bind:value={dateFrom} class="sl-input mt-1.5" required />
      </label>
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">To</span>
        <input type="date" bind:value={dateTo} class="sl-input mt-1.5" required />
      </label>
      <label class="col-span-12 sm:col-span-6">
        <span class="sl-eyebrow" style="font-size:10.5px">Action</span>
        <input
          type="text"
          bind:value={action}
          list="known-platform-actions"
          placeholder="platform.admin.grant"
          class="sl-input mt-1.5"
        />
        <datalist id="known-platform-actions">
          {#each KNOWN_ACTIONS as a (a)}
            <option value={a}></option>
          {/each}
        </datalist>
      </label>
      <label class="col-span-12 sm:col-span-6">
        <span class="sl-eyebrow" style="font-size:10.5px">Actor user id</span>
        <input type="text" bind:value={actorUserId} placeholder="optional" class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Entity type</span>
        <input type="text" bind:value={entityType} placeholder="user / platform_invitation" class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Entity id</span>
        <input type="text" bind:value={entityId} placeholder="optional" class="sl-input mt-1.5" />
      </label>
      <div class="col-span-12 flex justify-end gap-2 pt-1">
        <button type="button" onclick={reset} disabled={loading} class="sl-btn sl-btn-ghost">
          Reset
        </button>
        <button type="submit" disabled={loading} class="sl-btn sl-btn-primary">
          {loading ? "Searching…" : "Search"}
        </button>
      </div>
    </form>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-4 py-3 text-[13px] text-[var(--bad)]">
      {loadError}
    </p>
  {/if}

  <!-- Results -->
  <div class="sl-reveal sl-reveal-3 mt-10">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Events</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {rows.length} {rows.length === 1 ? "row" : "rows"}
      </span>
    </div>
    {#if loading && rows.length === 0}
      <div class="sl-card p-12 text-center text-[13px] text-[var(--ink-mute)]">
        <span class="sl-mono" style="letter-spacing:0.16em">SEARCHING…</span>
      </div>
    {:else if rows.length === 0}
      <div class="sl-card p-12 text-center text-[14px] text-[var(--ink-mute)]">
        No platform audit events match the current filters.
      </div>
    {:else}
      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th class="!text-right">Detail</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as r (r.id)}
              <tr>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">{fmtDate(r.occurredAt)}</td>
                <td>
                  <div class="sl-mono text-[12px] text-[var(--ink)]">{r.actorEmail ?? "—"}</div>
                  {#if r.actorRoleCode}
                    <div class="mt-0.5 text-[11px] text-[var(--ink-mute)]">{r.actorRoleCode}</div>
                  {/if}
                </td>
                <td>
                  <span class="sl-badge sl-badge-info">{r.action}</span>
                </td>
                <td class="sl-mono text-[11.5px] text-[var(--ink-mute)]">
                  <div>{r.entityType}</div>
                  {#if r.entityId}
                    <div class="text-[var(--ink-faint)]">{r.entityId}</div>
                  {/if}
                </td>
                <td class="text-right">
                  <button
                    class="sl-link text-[12px]"
                    onclick={() => toggleExpanded(r.id)}
                  >{expanded.has(r.id) ? "hide" : "show"}</button>
                </td>
              </tr>
              {#if expanded.has(r.id)}
                <tr>
                  <td colspan="5" class="bg-[var(--paper-soft)] px-4 py-3 text-[12px]">
                    <div class="grid grid-cols-2 gap-4">
                      <div>
                        <div class="sl-eyebrow" style="font-size:10px">Before</div>
                        <pre class="mt-1 max-h-64 overflow-auto sl-mono text-[11px] text-[var(--ink-soft)]">{fmtJson(r.before)}</pre>
                      </div>
                      <div>
                        <div class="sl-eyebrow" style="font-size:10px">After</div>
                        <pre class="mt-1 max-h-64 overflow-auto sl-mono text-[11px] text-[var(--ink-soft)]">{fmtJson(r.after)}</pre>
                      </div>
                    </div>
                    {#if r.reason || r.ipAddress || r.userAgent}
                      <div class="mt-3 grid grid-cols-3 gap-4 border-t border-[var(--rule)] pt-3 text-[11px] text-[var(--ink-mute)]">
                        {#if r.reason}
                          <div><span class="sl-eyebrow" style="font-size:10px">Reason</span><div class="mt-1">{r.reason}</div></div>
                        {/if}
                        {#if r.ipAddress}
                          <div><span class="sl-eyebrow" style="font-size:10px">IP</span><div class="mt-1 sl-mono">{r.ipAddress}</div></div>
                        {/if}
                        {#if r.userAgent}
                          <div><span class="sl-eyebrow" style="font-size:10px">User agent</span><div class="mt-1 sl-mono truncate" title={r.userAgent}>{r.userAgent}</div></div>
                        {/if}
                      </div>
                    {/if}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
