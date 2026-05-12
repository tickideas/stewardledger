<script lang="ts">
  // Admin invite modal: creates a zone in pending_setup and emails its
  // primary contact a zone_owner invitation. Lifted from the deleted public
  // /signup form; the payload shape (zoneSignupSchema) is identical.

  import { untrack } from "svelte";
  import { api, ApiError } from "$lib/api";

  type RegionHit = { id: string; name: string; shortCode: string | null };

  let { open = $bindable(false), oninvited } = $props<{
    open?: boolean;
    oninvited?: (zoneId: string) => void;
  }>();

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

  // Auto-derive subdomain from the zone name while the admin hasn't yet
  // typed their own slug. The deleted signup form used the same rule.
  function autoSlug(value: string) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }
  // Track `name` only; reading `slug` would re-fire the effect after each
  // assignment we make below and loop. `untrack` lets us compare against
  // the current slug without subscribing to it.
  $effect(() => {
    const next = autoSlug(name);
    untrack(() => {
      if (!slug || slug === next.slice(0, slug.length)) slug = next;
    });
  });

  // Reset when the modal closes so the next open starts clean. We don't
  // want a half-typed previous invite lingering behind a confirmation.
  $effect(() => {
    if (!open) {
      name = "";
      slug = "";
      countryCode = "GB";
      timeZone = "Europe/London";
      defaultCurrency = "GBP";
      primaryContactName = "";
      primaryContactEmail = "";
      regionQuery = "";
      regionId = null;
      regionNameUnverified = "";
      regionResults = [];
      useFreeText = false;
      errorMsg = null;
      submitting = false;
    }
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
    return () => {
      if (regionSearchTimer) clearTimeout(regionSearchTimer);
    };
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

  function close() {
    if (submitting) return;
    open = false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
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
      const res = await api.post<{ status: string; zoneId: string }>(
        "/api/admin/zones/invite",
        payload,
      );
      oninvited?.(res.zoneId);
      open = false;
    } catch (err) {
      errorMsg =
        err instanceof ApiError ? err.message : "Could not send the invitation. Please try again.";
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div
      class="w-full max-w-xl rounded-xl bg-white shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-zone-title"
    >
      <div class="flex items-start justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 id="invite-zone-title" class="text-lg font-semibold tracking-tight">
            Invite a zone
          </h2>
          <p class="mt-1 text-xs text-slate-500">
            Creates the zone in <code>pending_setup</code> and emails the primary contact a
            <code>zone_owner</code> invitation that expires in 7 days.
          </p>
        </div>
        <button
          type="button"
          onclick={close}
          class="ml-4 text-slate-400 hover:text-slate-700"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <form class="space-y-5 px-6 py-5" onsubmit={submit}>
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
          <div class="mt-1 flex overflow-hidden rounded-lg border border-slate-300">
            <input
              type="text"
              required
              pattern="[a-z0-9](-?[a-z0-9])*"
              minlength="3"
              maxlength="40"
              bind:value={slug}
              class="flex-1 px-3 py-2 text-sm focus:outline-none"
            />
            <span class="border-l bg-slate-50 px-3 py-2 text-sm text-slate-500"
              >.stewardledger.church</span
            >
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
              placeholder="Search…"
              class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            {#if regionId}
              <p class="mt-1 text-xs text-slate-500">
                Selected: <strong>{regionQuery}</strong>
                <button type="button" class="ml-2 underline" onclick={clearRegion}>change</button>
              </p>
            {:else if regionResults.length > 0}
              <ul class="mt-1 overflow-hidden rounded-lg border border-slate-200">
                {#each regionResults as r (r.id)}
                  <li>
                    <button
                      type="button"
                      class="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
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
              Don't see their region — enter it manually
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
              Will land in <code>/api/admin/regions/inbox</code> for curation.
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
          <p class="mt-1 text-xs text-slate-500">The invitation email goes here.</p>
        </label>

        {#if errorMsg}
          <p class="text-sm text-red-600">{errorMsg}</p>
        {/if}

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onclick={close}
            disabled={submitting}
            class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            class="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
