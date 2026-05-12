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
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
    style="background: rgba(21,22,26,0.45); backdrop-filter: blur(2px)"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div
      class="sl-card w-full max-w-xl"
      style="box-shadow: var(--shadow-lift)"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-zone-title"
    >
      <div class="flex items-start justify-between border-b border-[var(--rule)] px-7 py-5">
        <div>
          <span class="sl-eyebrow">New tenant</span>
          <h2 id="invite-zone-title" class="mt-2 sl-display text-[24px] text-[var(--ink)]">
            Invite a <span class="sl-serif-italic text-[var(--brass-deep)]">zone</span>
          </h2>
          <p class="mt-2 max-w-md text-[12px] text-[var(--ink-mute)]">
            Creates the zone in <code class="sl-mono text-[var(--ink)]">pending_setup</code> and emails the primary contact a
            <code class="sl-mono text-[var(--ink)]">zone_owner</code> invitation that expires in 7 days.
          </p>
        </div>
        <button
          type="button"
          onclick={close}
          class="ml-4 text-[var(--ink-mute)] hover:text-[var(--ink)] text-lg leading-none"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <form class="space-y-5 px-7 py-6" onsubmit={submit}>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Zone name</span>
          <input
            type="text"
            required
            minlength="2"
            maxlength="120"
            bind:value={name}
            placeholder="e.g. Christ Embassy UK Zone 1"
            class="sl-input mt-2"
          />
        </label>

        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Subdomain</span>
          <div class="mt-2 flex overflow-hidden rounded-[2px] border border-[var(--rule-strong)]">
            <input
              type="text"
              required
              pattern="[a-z0-9](-?[a-z0-9])*"
              minlength="3"
              maxlength="40"
              bind:value={slug}
              class="flex-1 bg-[var(--card)] px-3 py-2 text-[13px] focus:outline-none"
            />
            <span class="border-l border-[var(--rule-strong)] bg-[var(--paper-soft)] px-3 py-2 sl-mono text-[12px] text-[var(--ink-mute)]"
              >.stewardledger.church</span
            >
          </div>
        </label>

        <div class="grid grid-cols-3 gap-3">
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">Country</span>
            <input type="text" required maxlength="2" bind:value={countryCode} class="sl-input mt-2 uppercase" />
          </label>
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">Currency</span>
            <input type="text" required maxlength="3" bind:value={defaultCurrency} class="sl-input mt-2 uppercase" />
          </label>
          <label class="block">
            <span class="sl-eyebrow" style="font-size:10.5px">Time zone</span>
            <input type="text" required bind:value={timeZone} class="sl-input mt-2" />
          </label>
        </div>

        <div class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Region</span>
          {#if !useFreeText}
            <input
              type="text"
              bind:value={regionQuery}
              oninput={() => {
                if (regionId) regionId = null;
              }}
              placeholder="Search…"
              class="sl-input mt-2"
            />
            {#if regionId}
              <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
                Selected: <strong class="text-[var(--ink)]">{regionQuery}</strong>
                <button type="button" class="sl-link ml-2" onclick={clearRegion}>change</button>
              </p>
            {:else if regionResults.length > 0}
              <ul class="mt-2 overflow-hidden rounded-[2px] border border-[var(--rule)]">
                {#each regionResults as r (r.id)}
                  <li>
                    <button
                      type="button"
                      class="block w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--paper-soft)]"
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
              class="sl-link mt-2 text-[12px]"
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
              class="sl-input mt-2"
            />
            <p class="mt-2 text-[12px] text-[var(--ink-mute)]">
              Will land in <code class="sl-mono text-[var(--ink)]">/api/admin/regions/inbox</code> for curation.
              <button
                type="button"
                class="sl-link ml-2"
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

        <div class="h-px bg-[var(--rule)]"></div>

        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Primary contact name</span>
          <input type="text" required minlength="2" maxlength="120" bind:value={primaryContactName} class="sl-input mt-2" />
        </label>
        <label class="block">
          <span class="sl-eyebrow" style="font-size:10.5px">Primary contact email</span>
          <input type="email" required bind:value={primaryContactEmail} class="sl-input mt-2" />
          <p class="mt-2 text-[12px] text-[var(--ink-mute)]">The invitation email goes here.</p>
        </label>

        {#if errorMsg}
          <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{errorMsg}</p>
        {/if}

        <div class="flex items-center justify-end gap-3 pt-2">
          <button type="button" onclick={close} disabled={submitting} class="sl-btn sl-btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={submitting} class="sl-btn sl-btn-primary">
            {submitting ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
