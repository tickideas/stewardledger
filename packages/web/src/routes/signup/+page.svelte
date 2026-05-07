<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$lib/api";

  type RegionHit = { id: string; name: string; shortCode: string | null };

  let name = $state("");
  let slug = $state("");
  let countryCode = $state("GB");
  let timeZone = $state("Europe/London");
  let defaultCurrency = $state("GBP");
  let primaryContactName = $state("");
  let primaryContactEmail = $state("");

  let regionQuery = $state("");
  let regionId = $state<string | null>(null);
  let regionNameUnverified = $state("");
  let regionResults = $state<RegionHit[]>([]);
  let useFreeText = $state(false);

  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  function autoSlug(value: string) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  $effect(() => {
    if (!slug || slug === autoSlug(name).slice(0, slug.length))
      slug = autoSlug(name);
  });

  let regionSearchTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const q = regionQuery.trim();
    if (regionSearchTimer) clearTimeout(regionSearchTimer);
    if (!q || useFreeText) {
      regionResults = [];
      return;
    }
    regionSearchTimer = setTimeout(async () => {
      try {
        const res = await api.get<{ items: RegionHit[] }>(
          `/api/public/regions/typeahead?q=${encodeURIComponent(q)}`,
        );
        regionResults = res.items;
      } catch {
        regionResults = [];
      }
    }, 200);
  });

  function pickRegion(r: RegionHit) {
    regionId = r.id;
    regionQuery = r.name;
    regionResults = [];
    useFreeText = false;
  }

  function clearRegion() {
    regionId = null;
    regionQuery = "";
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    errorMsg = null;
    submitting = true;
    try {
      const payload = {
        name,
        slug,
        countryCode,
        timeZone,
        defaultCurrency,
        fiscalYearStartMonth: 1,
        ministryYearStartMonth: 3,
        primaryContactName,
        primaryContactEmail,
        ...(useFreeText
          ? { regionNameUnverified: regionNameUnverified.trim() }
          : { regionId: regionId ?? undefined }),
      };
      await api.post("/api/public/signup", payload);
      await goto(`/signup/check-email?email=${encodeURIComponent(primaryContactEmail)}`);
    } catch (err) {
      errorMsg =
        err instanceof ApiError ? err.message : "Could not create your zone. Please try again.";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="max-w-xl mx-auto px-6 py-16">
  <h1 class="text-3xl font-semibold tracking-tight">Set up your zone</h1>
  <p class="mt-2 text-sm text-slate-600">
    A zone is your top-level tenant on StewardLedger &mdash; the umbrella over all your chapters.
  </p>

  <form class="mt-8 space-y-5" onsubmit={submit}>
    <label class="block">
      <span class="text-sm font-medium text-slate-700">Zone name</span>
      <input
        type="text"
        required
        minlength="2"
        maxlength="120"
        bind:value={name}
        placeholder="e.g. Christ Embassy UK Zone 1"
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>

    <label class="block">
      <span class="text-sm font-medium text-slate-700">Subdomain</span>
      <div class="mt-1 flex rounded-lg border border-slate-300 overflow-hidden">
        <input
          type="text"
          required
          pattern="[a-z0-9](-?[a-z0-9])*"
          minlength="3"
          maxlength="40"
          bind:value={slug}
          class="flex-1 px-3 py-2 text-sm focus:outline-none"
        />
        <span class="bg-slate-50 px-3 py-2 text-sm text-slate-500 border-l">.stewardledger.church</span>
      </div>
    </label>

    <div class="grid grid-cols-3 gap-3">
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Country</span>
        <input
          type="text"
          required
          maxlength="2"
          bind:value={countryCode}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
        />
      </label>
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Currency</span>
        <input
          type="text"
          required
          maxlength="3"
          bind:value={defaultCurrency}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
        />
      </label>
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Time zone</span>
        <input
          type="text"
          required
          bind:value={timeZone}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
    </div>

    <div class="block">
      <span class="text-sm font-medium text-slate-700">Region</span>
      {#if !useFreeText}
        <input
          type="text"
          bind:value={regionQuery}
          oninput={() => {
            if (regionId) regionId = null;
          }}
          placeholder="Search&hellip;"
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        {#if regionId}
          <p class="mt-1 text-xs text-slate-500">
            Selected: <strong>{regionQuery}</strong>
            <button type="button" class="ml-2 underline" onclick={clearRegion}>change</button>
          </p>
        {:else if regionResults.length > 0}
          <ul class="mt-1 border border-slate-200 rounded-lg overflow-hidden">
            {#each regionResults as r}
              <li>
                <button
                  type="button"
                  class="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                  onclick={() => pickRegion(r)}
                >
                  {r.name}{r.shortCode ? ` (${r.shortCode})` : ""}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <button
          type="button"
          class="mt-2 text-xs text-slate-600 underline"
          onclick={() => {
            useFreeText = true;
            regionId = null;
            regionResults = [];
          }}
        >
          I don't see our region &mdash; enter it manually
        </button>
      {:else}
        <input
          type="text"
          required
          minlength="2"
          maxlength="120"
          bind:value={regionNameUnverified}
          placeholder="Region name"
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <p class="mt-1 text-xs text-slate-500">
          We'll review and add this to the official list shortly.
          <button
            type="button"
            class="ml-2 underline"
            onclick={() => {
              useFreeText = false;
              regionNameUnverified = "";
            }}
          >
            search instead
          </button>
        </p>
      {/if}
    </div>

    <hr class="border-slate-200" />

    <label class="block">
      <span class="text-sm font-medium text-slate-700">Primary contact name</span>
      <input
        type="text"
        required
        minlength="2"
        maxlength="120"
        bind:value={primaryContactName}
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
    <label class="block">
      <span class="text-sm font-medium text-slate-700">Primary contact email</span>
      <input
        type="email"
        required
        bind:value={primaryContactEmail}
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <p class="mt-1 text-xs text-slate-500">
        We'll send the owner invitation here.
      </p>
    </label>

    {#if errorMsg}
      <p class="text-sm text-red-600">{errorMsg}</p>
    {/if}

    <button
      type="submit"
      disabled={submitting}
      class="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
    >
      {submitting ? "Creating…" : "Create zone"}
    </button>
  </form>
</div>
