<script lang="ts" module>
  // Reusable member typeahead. Owns:
  //   • the search input + dropdown
  //   • debounced server-side `?q=` lookups
  //   • the "results-for-query" tag the parent uses to detect stale auto-picks
  //
  // The parent receives the pure resolution input shape so it can call
  // `resolveMemberSelection(...)` and surface its own error message.
  export type TypeaheadMember = {
    id: string;
    referenceCode: string;
    firstName: string;
    lastName: string | null;
    fullName: string | null;
  };

  export function memberLabel(m: TypeaheadMember): string {
    const name = m.fullName ?? `${m.firstName} ${m.lastName ?? ""}`.trim();
    return `${name} · ${m.referenceCode}`;
  }
</script>

<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";
  import { onDestroy } from "svelte";

  interface Props {
    /** Currently picked id, "" if none. Bindable. */
    memberId: string;
    /** Search-field text. Bindable. */
    query: string;
    /**
     * The trimmed query that produced the current `results`. `null` when
     * nothing has come back yet for the latest input. Bindable so the
     * parent can pass it into `resolveMemberSelection`.
     */
    resultsForQuery: string | null;
    /** Latest results. Bindable. */
    results: TypeaheadMember[];
    /** Optional "recent members" cache shown when the input is empty. */
    recent?: TypeaheadMember[];
    /** Hint when the recent cache is truncated. */
    showRecentTruncatedHint?: boolean;
    placeholder?: string;
    debounceMs?: number;
    /** Disable the input (e.g. while the batch is non-draft). */
    disabled?: boolean;
  }

  let {
    memberId = $bindable(""),
    query = $bindable(""),
    resultsForQuery = $bindable<string | null>(null),
    results = $bindable<TypeaheadMember[]>([]),
    recent = [],
    showRecentTruncatedHint = false,
    placeholder = "Search by name or code · leave blank for unattributed",
    debounceMs = 150,
    disabled = false,
  }: Props = $props();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let runToken = 0;
  let activeController: AbortController | null = null;

  onDestroy(() => {
    if (timer) clearTimeout(timer);
    activeController?.abort();
  });

  function onInput(value: string) {
    query = value;
    memberId = "";
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => run(value), debounceMs);
  }

  async function run(q: string) {
    const my = ++runToken;
    activeController?.abort();
    if (q.trim() === "") {
      results = [];
      resultsForQuery = null;
      return;
    }
    const controller = new AbortController();
    activeController = controller;
    try {
      const params = new URLSearchParams();
      params.set("q", q.trim());
      params.set("limit", "20");
      const res = await api.get<{ items: TypeaheadMember[] }>(
        `/api/tenant/members?${params.toString()}`,
        controller.signal,
      );
      if (my !== runToken) return;
      results = res.items;
      resultsForQuery = q.trim();
    } catch (err) {
      if (isAbortError(err)) return;
      // Typeahead failure is non-fatal — clear so we don't auto-pick
      // against bogus state. ApiError vs network errors get the same
      // treatment from the user's perspective.
      if (err instanceof ApiError || err instanceof Error) {
        if (my === runToken) {
          results = [];
          resultsForQuery = q.trim();
        }
      }
    }
  }

  function pick(m: TypeaheadMember) {
    memberId = m.id;
    query = memberLabel(m);
    results = [];
  }

  // What's shown in the dropdown: live results when typing, recent slice when empty.
  const dropdownItems = $derived(query.trim() === "" ? recent.slice(0, 12) : results);
</script>

<div class="relative">
  <input
    type="text"
    value={query}
    oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
    {placeholder}
    {disabled}
    autocomplete="off"
    class="block w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
  />
  {#if showRecentTruncatedHint && query.trim() === ""}
    <p class="mt-1 text-xs text-slate-500">
      Showing recent members. Type to search the full directory.
    </p>
  {/if}
  {#if query.trim() !== "" && !memberId}
    <ul
      class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow"
    >
      {#each dropdownItems as m (m.id)}
        <li>
          <button
            type="button"
            onclick={() => pick(m)}
            class="block w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            {memberLabel(m)}
          </button>
        </li>
      {/each}
      {#if dropdownItems.length === 0}
        <li class="px-3 py-1.5 text-sm text-slate-500">No matches</li>
      {/if}
    </ul>
  {/if}
</div>
