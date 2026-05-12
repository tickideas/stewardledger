<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$lib/api";
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

  let chapters = $state<Chapter[]>([]);
  let events = $state<ServiceEvent[]>([]);
  let serviceTypes = $state<ServiceType[]>([]);
  let paymentMethods = $state<PaymentMethod[]>([]);

  let chapterId = $state("");
  let serviceEventId = $state("");
  let paymentMethodId = $state("");
  let sourceType = $state<(typeof SOURCE_TYPES)[number]>("envelope");
  let referenceCode = $state("");
  let notes = $state("");

  let creating = $state(false);
  let createError = $state<string | null>(null);
  let loadError = $state<string | null>(null);

  // Stale-response token — last-request-wins for `loadEvents`, which is
  // re-fired every time the chapter changes.
  let eventsToken = 0;

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
      // Default to first chapter so the events list renders something useful.
      if (!chapterId && chapters.length > 0) chapterId = chapters[0].id;
    } catch (err) {
      // Without this, the page renders empty selects and the treasurer
      // has no way to know whether they lack a role or the network blipped.
      loadError =
        err instanceof ApiError
          ? `Could not load form data: ${err.message}`
          : "Could not load form data.";
    }
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
