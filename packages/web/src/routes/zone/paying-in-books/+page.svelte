<!-- packages/web/src/routes/zone/paying-in-books/+page.svelte -->
<!-- Phase 8 — paying-in book CRUD UI. -->
<!-- Treasurer deposit-slip pads: chapter, code range, date window. -->
<!-- RELEVANT FILES: packages/api/src/routes/tenant-paying-in-books.ts, packages/api/src/services/paying-in-books/validate.ts -->

<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";
  import {
    canWritePayingInBook,
    hasChapterWritePayingInBooks,
    hasZoneWritePayingInBooks,
  } from "$lib/paying-in-books/access";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
  };
  type PayingInBook = {
    id: string;
    chapterId: string;
    referenceCodeStart: string;
    referenceCodeEnd: string;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
    updatedAt: string;
  };



  let books = $state<PayingInBook[]>([]);
  let chapters = $state<Chapter[]>([]);
  let chapterById = $derived(new Map(chapters.map((c) => [c.id, c])));
  let auth = $state<AuthorizedContext | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  // Pagination. The API caps a page at 500 rows; we keep the
  // page size well below the cap and surface a "showing N" hint
  // + paginator instead of silently truncating.
  const PAGE_SIZE = 100;
  let offset = $state(0);
  let pageCount = $state(0);
  let hasMore = $state(false);
  // Request token so a stale fetch returning after a newer one
  // doesn't clobber state. Same pattern as /church/overview.
  let refreshToken = 0;

  let activeOn = $state("");
  let chapterFilter = $state("");

  // Create form state.
  let createOpen = $state(false);
  let createChapterId = $state("");
  let createStart = $state("");
  let createEnd = $state("");
  let createDateFrom = $state("");
  let createDateTo = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  // Per-row edit state.
  let editingId = $state<string | null>(null);
  let editStart = $state("");
  let editEnd = $state("");
  let editDateFrom = $state("");
  let editDateTo = $state("");
  let editError = $state<string | null>(null);
  let saving = $state(false);

  const hasZoneWrite = $derived(hasZoneWritePayingInBooks(auth));
  const hasChapterWriteRole = $derived(hasChapterWritePayingInBooks(auth));

  function canWriteChapter(chapterId: string): boolean {
    return canWritePayingInBook(auth, chapterId);
  }

  async function loadAll(signal: AbortSignal) {
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const params = new URLSearchParams();
      if (activeOn) params.set("activeOn", activeOn);
      if (chapterFilter) params.set("chapterId", chapterFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const [me, chapterRes, booksRes] = await Promise.all([
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me", signal),
        api.get<{ items: Chapter[] }>("/api/tenant/chapters", signal),
        api.get<{ items: PayingInBook[] }>(
          `/api/tenant/paying-in-books?${params.toString()}`,
          signal,
        ),
      ]);
      if (my !== refreshToken) return;
      auth = me.auth;
      chapters = chapterRes.items;
      books = booksRes.items;
      pageCount = booksRes.items.length;
      // The API doesn't return a total count; "is there another
      // page?" is inferred from the page being full at PAGE_SIZE.
      hasMore = booksRes.items.length === PAGE_SIZE;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load paying-in books.";
    } finally {
      // Skip the flip when this fetch was aborted or superseded —
      // a newer request is in flight and should own the loading
      // flag.
      if (!signal.aborted && my === refreshToken) loading = false;
    }
  }

  function nextPage() {
    if (!hasMore) return;
    offset += PAGE_SIZE;
  }

  function prevPage() {
    offset = Math.max(0, offset - PAGE_SIZE);
  }

  // Reset offset whenever a filter changes so a user who paged
  // forward then narrowed the filter doesn't land on a phantom
  // empty page.
  let lastFilterKey = "";
  $effect(() => {
    const key = `${chapterFilter}|${activeOn}`;
    if (key !== lastFilterKey) {
      offset = 0;
      lastFilterKey = key;
    }
    const controller = new AbortController();
    void offset;
    loadAll(controller.signal);
    return () => controller.abort();
  });

  function resetCreateForm() {
    createChapterId = "";
    createStart = "";
    createEnd = "";
    createDateFrom = "";
    createDateTo = "";
    createError = null;
  }

  function toggleCreate() {
    createOpen = !createOpen;
    if (!createOpen) resetCreateForm();
  }

  async function submitCreate(evt: SubmitEvent) {
    evt.preventDefault();
    if (creating) return;
    creating = true;
    createError = null;
    try {
      await api.post<{ payingInBook: PayingInBook }>(
        "/api/tenant/paying-in-books",
        {
          chapterId: createChapterId,
          referenceCodeStart: createStart.trim(),
          referenceCodeEnd: createEnd.trim(),
          dateFrom: createDateFrom,
          dateTo: createDateTo || null,
        },
      );
      resetCreateForm();
      createOpen = false;
      // Reload list with current filters.
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create the book.";
    } finally {
      creating = false;
    }
  }

  function beginEdit(book: PayingInBook) {
    editingId = book.id;
    editStart = book.referenceCodeStart;
    editEnd = book.referenceCodeEnd;
    editDateFrom = book.dateFrom;
    editDateTo = book.dateTo ?? "";
    editError = null;
  }

  function cancelEdit() {
    editingId = null;
    editError = null;
  }

  async function saveEdit(book: PayingInBook) {
    if (saving) return;
    saving = true;
    editError = null;
    try {
      await api.patch<{ payingInBook: PayingInBook }>(
        `/api/tenant/paying-in-books/${book.id}`,
        {
          referenceCodeStart: editStart.trim(),
          referenceCodeEnd: editEnd.trim(),
          dateFrom: editDateFrom,
          dateTo: editDateTo === "" ? null : editDateTo,
        },
      );
      editingId = null;
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      editError = err instanceof ApiError ? err.message : "Could not save the book.";
    } finally {
      saving = false;
    }
  }

  async function deleteBook(book: PayingInBook) {
    const label = `${book.referenceCodeStart}–${book.referenceCodeEnd}`;
    if (!confirm(`Delete paying-in book ${label}? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/tenant/paying-in-books/${book.id}`);
      const controller = new AbortController();
      await loadAll(controller.signal);
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not delete the book.";
    }
  }

  function chapterLabel(chapterId: string): string {
    const c = chapterById.get(chapterId);
    if (!c) return chapterId;
    return `${c.referenceCode} · ${c.name}`;
  }
