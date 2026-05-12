<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { SOURCE_TYPES } from "@stewardledger/shared";

  type Chapter = { id: string; name: string };
  type ServiceEvent = {
    id: string;
    chapterId: string | null;
    serviceTypeId: string;
    serviceDate: string;
  };
  type ServiceType = { id: string; name: string };
  type PaymentMethod = { id: string; name: string; code: string };
  type TemplatePayload = {
    sourceType: (typeof SOURCE_TYPES)[number];
    defaultCurrency?: string | null;
    paymentMethodId?: string | null;
    serviceTypeId?: string | null;
    referenceCode?: string;
    notes?: string;
  };
  type BatchTemplate = { id: string; name: string; payload: TemplatePayload };

  let chapters = $state<Chapter[]>([]);
  let events = $state<ServiceEvent[]>([]);
  let serviceTypes = $state<ServiceType[]>([]);
  let paymentMethods = $state<PaymentMethod[]>([]);
  let templates = $state<BatchTemplate[]>([]);

  let chapterId = $state("");
  let serviceEventId = $state("");
  let paymentMethodId = $state("");
  let sourceType = $state<(typeof SOURCE_TYPES)[number]>("envelope");
  let referenceCode = $state("");
  let notes = $state("");
  let templateId = $state("");

  let creating = $state(false);
  let createError = $state<string | null>(null);
  let loadError = $state<string | null>(null);

  // Stale-response tokens — last-request-wins for both `loadEvents` and
  // `loadTemplates`, which re-fire every time the chapter changes.
  let eventsToken = 0;
  let templatesToken = 0;
  // The query-string `?templateId=` is honoured once, the moment its
  // chapter's templates first land. After that the user owns the picker.
  let appliedFromQuery = false;

  async function loadAll() {
    loadError = null;
    try {
      const [chRes, smRes, stRes] = await Promise.all([
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
        api.get<{ items: PaymentMethod[] }>("/api/tenant/giving/payment-methods"),
        api.get<{ items: ServiceType[] }>("/api/tenant/giving/service-types"),
      ]);
      chapters = chRes.items;
      paymentMethods = smRes.items;
      serviceTypes = stRes.items;
      // Honour `?chapterId=` (deep-link from `/church/contributions`) when
      // it points at a chapter the caller can actually see; otherwise pick
      // the first chapter so the dependent selects render something.
      const queryChapter = page.url.searchParams.get("chapterId");
      if (!chapterId) {
        if (queryChapter && chapters.some((c) => c.id === queryChapter)) {
          chapterId = queryChapter;
        } else if (chapters.length > 0) {
          chapterId = chapters[0].id;
        }
      }
    } catch (err) {
      // Without this, the page renders empty selects and the treasurer
      // has no way to know whether they lack a role or the network blipped.
      loadError =
        err instanceof ApiError
          ? `Could not load form data: ${err.message}`
          : "Could not load form data.";
    }
  }

  async function loadTemplates() {
    const my = ++templatesToken;
    if (!chapterId) {
      templates = [];
      return;
    }
    try {
      const res = await api.get<{ items: BatchTemplate[] }>(
        `/api/tenant/chapters/${chapterId}/batch-templates`,
      );
      if (my !== templatesToken) return;
      templates = res.items;
      // First time the chapter's templates land, honour `?templateId=`
      // from the URL so a deep-link from `/church/settings` can prefill.
      if (!appliedFromQuery) {
        const queryTpl = page.url.searchParams.get("templateId");
        if (queryTpl && templates.some((t) => t.id === queryTpl)) {
          templateId = queryTpl;
          applyTemplate(queryTpl);
        }
        appliedFromQuery = true;
      }
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== templatesToken) return;
      templates = [];
      // Soft-fail: the form still works without templates. We leave a
      // breadcrumb so a treasurer who *expects* templates can still see
      // the cause in devtools without a UI-level error banner.
      console.warn(
        "[new-batch] could not load templates:",
        err instanceof ApiError ? err.message : err,
      );
    }
  }

  /**
   * Apply a template to the form. Always overwrites every prefilled field
   * so switching from template A to template B doesn't leave A's payment
   * method stuck — the picker should feel like a clean reset every time.
   * Stale ids (deleted payment method since the template was saved) round-
   * trip back to the empty select; the server treats null/empty as “no
   * method”.
   */
  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    sourceType = t.payload.sourceType;
    paymentMethodId =
      t.payload.paymentMethodId &&
      paymentMethods.some((pm) => pm.id === t.payload.paymentMethodId)
        ? t.payload.paymentMethodId
        : "";
    referenceCode = t.payload.referenceCode ?? "";
    notes = t.payload.notes ?? "";
  }

  function onTemplateChange() {
    if (!templateId) {
      // “No template” — leave the form alone. Treasurer may have already
      // typed something they want to keep.
      return;
    }
    applyTemplate(templateId);
  }

  async function loadEvents() {
    const my = ++eventsToken;
    if (!chapterId) {
      events = [];
      return;
    }
    // Recent service events for this chapter — backend already orders by date asc.
    // We pull a wide window; the dropdown lets the treasurer pick the right Sunday.
    const today = new Date();
    const past = new Date(today);
    past.setDate(today.getDate() - 60);
    const future = new Date(today);
    future.setDate(today.getDate() + 14);
    const params = new URLSearchParams({
      chapterId,
      dateFrom: past.toISOString().slice(0, 10),
      dateTo: future.toISOString().slice(0, 10),
      limit: "50",
    });
    try {
      const res = await api.get<{ items: ServiceEvent[] }>(
        `/api/tenant/giving/service-events?${params.toString()}`,
      );
      if (my !== eventsToken) return;
      events = res.items;
    } catch (err) {
      if (my !== eventsToken) return;
      events = [];
      // Soft-fail: the form still works without service events.
      if (err instanceof ApiError) loadError = err.message;
    }
  }

  $effect(() => {
    loadAll();
  });

  $effect(() => {
    void chapterId;
    loadEvents();
    loadTemplates();
  });

  function eventLabel(e: ServiceEvent): string {
    const t = serviceTypes.find((st) => st.id === e.serviceTypeId)?.name ?? "Service";
    return `${e.serviceDate} — ${t}`;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!chapterId) {
      createError = "Pick a chapter.";
      return;
    }
    creating = true;
    createError = null;
    try {
      const res = await api.post<{ batch: { id: string } }>(
        "/api/tenant/contribution-batches",
        {
          chapterId,
          serviceEventId: serviceEventId || undefined,
          paymentMethodId: paymentMethodId || undefined,
          sourceType,
          referenceCode: referenceCode || undefined,
          notes: notes || undefined,
        },
      );
      await goto(`/zone/contributions/batches/${res.batch.id}`);
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not create batch.";
    } finally {
      creating = false;
    }
  }
