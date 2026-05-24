<script lang="ts">
  import { goto } from "$app/navigation";
  import { PUBLIC_API_URL } from "$lib/env";
  import { api, ApiError } from "$lib/api";
  import { ACTIVE_ZONE_KEY } from "$lib/session.svelte";
  import { onMount } from "svelte";

  let name = $state("");
  let countryCode = $state("");
  let checkingExistingChapters = $state(true);
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  onMount(async () => {
    try {
      const zoneSlug = await resolveActiveZoneSlug();
      if (!zoneSlug) return;

      const chapters = await api.get<{ items: Array<{ id: string }> }>("/api/tenant/chapters");
      if (chapters.items.length > 0) {
        await goto(`/zone/chapters?zone=${encodeURIComponent(zoneSlug)}`, { replaceState: true });
      }
    } catch (err) {
      errorMsg =
        err instanceof ApiError ? err.message : "Could not check whether a chapter already exists.";
    } finally {
      checkingExistingChapters = false;
    }
  });

  async function resolveActiveZoneSlug(): Promise<string | null> {
    const urlZone = new URLSearchParams(window.location.search).get("zone");
    if (urlZone) {
      localStorage.setItem(ACTIVE_ZONE_KEY, urlZone);
      return urlZone;
    }

    const storedZone = localStorage.getItem(ACTIVE_ZONE_KEY);
    if (storedZone) return storedZone;

    const res = await fetch(`${PUBLIC_API_URL}/api/public/session-zones`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    const zoneSlug = body.items[0]?.slug;
    if (!zoneSlug) return null;
    localStorage.setItem(ACTIVE_ZONE_KEY, zoneSlug);
    await goto(`/onboarding/chapter?zone=${encodeURIComponent(zoneSlug)}`, { replaceState: true });
    return zoneSlug;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    errorMsg = null;
    submitting = true;
    try {
      await api.post("/api/tenant/chapters", {
        name,
        countryCode: countryCode || undefined,
      });
      await goto("/onboarding/invites");
    } catch (err) {
      errorMsg = err instanceof ApiError ? err.message : "Could not add the chapter.";
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head><title>Onboarding · StewardLedger</title></svelte:head>

{#if checkingExistingChapters}
  <div class="mx-auto max-w-md px-6 py-16">
    <p class="text-[13px] text-[var(--ink-mute)]">Checking chapter setup…</p>
  </div>
{:else}
  <div class="mx-auto max-w-md px-6 py-16">
    <span class="sl-eyebrow">Step 1 of 2</span>
    <h1 class="mt-3 sl-display text-[36px] leading-[1] text-[var(--ink)]">
      Add your first <span class="sl-serif-italic font-light text-[var(--brass-deep)]">chapter</span>
    </h1>
    <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
      A chapter is a single local church. You can add more later or import them in bulk.
    </p>
    <form class="sl-card-warm mt-8 space-y-4 p-6" onsubmit={submit}>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter name</span>
        <input type="text" required minlength="2" maxlength="120" bind:value={name} class="sl-input mt-1.5" />
      </label>
      <label class="block">
        <span class="sl-eyebrow" style="font-size:10.5px">Country (optional)</span>
        <input type="text" maxlength="2" bind:value={countryCode} class="sl-input mt-1.5 uppercase" />
      </label>
      {#if errorMsg}
        <p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{errorMsg}</p>
      {/if}
      <button type="submit" disabled={submitting} class="sl-btn sl-btn-primary w-full justify-center">
        {submitting ? "Saving…" : "Save and continue"}
      </button>
    </form>
  </div>
{/if}