</script>

<svelte:head><title>Paying-in books · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Giving · Paying-in books</span>
    <h1 class="mt-3 sl-display text-[52px] leading-[1] text-[var(--ink)]">
      Paying-in <span class="sl-serif-italic font-light text-[var(--brass-deep)]">books</span>
    </h1>
    <p class="mt-3 max-w-2xl text-[15px] text-[var(--ink-mute)]">
      Deposit-slip pads issued to a chapter — each pad covers a
      contiguous reference-code range for some date window. Treasurers
      enter the slip code on a contribution batch; the system validates
      the code is in scope at the time of entry.
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
      {loadError}
    </p>
  {/if}

  <!-- Filter bar. -->
  <div class="sl-reveal sl-reveal-2 mt-8 rounded-xl border bg-white p-4 shadow-sm">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <label class="text-sm">
        <span class="block text-slate-600">Chapter</span>
        <select
          bind:value={chapterFilter}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="">All chapters in scope</option>
          {#each chapters as chapter (chapter.id)}
            <option value={chapter.id}>{chapterLabel(chapter.id)}</option>
          {/each}
        </select>
      </label>
      <label class="text-sm">
        <span class="block text-slate-600">Active on date</span>
        <input
          type="date"
          bind:value={activeOn}
          class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      <div class="flex items-end">
        <button
          type="button"
          onclick={toggleCreate}
          disabled={!hasZoneWrite && !hasChapterWriteRole}
          class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {createOpen ? "Cancel" : "New book"}
        </button>
      </div>
    </div>
  </div>

  <!-- Create form. -->
  {#if createOpen}
    <form
      onsubmit={submitCreate}
      class="sl-reveal sl-reveal-3 mt-4 rounded-xl border bg-white p-5 shadow-sm"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label class="text-sm sm:col-span-2">
          <span class="block text-slate-600">Chapter</span>
          <select
            bind:value={createChapterId}
            required
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="" disabled>Select a chapter</option>
            {#each chapters as chapter (chapter.id)}
              {#if canWriteChapter(chapter.id)}
                <option value={chapter.id}>{chapterLabel(chapter.id)}</option>
              {/if}
            {/each}
          </select>
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Code from</span>
          <input
            type="text"
            bind:value={createStart}
            required
            maxlength={64}
            placeholder="e.g. 0000001"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Code to</span>
          <input
            type="text"
            bind:value={createEnd}
            required
            maxlength={64}
            placeholder="e.g. 0000200"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Date from</span>
          <input
            type="date"
            bind:value={createDateFrom}
            required
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          <span class="block text-slate-600">Date to (optional)</span>
          <input
            type="date"
            bind:value={createDateTo}
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <div class="flex items-end gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={creating}
            class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {creating ? "Saving…" : "Create book"}
          </button>
        </div>
      </div>
      {#if createError}
        <p class="mt-3 text-sm text-rose-700">{createError}</p>
      {/if}
      <p class="mt-2 text-[12px] text-slate-500">
        Reference codes are compared lexicographically — the from and to
        codes must be the same width (e.g. both 7-digit or both
        <code>PIB-XXX</code>).
      </p>
    </form>
  {/if}

  <!-- Books list. -->
  <div class="sl-reveal sl-reveal-4 mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
    <table class="min-w-full text-sm" aria-label="Paying-in books">
      <thead class="bg-slate-50 text-left text-slate-600">
        <tr>
          <th class="px-3 py-2 font-medium">Chapter</th>
          <th class="px-3 py-2 font-medium">Code from</th>
          <th class="px-3 py-2 font-medium">Code to</th>
          <th class="px-3 py-2 font-medium">Date from</th>
          <th class="px-3 py-2 font-medium">Date to</th>
          <th class="px-3 py-2 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each books as book (book.id)}
          <tr class="border-t">
            <td class="px-3 py-2 align-top">{chapterLabel(book.chapterId)}</td>
            {#if editingId === book.id}
              <td class="px-3 py-2 align-top">
                <input
                  type="text"
                  bind:value={editStart}
                  maxlength={64}
                  class="w-full rounded border border-slate-300 px-2 py-1"
                />
              </td>
              <td class="px-3 py-2 align-top">
                <input
                  type="text"
                  bind:value={editEnd}
                  maxlength={64}
                  class="w-full rounded border border-slate-300 px-2 py-1"
                />
              </td>
              <td class="px-3 py-2 align-top">
                <input
                  type="date"
                  bind:value={editDateFrom}
                  class="w-full rounded border border-slate-300 px-2 py-1"
                />
              </td>
              <td class="px-3 py-2 align-top">
                <input
                  type="date"
                  bind:value={editDateTo}
                  class="w-full rounded border border-slate-300 px-2 py-1"
                />
              </td>
              <td class="px-3 py-2 align-top text-right">
                <div class="flex justify-end gap-2">
                  <button
                    type="button"
                    onclick={() => saveEdit(book)}
                    disabled={saving}
                    class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400 disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onclick={cancelEdit}
                    class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400"
                  >
                    Cancel
                  </button>
                </div>
                {#if editError}
                  <p class="mt-1 text-xs text-rose-700">{editError}</p>
                {/if}
              </td>
            {:else}
              <td class="px-3 py-2 align-top font-mono">{book.referenceCodeStart}</td>
              <td class="px-3 py-2 align-top font-mono">{book.referenceCodeEnd}</td>
              <td class="px-3 py-2 align-top">{book.dateFrom}</td>
              <td class="px-3 py-2 align-top text-slate-500">
                {book.dateTo ?? "open"}
              </td>
              <td class="px-3 py-2 align-top text-right">
                {#if canWriteChapter(book.chapterId)}
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      onclick={() => beginEdit(book)}
                      class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onclick={() => deleteBook(book)}
                      class="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-rose-700 hover:border-rose-400"
                    >
                      Delete
                    </button>
                  </div>
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
        {#if books.length === 0 && !loading}
          <tr>
            <td colspan={6} class="px-3 py-8 text-center text-slate-500">
              No paying-in books match the current filters.
            </td>
          </tr>
        {/if}
        {#if loading && books.length === 0}
          <tr>
            <td colspan={6} class="px-3 py-8 text-center text-slate-500">Loading…</td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>

  <!-- Paginator + count indicator. The API doesn't return a
       total count; we show the current page range and offer
       prev/next buttons whose state is inferred from whether the
       last page came back full. -->
  {#if pageCount > 0 || offset > 0}
    <div class="sl-reveal sl-reveal-5 mt-4 flex items-center justify-between text-[13px] text-slate-600">
      <span>
        Showing rows {offset + 1}–{offset + pageCount}
        {#if hasMore}(more available){/if}
      </span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={prevPage}
          disabled={offset === 0 || loading}
          class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          type="button"
          onclick={nextPage}
          disabled={!hasMore || loading}
          class="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:border-slate-400 disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  {/if}
</div>
