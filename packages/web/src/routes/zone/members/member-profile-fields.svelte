<!-- packages/web/src/routes/zone/members/member-profile-fields.svelte -->
<!-- Manages per-zone dropdown values used by member profile forms and member reports. -->
<!-- Exists so member field setup lives inside the member workflow instead of a separate page. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/members/+page.svelte, packages/web/src/routes/zone/members/[id]/+page.svelte, packages/api/src/routes/tenant-members.ts -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";

  type Lookup = {
    id: string;
    name: string;
    isActive: boolean;
    ordinal: number;
    gender?: string | null;
  };

  let { onClose }: { onClose: () => void } = $props();

  let titles = $state<Lookup[]>([]);
  let maritalStatuses = $state<Lookup[]>([]);
  let memberTypes = $state<Lookup[]>([]);
  let loadError = $state<string | null>(null);
  let formError = $state<string | null>(null);

  let newTitle = $state({ name: "", gender: "" });
  let newMaritalStatus = $state("");
  let newMemberType = $state("");

  async function refresh() {
    try {
      const [titleRes, maritalRes, typeRes] = await Promise.all([
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/titles"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/marital-statuses"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/member-types"),
      ]);
      titles = titleRes.items;
      maritalStatuses = maritalRes.items;
      memberTypes = typeRes.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load profile fields.";
    }
  }

  $effect(() => {
    refresh();
  });

  async function addTitle(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    try {
      await api.post("/api/tenant/lookups/titles", {
        name: newTitle.name,
        gender: newTitle.gender || undefined,
      });
      newTitle = { name: "", gender: "" };
      await refresh();
    } catch (err) {
      formError = err instanceof ApiError ? err.message : "Could not add title.";
    }
  }

  async function addMaritalStatus(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    try {
      await api.post("/api/tenant/lookups/marital-statuses", { name: newMaritalStatus });
      newMaritalStatus = "";
      await refresh();
    } catch (err) {
      formError = err instanceof ApiError ? err.message : "Could not add marital status.";
    }
  }

  async function addMemberType(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    try {
      await api.post("/api/tenant/lookups/member-types", { name: newMemberType });
      newMemberType = "";
      await refresh();
    } catch (err) {
      formError = err instanceof ApiError ? err.message : "Could not add member type.";
    }
  }

  async function toggle(kind: "titles" | "marital-statuses" | "member-types", row: Lookup) {
    try {
      await api.patch(`/api/tenant/lookups/${kind}/${row.id}`, { isActive: !row.isActive });
      await refresh();
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not update profile field.";
    }
  }
</script>

<section class="sl-reveal sl-card-warm mt-6 p-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <span class="sl-eyebrow">Member profile fields</span>
      <h2 class="mt-2 sl-display text-[28px] leading-tight text-[var(--ink)]">
        Dropdown <span class="sl-serif-italic font-light text-[var(--brass-deep)]">options</span>
      </h2>
      <p class="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--ink-mute)]">
        These values appear on member profiles and member reports. Disabling a value keeps it on existing
        records but removes it from new selections.
      </p>
    </div>
    <button type="button" class="sl-btn sl-btn-ghost" onclick={onClose}>Close</button>
  </div>

  {#if loadError}
    <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}
  {#if formError}
    <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{formError}</p>
  {/if}

  <div class="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
    <section class="sl-card bg-[var(--card)] p-4">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-[15px] font-medium text-[var(--ink)]">Titles</h3>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">{titles.length} rows</span>
      </div>
      <ul class="max-h-72 divide-y divide-[var(--rule)] overflow-y-auto border border-[var(--rule)]">
        {#each titles as title (title.id)}
          <li class="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
            <span class={title.isActive ? "truncate text-[var(--ink)]" : "truncate text-[var(--ink-faint)]"}>
              {title.name}{title.gender ? ` (${title.gender})` : ""}
            </span>
            <button class="text-[12px] underline text-[var(--ink-mute)] hover:text-[var(--ink)]" onclick={() => toggle("titles", title)}>
              {title.isActive ? "Disable" : "Enable"}
            </button>
          </li>
        {/each}
      </ul>
      <form class="mt-3 grid grid-cols-[minmax(0,1fr)_4.5rem_auto] gap-2" onsubmit={addTitle}>
        <input type="text" required maxlength="80" bind:value={newTitle.name} placeholder="Title" class="sl-input" />
        <select bind:value={newTitle.gender} class="sl-select">
          <option value="">—</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
        <button type="submit" class="sl-btn sl-btn-primary justify-center">Add</button>
      </form>
    </section>

    <section class="sl-card bg-[var(--card)] p-4">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-[15px] font-medium text-[var(--ink)]">Marital statuses</h3>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">{maritalStatuses.length} rows</span>
      </div>
      <ul class="max-h-72 divide-y divide-[var(--rule)] overflow-y-auto border border-[var(--rule)]">
        {#each maritalStatuses as status (status.id)}
          <li class="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
            <span class={status.isActive ? "truncate text-[var(--ink)]" : "truncate text-[var(--ink-faint)]"}>{status.name}</span>
            <button class="text-[12px] underline text-[var(--ink-mute)] hover:text-[var(--ink)]" onclick={() => toggle("marital-statuses", status)}>
              {status.isActive ? "Disable" : "Enable"}
            </button>
          </li>
        {/each}
      </ul>
      <form class="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2" onsubmit={addMaritalStatus}>
        <input type="text" required maxlength="80" bind:value={newMaritalStatus} placeholder="Status" class="sl-input" />
        <button type="submit" class="sl-btn sl-btn-primary justify-center">Add</button>
      </form>
    </section>

    <section class="sl-card bg-[var(--card)] p-4">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-[15px] font-medium text-[var(--ink)]">Member types</h3>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">{memberTypes.length} rows</span>
      </div>
      <ul class="max-h-72 divide-y divide-[var(--rule)] overflow-y-auto border border-[var(--rule)]">
        {#each memberTypes as type (type.id)}
          <li class="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
            <span class={type.isActive ? "truncate text-[var(--ink)]" : "truncate text-[var(--ink-faint)]"}>{type.name}</span>
            <button class="text-[12px] underline text-[var(--ink-mute)] hover:text-[var(--ink)]" onclick={() => toggle("member-types", type)}>
              {type.isActive ? "Disable" : "Enable"}
            </button>
          </li>
        {/each}
      </ul>
      <form class="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2" onsubmit={addMemberType}>
        <input type="text" required maxlength="80" bind:value={newMemberType} placeholder="Type" class="sl-input" />
        <button type="submit" class="sl-btn sl-btn-primary justify-center">Add</button>
      </form>
    </section>
  </div>
</section>