</script>

<div class="max-w-2xl mx-auto px-6 py-8">
  <a href="/zone/contributions" class="text-sm text-slate-500 hover:underline">← Back to contributions</a>
  <h1 class="mt-2 text-2xl font-semibold tracking-tight">New batch</h1>
  <p class="mt-1 text-sm text-slate-600">
    Open the Sunday close. After this you'll add member rows and split by giving type.
  </p>

  {#if loadError}
    <p class="mt-3 text-sm text-amber-700">{loadError}</p>
  {/if}

  <form class="mt-6 space-y-4" onsubmit={submit}>
    {#if templates.length > 0}
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Template (optional)</span>
        <select
          bind:value={templateId}
          onchange={onTemplateChange}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">No template</option>
          {#each templates as t (t.id)}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
        <p class="mt-1 text-xs text-slate-500">
          Picks the source, currency, reference, and notes from this preset.
        </p>
      </label>
    {/if}

    <label class="block">
      <span class="text-sm font-medium text-slate-700">Chapter</span>
      <select
        bind:value={chapterId}
        required
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="" disabled>Pick a chapter</option>
        {#each chapters as ch (ch.id)}
          <option value={ch.id}>{ch.name}</option>
        {/each}
      </select>
    </label>

    <label class="block">
      <span class="text-sm font-medium text-slate-700">Service event (optional)</span>
      <select
        bind:value={serviceEventId}
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="">No service event</option>
        {#each events as ev (ev.id)}
          <option value={ev.id}>{eventLabel(ev)}</option>
        {/each}
      </select>
    </label>

    <div class="grid grid-cols-2 gap-3">
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Source</span>
        <select
          bind:value={sourceType}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          {#each SOURCE_TYPES as s (s)}
            <option value={s}>{s}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Payment method (optional)</span>
        <select
          bind:value={paymentMethodId}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">—</option>
          {#each paymentMethods as pm (pm.id)}
            <option value={pm.id}>{pm.name}</option>
          {/each}
        </select>
      </label>
    </div>

    <label class="block">
      <span class="text-sm font-medium text-slate-700">Reference code (optional)</span>
      <input
        type="text"
        maxlength="80"
        bind:value={referenceCode}
        placeholder="e.g. paying-in book number"
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>

    <label class="block">
      <span class="text-sm font-medium text-slate-700">Notes (optional)</span>
      <textarea
        maxlength="4000"
        rows="3"
        bind:value={notes}
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      ></textarea>
    </label>

    {#if createError}
      <p class="text-sm text-red-600">{createError}</p>
    {/if}

    <button
      type="submit"
      disabled={creating}
      class="inline-flex items-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
    >
      {creating ? "Creating…" : "Create batch"}
    </button>
  </form>
</div>
