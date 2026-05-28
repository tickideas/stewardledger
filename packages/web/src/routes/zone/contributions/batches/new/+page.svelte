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
  const canSubmit = $derived(Boolean(chapterId) && Boolean(serviceEventId) && !creating);
  const importHref = $derived(
    `/zone/imports?fileType=envelope_batch${chapterId ? `&chapterId=${encodeURIComponent(chapterId)}` : ""}`,
  );

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
   * A stale id (deleted payment method since the template was saved)
   * simply renders as the empty option in the select; the server treats
   * null/empty as “no method”. We don't validate against
   * `paymentMethods` here because it may not have loaded yet on the
   * cold-path `?templateId=` deep-link.
   */
  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    sourceType = t.payload.sourceType;
    paymentMethodId = t.payload.paymentMethodId ?? "";
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
    if (!serviceEventId) {
      createError = "Pick the service event for these contributions.";
      return;
    }
    creating = true;
    createError = null;
    try {
      const res = await api.post<{ batch: { id: string } }>(
        "/api/tenant/contribution-batches",
        {
          chapterId,
          serviceEventId,
          paymentMethodId: paymentMethodId || undefined,
          sourceType,
          referenceCode: referenceCode || undefined,
          notes: notes || undefined,
        },
      );
      await goto(`/zone/contributions/batches/${res.batch.id}`);
    } catch (err) {
      createError = err instanceof ApiError ? err.message : "Could not start contribution entry.";
    } finally {
      creating = false;
    }
  }
</script>

<svelte:head><title>Enter contributions · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <a href="/zone/contributions" class="sl-btn sl-btn-ghost">← Back to contributions</a>

  <div class="sl-reveal sl-reveal-1 mt-4">
    <span class="sl-eyebrow">§ Daily ledger · Contributions</span>
    <h1 class="mt-3 sl-display text-[40px] leading-[1] text-[var(--ink)]">
      Enter <span class="sl-serif-italic font-light text-[var(--brass-deep)]">contributions</span>
    </h1>
    <p class="mt-2 max-w-2xl text-[14px] text-[var(--ink-mute)]">
      Choose the chapter and service first. StewardLedger creates an entry session where you can
      add each person’s contribution, check the counted totals, then submit it for posting.
    </p>
    <a href={importHref} class="mt-4 inline-flex sl-btn sl-btn-ghost">
      Import envelope spreadsheet instead
    </a>
  </div>

  {#if loadError}
    <p class="mt-4 border-l-2 border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-[13px] text-[var(--warn)]">{loadError}</p>
  {/if}

  <form class="sl-reveal sl-reveal-2 sl-card-warm mt-8 max-w-3xl space-y-5 p-6" onsubmit={submit}>
    {#if templates.length > 0}
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Template (optional)</span>
        <select bind:value={templateId} onchange={onTemplateChange} class="sl-select mt-1.5">
          <option value="">No template</option>
          {#each templates as t (t.id)}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
        <p class="mt-1.5 text-[11.5px] text-[var(--ink-mute)]">
          Picks the source, currency, reference, and notes from this preset.
        </p>
      </label>
    {/if}

    <label class="block">
      <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
      <select bind:value={chapterId} required class="sl-select mt-1.5">
        <option value="" disabled>Pick a chapter</option>
        {#each chapters as ch (ch.id)}
          <option value={ch.id}>{ch.name}</option>
        {/each}
      </select>
    </label>

    <label class="block">
      <span class="sl-eyebrow" style="font-size:10.5px">Service event</span>
      <select bind:value={serviceEventId} required class="sl-select mt-1.5">
        <option value="" disabled>Pick the service this offering belongs to</option>
        {#each events as ev (ev.id)}
          <option value={ev.id}>{eventLabel(ev)}</option>
        {/each}
      </select>
      {#if events.length === 0}
        <p class="mt-1.5 text-[11.5px] text-[var(--ink-mute)]">
          No recent service events found for this chapter. Create one in <a class="underline decoration-[var(--rule-strong)]" href="/church/settings">church settings</a> or <a class="underline decoration-[var(--rule-strong)]" href="/zone/giving-settings">zone giving settings</a>.
        </p>
      {/if}
    </label>

    <div class="grid grid-cols-2 gap-3">
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Source</span>
        <select bind:value={sourceType} class="sl-select mt-1.5">
          {#each SOURCE_TYPES as s (s)}
            <option value={s}>{s}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Payment method (optional)</span>
        <select bind:value={paymentMethodId} class="sl-select mt-1.5">
          <option value="">—</option>
          {#each paymentMethods as pm (pm.id)}
            <option value={pm.id}>{pm.name}</option>
          {/each}
        </select>
      </label>
    </div>

    <label class="block">
      <span class="sl-eyebrow" style="font-size:10.5px">Reference code (optional)</span>
      <input
        type="text"
        maxlength="80"
        bind:value={referenceCode}
        placeholder="e.g. paying-in book number"
        class="sl-input sl-mono mt-1.5 text-[12.5px]"
      />
    </label>

    <label class="block">
      <span class="sl-eyebrow" style="font-size:10.5px">Notes (optional)</span>
      <textarea
        maxlength="4000"
        rows="3"
        bind:value={notes}
        class="sl-input mt-1.5"
      ></textarea>
    </label>

    {#if createError}
      <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{createError}</p>
    {/if}

    <button type="submit" disabled={!canSubmit} class="sl-btn sl-btn-primary">
      {creating ? "Creating…" : "Start entry"}
    </button>
  </form>
</div>
