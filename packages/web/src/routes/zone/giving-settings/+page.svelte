<!-- packages/web/src/routes/zone/giving-settings/+page.svelte -->
<!-- Zone-level setup for giving types and service types. -->
<!-- Gives admins a normal place to manage contribution/import labels. -->
<!-- RELEVANT FILES: packages/web/src/lib/nav.ts, packages/api/src/routes/tenant-giving.ts, packages/api/src/routes/tenant-giving-methods.ts -->

<script lang="ts">
  import { api, ApiError, isAbortError } from "$lib/api";

  type GivingCategory = {
    id: string;
    name: string;
    shortCode: string | null;
    parentCategoryId: string | null;
    dateTo: string | null;
  };
  type GivingType = {
    id: string;
    categoryId: string;
    name: string;
    shortCode: string | null;
    isActive: boolean;
    isZonal: boolean;
    isChapter: boolean;
    hasPartnershipTarget: boolean;
  };
  type ServiceType = {
    id: string;
    name: string;
    shortCode: string | null;
    isActive: boolean;
  };

  let categories = $state<GivingCategory[]>([]);
  let givingTypes = $state<GivingType[]>([]);
  let serviceTypes = $state<ServiceType[]>([]);
  let loadError = $state<string | null>(null);

  let categoryNameInput = $state("");
  let categoryShortCode = $state("");
  let parentCategoryId = $state("");
  let categoryError = $state<string | null>(null);
  let creatingCategory = $state(false);

  let givingName = $state("");
  let givingShortCode = $state("");
  let givingCategoryId = $state("");
  let givingIsZonal = $state(false);
  let givingHasTarget = $state(false);
  let givingError = $state<string | null>(null);
  let creatingGiving = $state(false);

  let serviceName = $state("");
  let serviceShortCode = $state("");
  let serviceError = $state<string | null>(null);
  let creatingService = $state(false);

  const activeCategories = $derived(categories.filter((category) => isCategoryActive(category)));

  function isCategoryActive(category: GivingCategory): boolean {
    return !category.dateTo || category.dateTo > new Date().toISOString().slice(0, 10);
  }

  function normaliseShortCode(value: string): string | null {
    return value.trim().toUpperCase() || null;
  }

  function categoryLabel(id: string | null): string {
    if (!id) return "Top level";
    return categories.find((category) => category.id === id)?.name ?? "Uncategorised";
  }

  async function loadAll(signal?: AbortSignal) {
    try {
      const [categoryRes, givingRes, serviceRes] = await Promise.all([
        api.get<{ items: GivingCategory[] }>("/api/tenant/giving/categories", signal),
        api.get<{ items: GivingType[] }>("/api/tenant/giving/types", signal),
        api.get<{ items: ServiceType[] }>("/api/tenant/giving/service-types", signal),
      ]);
      categories = categoryRes.items;
      givingTypes = givingRes.items;
      serviceTypes = serviceRes.items;
      const firstActiveCategory = categoryRes.items.find((category) => isCategoryActive(category));
      const selectedCategoryIsActive = categoryRes.items.some(
        (category) => category.id === givingCategoryId && isCategoryActive(category),
      );
      if (!selectedCategoryIsActive) {
        givingCategoryId = firstActiveCategory?.id ?? "";
      }
      loadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      loadError = err instanceof ApiError ? err.message : "Could not load giving settings.";
    }
  }

  $effect(() => {
    const controller = new AbortController();
    loadAll(controller.signal);
    return () => controller.abort();
  });

  async function createCategory(e: SubmitEvent) {
    e.preventDefault();
    creatingCategory = true;
    categoryError = null;
    try {
      await api.post("/api/tenant/giving/categories", {
        name: categoryNameInput.trim(),
        shortCode: normaliseShortCode(categoryShortCode),
        parentCategoryId: parentCategoryId || null,
      });
      categoryNameInput = "";
      categoryShortCode = "";
      parentCategoryId = "";
      await loadAll();
    } catch (err) {
      categoryError = err instanceof ApiError ? err.message : "Could not create giving category.";
    } finally {
      creatingCategory = false;
    }
  }

  async function toggleCategory(category: GivingCategory) {
    const active = isCategoryActive(category);
    try {
      await api.patch(`/api/tenant/giving/categories/${category.id}`, {
        dateTo: active ? new Date().toISOString().slice(0, 10) : null,
      });
      await loadAll();
    } catch (err) {
      categoryError = err instanceof ApiError ? err.message : "Could not update giving category.";
    }
  }

  async function createGivingType(e: SubmitEvent) {
    e.preventDefault();
    if (!givingCategoryId) {
      givingError = "Create a giving category before adding giving types.";
      return;
    }
    creatingGiving = true;
    givingError = null;
    try {
      await api.post("/api/tenant/giving/types", {
        name: givingName.trim(),
        shortCode: normaliseShortCode(givingShortCode),
        categoryId: givingCategoryId,
        isZonal: givingIsZonal,
        isChapter: true,
        hasPartnershipTarget: givingHasTarget,
      });
      givingName = "";
      givingShortCode = "";
      givingIsZonal = false;
      givingHasTarget = false;
      await loadAll();
    } catch (err) {
      givingError = err instanceof ApiError ? err.message : "Could not create giving type.";
    } finally {
      creatingGiving = false;
    }
  }

  async function toggleGivingType(type: GivingType) {
    try {
      await api.patch(`/api/tenant/giving/types/${type.id}`, { isActive: !type.isActive });
      givingTypes = givingTypes.map((item) =>
        item.id === type.id ? { ...item, isActive: !item.isActive } : item,
      );
    } catch (err) {
      givingError = err instanceof ApiError ? err.message : "Could not update giving type.";
    }
  }

  async function createServiceType(e: SubmitEvent) {
    e.preventDefault();
    creatingService = true;
    serviceError = null;
    try {
      await api.post("/api/tenant/giving/service-types", {
        name: serviceName.trim(),
        shortCode: normaliseShortCode(serviceShortCode),
      });
      serviceName = "";
      serviceShortCode = "";
      await loadAll();
    } catch (err) {
      serviceError = err instanceof ApiError ? err.message : "Could not create service type.";
    } finally {
      creatingService = false;
    }
  }

  async function toggleServiceType(type: ServiceType) {
    try {
      await api.patch(`/api/tenant/giving/service-types/${type.id}`, { isActive: !type.isActive });
      serviceTypes = serviceTypes.map((item) =>
        item.id === type.id ? { ...item, isActive: !item.isActive } : item,
      );
    } catch (err) {
      serviceError = err instanceof ApiError ? err.message : "Could not update service type.";
    }
  }
