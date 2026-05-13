<!-- packages/web/src/routes/zone/chapters/[id]/+page.svelte -->
<!-- Chapter profile detail page for zone administrators. -->
<!-- Exists so a zone can view church address, pastor, and contact details before choosing to edit. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/chapters/+page.svelte, packages/api/src/routes/tenant.ts, packages/shared/src/schemas.ts -->

<script lang="ts">
  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";
  import type { AuthorizedContext } from "@stewardledger/shared";

  type ChapterProfile = {
    address: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      county: string | null;
      postcode: string | null;
      countryCode: string | null;
    };
    pastorName: string | null;
    pastorEmail: string | null;
    pastorPhone: string | null;
    officeEmail: string | null;
    officePhone: string | null;
    website: string | null;
    notes: string | null;
  };

  type Chapter = {
    id: string;
    referenceCode: string;
    name: string;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
    createdAt: string;
    updatedAt: string;
    profile: ChapterProfile;
  };

  const adminRoles = new Set(["zone_owner", "zone_admin"]);

  let detail = $state<Chapter | null>(null);
  let auth = $state<AuthorizedContext | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  let saveFlash = $state<string | null>(null);
  let saving = $state(false);
  let dirty = $state(false);
  let editOpen = $state(false);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  let line1 = $state("");
  let line2 = $state("");
  let city = $state("");
  let county = $state("");
  let postcode = $state("");
  let addressCountryCode = $state("");
  let pastorName = $state("");
  let pastorEmail = $state("");
  let pastorPhone = $state("");
  let officeEmail = $state("");
  let officePhone = $state("");
  let website = $state("");
  let notes = $state("");

  const canEdit = $derived(
    auth?.isPlatformAdmin === true || auth?.roleCodes.some((role) => adminRoles.has(role)) === true,
  );

  function seedProfile(profile: ChapterProfile) {
    line1 = profile.address.line1 ?? "";
    line2 = profile.address.line2 ?? "";
    city = profile.address.city ?? "";
    county = profile.address.county ?? "";
    postcode = profile.address.postcode ?? "";
    addressCountryCode = profile.address.countryCode ?? "";
    pastorName = profile.pastorName ?? "";
    pastorEmail = profile.pastorEmail ?? "";
    pastorPhone = profile.pastorPhone ?? "";
    officeEmail = profile.officeEmail ?? "";
    officePhone = profile.officePhone ?? "";
    website = profile.website ?? "";
    notes = profile.notes ?? "";
    dirty = false;
  }

  function clean(value: string): string | null {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function markDirty() {
    dirty = true;
  }

  function present(value: string | null | undefined): string {
    return value?.trim() ? value : "Not recorded";
  }

  function hasValue(value: string | null | undefined): boolean {
    return value?.trim() ? true : false;
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  function addressLines(profile: ChapterProfile): string[] {
    const address = profile.address;
    return [
      address.line1,
      address.line2,
      [address.city, address.county].filter(Boolean).join(", "),
      [address.postcode, address.countryCode].filter(Boolean).join(" "),
    ].filter((value): value is string => Boolean(value?.trim()));
  }

  function openEdit() {
    if (!detail) return;
    seedProfile(detail.profile);
    saveError = null;
    editOpen = true;
  }

  function closeEdit() {
    if (saving) return;
    editOpen = false;
    saveError = null;
    if (detail) seedProfile(detail.profile);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") closeEdit();
  }

  function flash(message: string) {
    saveFlash = message;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      saveFlash = null;
      flashTimer = null;
    }, 4000);
  }

  async function load(chapterId: string, signal: AbortSignal) {
    loading = true;
    try {
      const [chapterRes, meRes] = await Promise.all([
        api.get<{ chapter: Chapter }>(`/api/tenant/chapters/${chapterId}`, signal),
        api.get<{ auth: AuthorizedContext }>("/api/tenant/me", signal),
      ]);
      detail = chapterRes.chapter;
      auth = meRes.auth;
      seedProfile(chapterRes.chapter.profile);
      loadError = null;
    } catch (err) {
      if (isAbortError(err)) return;
      loadError = err instanceof ApiError ? err.message : "Could not load chapter profile.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const chapterId = page.params.id;
    if (!chapterId) return;
    const controller = new AbortController();
    load(chapterId, controller.signal);
    return () => controller.abort();
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!detail) return;
    saving = true;
    saveError = null;
    try {
      const body = {
        address: {
          line1: clean(line1),
          line2: clean(line2),
          city: clean(city),
          county: clean(county),
          postcode: clean(postcode),
          countryCode: clean(addressCountryCode)?.toUpperCase() ?? null,
        },
        pastorName: clean(pastorName),
        pastorEmail: clean(pastorEmail),
        pastorPhone: clean(pastorPhone),
        officeEmail: clean(officeEmail),
        officePhone: clean(officePhone),
        website: clean(website),
        notes: clean(notes),
      };
      const res = await api.patch<{ profile: ChapterProfile }>(
        `/api/tenant/chapters/${detail.id}/profile`,
        body,
      );
      detail = { ...detail, profile: res.profile };
      seedProfile(res.profile);
      editOpen = false;
      flash("Chapter profile saved.");
    } catch (err) {
      saveError = err instanceof ApiError ? err.message : "Could not save chapter profile.";
    } finally {
      saving = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head><title>{detail?.name ?? "Chapter"} profile · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <a href="/zone/chapters" class="sl-mono text-[11px] uppercase text-[var(--ink-mute)] hover:text-[var(--brass-deep)]" style="letter-spacing:0.08em">← Chapters</a>
      <span class="mt-4 block sl-eyebrow">§ I · Chapter profile</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        {detail?.name ?? "Chapter"} <span class="sl-serif-italic font-light text-[var(--brass-deep)]">profile</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        {#if loading}
          <span class="sl-mono text-[12px]" style="letter-spacing:0.1em">LOADING…</span>
        {:else if detail}
          {detail.referenceCode} · active since {formatDate(detail.dateFrom)}
        {/if}
      </p>
    </div>
    {#if canEdit}
      <button type="button" disabled={!detail} class="sl-btn sl-btn-primary" onclick={openEdit}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 10.5h2l5.5-5.5-2-2L3 8.5v2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M7.8 3.7l2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        Edit
      </button>
    {/if}
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if loading}
    <div class="mt-10 sl-card p-12 text-center text-[var(--ink-mute)]">
      <span class="sl-mono text-[12px]" style="letter-spacing:0.16em">LOADING CHAPTER PROFILE…</span>
    </div>
  {:else if detail}
    {#if !canEdit}
      <p class="mt-6 text-[13px] text-[var(--ink-mute)]">Profile editing is available to zone owners and zone admins.</p>
    {/if}
    {#if saveFlash}
      <p class="mt-6 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">{saveFlash}</p>
    {/if}

    <div class="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div class="sl-reveal sl-reveal-2 space-y-6">
        <section class="sl-card overflow-hidden">
          <div class="border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
            <span class="sl-eyebrow">Church details</span>
          </div>
          <div class="grid grid-cols-1 divide-y divide-[var(--rule)] md:grid-cols-2 md:divide-x md:divide-y-0">
            <div class="px-6 py-5">
              <dt class="sl-eyebrow" style="font-size:10.5px">Address</dt>
              <dd class="mt-3 text-[15px] leading-7 text-[var(--ink)]">
                {#if addressLines(detail.profile).length > 0}
                  {#each addressLines(detail.profile) as line (line)}
                    <span class="block">{line}</span>
                  {/each}
                {:else}
                  <span class="text-[var(--ink-mute)]">Not recorded</span>
                {/if}
              </dd>
            </div>
            <dl class="divide-y divide-[var(--rule)]">
              <div class="flex items-baseline justify-between gap-4 px-6 py-4">
                <dt class="text-[13px] text-[var(--ink-mute)]">Country on register</dt>
                <dd class="sl-mono text-[12.5px] text-[var(--ink)]">{present(detail.countryCode)}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-4 px-6 py-4">
                <dt class="text-[13px] text-[var(--ink-mute)]">Active since</dt>
                <dd class="sl-mono text-[12.5px] text-[var(--ink)]">{formatDate(detail.dateFrom)}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section class="sl-card overflow-hidden">
          <div class="border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
            <span class="sl-eyebrow">Pastor</span>
          </div>
          <dl class="grid grid-cols-1 divide-y divide-[var(--rule)] md:grid-cols-3 md:divide-x md:divide-y-0">
            <div class="px-6 py-5">
              <dt class="sl-eyebrow" style="font-size:10.5px">Name</dt>
              <dd class:mt-3={hasValue(detail.profile.pastorName)} class="text-[15px] text-[var(--ink)]">
                <span class:text-[var(--ink-mute)]={!hasValue(detail.profile.pastorName)}>{present(detail.profile.pastorName)}</span>
              </dd>
            </div>
            <div class="px-6 py-5">
              <dt class="sl-eyebrow" style="font-size:10.5px">Email</dt>
              <dd class:mt-3={hasValue(detail.profile.pastorEmail)} class="text-[15px] text-[var(--ink)]">
                {#if hasValue(detail.profile.pastorEmail)}
                  <a class="hover:text-[var(--brass-deep)]" href={`mailto:${detail.profile.pastorEmail}`}>{detail.profile.pastorEmail}</a>
                {:else}
                  <span class="text-[var(--ink-mute)]">Not recorded</span>
                {/if}
              </dd>
            </div>
            <div class="px-6 py-5">
              <dt class="sl-eyebrow" style="font-size:10.5px">Phone</dt>
              <dd class:mt-3={hasValue(detail.profile.pastorPhone)} class="text-[15px] text-[var(--ink)]">
                <span class:text-[var(--ink-mute)]={!hasValue(detail.profile.pastorPhone)}>{present(detail.profile.pastorPhone)}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="sl-card overflow-hidden">
          <div class="border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
            <span class="sl-eyebrow">Contact</span>
          </div>
          <dl class="grid grid-cols-1 divide-y divide-[var(--rule)] md:grid-cols-3 md:divide-x md:divide-y-0">
            <div class="px-6 py-5">
              <dt class="sl-eyebrow" style="font-size:10.5px">Office email</dt>
              <dd class:mt-3={hasValue(detail.profile.officeEmail)} class="text-[15px] text-[var(--ink)]">
                {#if hasValue(detail.profile.officeEmail)}
                  <a class="hover:text-[var(--brass-deep)]" href={`mailto:${detail.profile.officeEmail}`}>{detail.profile.officeEmail}</a>
                {:else}
                  <span class="text-[var(--ink-mute)]">Not recorded</span>
                {/if}
              </dd>
            </div>
            <div class="px-6 py-5">
              <dt class="sl-eyebrow" style="font-size:10.5px">Office phone</dt>
              <dd class:mt-3={hasValue(detail.profile.officePhone)} class="text-[15px] text-[var(--ink)]">
                <span class:text-[var(--ink-mute)]={!hasValue(detail.profile.officePhone)}>{present(detail.profile.officePhone)}</span>
              </dd>
            </div>
            <div class="px-6 py-5">
              <dt class="sl-eyebrow" style="font-size:10.5px">Website</dt>
              <dd class:mt-3={hasValue(detail.profile.website)} class="text-[15px] text-[var(--ink)]">
                {#if hasValue(detail.profile.website)}
                  <a class="break-words hover:text-[var(--brass-deep)]" href={detail.profile.website} target="_blank" rel="noreferrer">{detail.profile.website}</a>
                {:else}
                  <span class="text-[var(--ink-mute)]">Not recorded</span>
                {/if}
              </dd>
            </div>
          </dl>
        </section>

        <section class="sl-card overflow-hidden">
          <div class="border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
            <span class="sl-eyebrow">Notes</span>
          </div>
          <p class="min-h-24 whitespace-pre-wrap px-6 py-5 text-[14px] leading-7 text-[var(--ink)]">
            {#if hasValue(detail.profile.notes)}
              {detail.profile.notes}
            {:else}
              <span class="text-[var(--ink-mute)]">Not recorded</span>
            {/if}
          </p>
        </section>
      </div>

      <aside class="sl-reveal sl-reveal-3 sl-card h-fit overflow-hidden">
        <div class="border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
          <span class="sl-eyebrow">Registry</span>
        </div>
        <dl class="divide-y divide-[var(--rule)] text-[13.5px]">
          <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
            <dt class="text-[var(--ink-mute)]">Reference</dt>
            <dd class="sl-mono text-[12.5px] text-[var(--ink)]" style="letter-spacing:0.04em">{detail.referenceCode}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
            <dt class="text-[var(--ink-mute)]">Chapter name</dt>
            <dd class="text-right text-[var(--ink)]">{detail.name}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
            <dt class="text-[var(--ink-mute)]">Created</dt>
            <dd class="sl-mono text-[12.5px] text-[var(--ink)]">{formatDate(detail.createdAt)}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-4 px-6 py-3.5">
            <dt class="text-[var(--ink-mute)]">Updated</dt>
            <dd class="sl-mono text-[12.5px] text-[var(--ink)]">{formatDate(detail.updatedAt)}</dd>
          </div>
        </dl>
      </aside>
    </div>
  {/if}
</div>

{#if editOpen && detail}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/35 px-4 py-8 backdrop-blur-sm"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeEdit();
    }}
  >
    <div
      class="sl-card w-full max-w-4xl overflow-hidden bg-[var(--paper)] shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chapter-profile-edit-title"
    >
      <div class="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-4">
        <div>
          <span class="sl-eyebrow">Edit chapter profile</span>
          <h2 id="chapter-profile-edit-title" class="sl-display mt-1 text-[26px] leading-tight text-[var(--ink)]">{detail.name}</h2>
        </div>
        <button type="button" class="sl-btn sl-btn-ghost" onclick={closeEdit}>Close</button>
      </div>

      <form id="chapter-profile-form" class="max-h-[calc(100vh-10rem)] overflow-y-auto" onsubmit={save}>
        <div class="border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
          <span class="sl-eyebrow">Church details</span>
        </div>
        <div class="grid grid-cols-12 gap-4 px-6 py-5">
          <label class="col-span-12">
            <span class="sl-eyebrow" style="font-size:10.5px">Address line 1</span>
            <input type="text" maxlength="160" bind:value={line1} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12">
            <span class="sl-eyebrow" style="font-size:10.5px">Address line 2</span>
            <input type="text" maxlength="160" bind:value={line2} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12 sm:col-span-5">
            <span class="sl-eyebrow" style="font-size:10.5px">Town / city</span>
            <input type="text" maxlength="100" bind:value={city} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12 sm:col-span-4">
            <span class="sl-eyebrow" style="font-size:10.5px">County / state</span>
            <input type="text" maxlength="100" bind:value={county} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-6 sm:col-span-2">
            <span class="sl-eyebrow" style="font-size:10.5px">Postcode</span>
            <input type="text" maxlength="24" bind:value={postcode} oninput={markDirty} class="sl-input mt-1.5 uppercase" />
          </label>
          <label class="col-span-6 sm:col-span-1">
            <span class="sl-eyebrow" style="font-size:10.5px">Country</span>
            <input type="text" maxlength="2" bind:value={addressCountryCode} oninput={markDirty} placeholder={detail.countryCode ?? "GB"} class="sl-input mt-1.5 uppercase" />
          </label>
        </div>

        <div class="border-t border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
          <span class="sl-eyebrow">Pastor</span>
        </div>
        <div class="grid grid-cols-12 gap-4 px-6 py-5">
          <label class="col-span-12 sm:col-span-6">
            <span class="sl-eyebrow" style="font-size:10.5px">Pastor name</span>
            <input type="text" maxlength="120" bind:value={pastorName} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12 sm:col-span-6">
            <span class="sl-eyebrow" style="font-size:10.5px">Pastor email</span>
            <input type="email" bind:value={pastorEmail} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12 sm:col-span-6">
            <span class="sl-eyebrow" style="font-size:10.5px">Pastor phone</span>
            <input type="tel" maxlength="40" bind:value={pastorPhone} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
        </div>

        <div class="border-t border-b border-[var(--rule)] bg-[var(--paper-soft)] px-6 py-3.5">
          <span class="sl-eyebrow">Contact</span>
        </div>
        <div class="grid grid-cols-12 gap-4 px-6 py-5">
          <label class="col-span-12 sm:col-span-6">
            <span class="sl-eyebrow" style="font-size:10.5px">Office email</span>
            <input type="email" bind:value={officeEmail} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12 sm:col-span-6">
            <span class="sl-eyebrow" style="font-size:10.5px">Office phone</span>
            <input type="tel" maxlength="40" bind:value={officePhone} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12">
            <span class="sl-eyebrow" style="font-size:10.5px">Website</span>
            <input type="text" maxlength="200" bind:value={website} oninput={markDirty} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12">
            <span class="sl-eyebrow" style="font-size:10.5px">Notes</span>
            <textarea rows="4" maxlength="2000" bind:value={notes} oninput={markDirty} class="sl-input mt-1.5 resize-y"></textarea>
          </label>
        </div>

        {#if saveError}
          <p class="mx-6 mb-5 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{saveError}</p>
        {/if}

        <div class="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-[var(--rule)] bg-[var(--paper)] px-6 py-4">
          <button type="button" class="sl-btn sl-btn-ghost" onclick={closeEdit}>Cancel</button>
          <button type="submit" disabled={!dirty || saving} class="sl-btn sl-btn-primary">
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
