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

{#if checkingExistingChapters}
  <div class="max-w-md mx-auto px-6 py-16">
    <p class="text-sm text-slate-500">Checking chapter setup…</p>
  </div>
{:else}
  <div class="max-w-md mx-auto px-6 py-16">
    <p class="text-xs font-medium text-slate-500 uppercase tracking-wide">Step 1 of 2</p>
    <h1 class="mt-2 text-2xl font-semibold tracking-tight">Add your first chapter</h1>
    <p class="mt-2 text-sm text-slate-600">
      A chapter is a single local church. You can add more later or import them in bulk.
    </p>
    <form class="mt-6 space-y-4" onsubmit={submit}>
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Chapter name</span>
        <input
          type="text"
          required
          minlength="2"
          maxlength="120"
          bind:value={name}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label class="block">
        <span class="text-sm font-medium text-slate-700">Country (optional)</span>
        <input
          type="text"
          maxlength="2"
          bind:value={countryCode}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
        />
      </label>
      {#if errorMsg}
        <p class="text-sm text-red-600">{errorMsg}</p>
      {/if}
      <button
        type="submit"
        disabled={submitting}
        class="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {submitting ? "Saving…" : "Save and continue"}
      </button>
    </form>
  </div>
{/if}