</script>

<svelte:head><title>Giving settings · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1">
    <span class="sl-eyebrow">§ Giving setup</span>
    <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
      Giving <span class="sl-serif-italic font-light text-[var(--brass-deep)]">settings</span>
    </h1>
    <p class="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Manage the giving labels and service types used when churches record counted offerings,
      upload imports, and report partnership progress.
    </p>
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  <div class="mt-8 grid grid-cols-1 gap-8 xl:grid-cols-2">
    <section class="sl-reveal sl-reveal-2 xl:col-span-2">
      <div class="flex items-end justify-between gap-4">
        <div>
          <span class="sl-eyebrow">Giving categories</span>
          <h2 class="sl-display mt-1 text-[24px] text-[var(--ink)]">Reporting groups</h2>
        </div>
        <span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {categories.length} total
        </span>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-[0.75fr_1.25fr]">
        <form class="sl-card-warm grid grid-cols-12 gap-3 p-5" onsubmit={createCategory}>
          <label class="col-span-12 sm:col-span-5 xl:col-span-12">
            <span class="sl-eyebrow" style="font-size:10.5px">Name</span>
            <input required maxlength="120" bind:value={categoryNameInput} class="sl-input mt-1.5" placeholder="Partnership" />
          </label>
          <label class="col-span-6 sm:col-span-3 xl:col-span-5">
            <span class="sl-eyebrow" style="font-size:10.5px">Code</span>
            <input maxlength="32" bind:value={categoryShortCode} class="sl-input sl-mono mt-1.5 uppercase" placeholder="PART" />
          </label>
          <label class="col-span-6 sm:col-span-4 xl:col-span-7">
            <span class="sl-eyebrow" style="font-size:10.5px">Parent</span>
            <select bind:value={parentCategoryId} class="sl-select mt-1.5">
              <option value="">Top level</option>
              {#each categories as category (category.id)}
                <option value={category.id}>{category.name}</option>
              {/each}
            </select>
          </label>
          <div class="col-span-12 flex justify-end">
            <button type="submit" disabled={creatingCategory} class="sl-btn sl-btn-primary w-full justify-center sm:w-auto xl:w-full">
              {creatingCategory ? "Adding…" : "Add category"}
            </button>
          </div>
          {#if categoryError}
            <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{categoryError}</p>
          {/if}
        </form>

        <div class="sl-card overflow-hidden">
          <table class="sl-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Code</th>
                <th>Parent</th>
                <th>Status</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {#each categories as category (category.id)}
                <tr>
                  <td class="text-[var(--ink)]">{category.name}</td>
                  <td class="sl-mono text-[12px]">{category.shortCode ?? "—"}</td>
                  <td class="text-[var(--ink-soft)]">{categoryLabel(category.parentCategoryId)}</td>
                  <td><span class="sl-badge sl-badge-mute">{isCategoryActive(category) ? "Active" : "Inactive"}</span></td>
                  <td class="text-right">
                    <button type="button" class="sl-btn sl-btn-ghost" onclick={() => toggleCategory(category)}>
                      {isCategoryActive(category) ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="sl-reveal sl-reveal-3">
      <div class="flex items-end justify-between gap-4">
        <div>
          <span class="sl-eyebrow">Giving types</span>
          <h2 class="sl-display mt-1 text-[24px] text-[var(--ink)]">Ledger columns</h2>
        </div>
        <span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {givingTypes.length} total
        </span>
      </div>

      <form class="mt-4 sl-card-warm grid grid-cols-12 gap-3 p-5" onsubmit={createGivingType}>
        <label class="col-span-12 sm:col-span-5">
          <span class="sl-eyebrow" style="font-size:10.5px">Name</span>
          <input required maxlength="120" bind:value={givingName} class="sl-input mt-1.5" placeholder="First fruits" />
        </label>
        <label class="col-span-6 sm:col-span-3">
          <span class="sl-eyebrow" style="font-size:10.5px">Code</span>
          <input maxlength="32" bind:value={givingShortCode} class="sl-input sl-mono mt-1.5 uppercase" placeholder="FIRST" />
        </label>
        <label class="col-span-6 sm:col-span-4">
          <span class="sl-eyebrow" style="font-size:10.5px">Category</span>
          <select bind:value={givingCategoryId} required class="sl-select mt-1.5">
            {#each activeCategories as category (category.id)}
              <option value={category.id}>{category.name}</option>
            {/each}
          </select>
        </label>
        <label class="col-span-12 flex items-center gap-2 text-[12px] text-[var(--ink-mute)] sm:col-span-4">
          <input type="checkbox" bind:checked={givingIsZonal} />
          Zone-level giving
        </label>
        <label class="col-span-12 flex items-center gap-2 text-[12px] text-[var(--ink-mute)] sm:col-span-5">
          <input type="checkbox" bind:checked={givingHasTarget} />
          Partnership target
        </label>
        <div class="col-span-12 flex justify-end sm:col-span-3">
          <button type="submit" disabled={creatingGiving} class="sl-btn sl-btn-primary w-full justify-center">
            {creatingGiving ? "Adding…" : "Add type"}
          </button>
        </div>
        {#if givingError}
          <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{givingError}</p>
        {/if}
      </form>

      <div class="mt-5 sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Category</th>
              <th>Status</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {#each givingTypes as type (type.id)}
              <tr>
                <td class="text-[var(--ink)]">{type.name}</td>
                <td class="sl-mono text-[12px]">{type.shortCode ?? "—"}</td>
                <td class="text-[var(--ink-soft)]">{categoryLabel(type.categoryId)}</td>
                <td><span class="sl-badge sl-badge-mute">{type.isActive ? "Active" : "Inactive"}</span></td>
                <td class="text-right">
                  <button type="button" class="sl-btn sl-btn-ghost" onclick={() => toggleGivingType(type)}>
                    {type.isActive ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="sl-reveal sl-reveal-4">
      <div class="flex items-end justify-between gap-4">
        <div>
          <span class="sl-eyebrow">Service types</span>
          <h2 class="sl-display mt-1 text-[24px] text-[var(--ink)]">Service labels</h2>
        </div>
        <span class="sl-mono text-[11px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {serviceTypes.length} total
        </span>
      </div>

      <form class="mt-4 sl-card-warm grid grid-cols-12 gap-3 p-5" onsubmit={createServiceType}>
        <label class="col-span-12 sm:col-span-6">
          <span class="sl-eyebrow" style="font-size:10.5px">Name</span>
          <input required maxlength="120" bind:value={serviceName} class="sl-input mt-1.5" placeholder="Sunday service" />
        </label>
        <label class="col-span-6 sm:col-span-3">
          <span class="sl-eyebrow" style="font-size:10.5px">Code</span>
          <input maxlength="32" bind:value={serviceShortCode} class="sl-input sl-mono mt-1.5 uppercase" placeholder="SUN" />
        </label>
        <div class="col-span-6 flex items-end sm:col-span-3">
          <button type="submit" disabled={creatingService} class="sl-btn sl-btn-primary w-full justify-center">
            {creatingService ? "Adding…" : "Add type"}
          </button>
        </div>
        {#if serviceError}
          <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{serviceError}</p>
        {/if}
      </form>

      <div class="mt-5 sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Status</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {#each serviceTypes as type (type.id)}
              <tr>
                <td class="text-[var(--ink)]">{type.name}</td>
                <td class="sl-mono text-[12px]">{type.shortCode ?? "—"}</td>
                <td><span class="sl-badge sl-badge-mute">{type.isActive ? "Active" : "Inactive"}</span></td>
                <td class="text-right">
                  <button type="button" class="sl-btn sl-btn-ghost" onclick={() => toggleServiceType(type)}>
                    {type.isActive ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>
</div>
