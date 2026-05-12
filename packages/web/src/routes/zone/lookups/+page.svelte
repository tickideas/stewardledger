<script lang="ts">
  import { api, ApiError } from "$lib/api";

  type Lookup = {
    id: string;
    name: string;
    isActive: boolean;
    ordinal: number;
    gender?: string | null;
  };

  let titles = $state<Lookup[]>([]);
  let maritalStatuses = $state<Lookup[]>([]);
  let memberTypes = $state<Lookup[]>([]);
  let loadError = $state<string | null>(null);

  let newTitle = $state({ name: "", gender: "" });
  let newMS = $state("");
  let newMT = $state("");
  let formError = $state<string | null>(null);

  async function refresh() {
    try {
      const [t, ms, mt] = await Promise.all([
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/titles"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/marital-statuses"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/member-types"),
      ]);
      titles = t.items;
      maritalStatuses = ms.items;
      memberTypes = mt.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load lookups.";
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

  async function addMS(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    try {
      await api.post("/api/tenant/lookups/marital-statuses", { name: newMS });
      newMS = "";
      await refresh();
    } catch (err) {
      formError = err instanceof ApiError ? err.message : "Could not add status.";
    }
  }

  async function addMT(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    try {
      await api.post("/api/tenant/lookups/member-types", { name: newMT });
      newMT = "";
      await refresh();
    } catch (err) {
      formError = err instanceof ApiError ? err.message : "Could not add type.";
    }
  }

  async function toggle(kind: "titles" | "marital-statuses" | "member-types", row: Lookup) {
    try {
      await api.patch(`/api/tenant/lookups/${kind}/${row.id}`, { isActive: !row.isActive });
      await refresh();
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not update.";
    }
  }
</script>

<div class="py-8">
  <h1 class="text-2xl font-semibold tracking-tight">Member lookups</h1>
  <p class="mt-1 text-sm text-slate-600">
    Per-zone reference lists used by the member form. Seeded with sensible defaults at signup;
    edit freely.
  </p>

  {#if loadError}
    <p class="mt-4 text-sm text-red-600">{loadError}</p>
  {/if}
  {#if formError}
    <p class="mt-4 text-sm text-red-600">{formError}</p>
  {/if}

  <div class="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
    <section>
      <h2 class="text-lg font-medium">Titles</h2>
      <ul class="mt-3 divide-y divide-slate-200 border rounded-lg">
        {#each titles as t}
          <li class="px-3 py-2 text-sm flex items-center justify-between">
            <span class={t.isActive ? "" : "text-slate-400"}>
              {t.name}{t.gender ? ` (${t.gender})` : ""}
            </span>
            <button class="text-xs underline" onclick={() => toggle("titles", t)}>
              {t.isActive ? "disable" : "enable"}
            </button>
          </li>
        {/each}
      </ul>
      <form class="mt-3 flex gap-2" onsubmit={addTitle}>
        <input
          type="text"
          required
          maxlength="80"
          bind:value={newTitle.name}
          placeholder="Name"
          class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <select
          bind:value={newTitle.gender}
          class="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="">—</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
        <button
          type="submit"
          class="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
        >
          Add
        </button>
      </form>
    </section>

    <section>
      <h2 class="text-lg font-medium">Marital statuses</h2>
      <ul class="mt-3 divide-y divide-slate-200 border rounded-lg">
        {#each maritalStatuses as ms}
          <li class="px-3 py-2 text-sm flex items-center justify-between">
            <span class={ms.isActive ? "" : "text-slate-400"}>{ms.name}</span>
            <button class="text-xs underline" onclick={() => toggle("marital-statuses", ms)}>
              {ms.isActive ? "disable" : "enable"}
            </button>
          </li>
        {/each}
      </ul>
      <form class="mt-3 flex gap-2" onsubmit={addMS}>
        <input
          type="text"
          required
          maxlength="80"
          bind:value={newMS}
          placeholder="Status"
          class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          class="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
        >
          Add
        </button>
      </form>
    </section>

    <section>
      <h2 class="text-lg font-medium">Member types</h2>
      <ul class="mt-3 divide-y divide-slate-200 border rounded-lg">
        {#each memberTypes as mt}
          <li class="px-3 py-2 text-sm flex items-center justify-between">
            <span class={mt.isActive ? "" : "text-slate-400"}>{mt.name}</span>
            <button class="text-xs underline" onclick={() => toggle("member-types", mt)}>
              {mt.isActive ? "disable" : "enable"}
            </button>
          </li>
        {/each}
      </ul>
      <form class="mt-3 flex gap-2" onsubmit={addMT}>
        <input
          type="text"
          required
          maxlength="80"
          bind:value={newMT}
          placeholder="Type"
          class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          class="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
        >
          Add
        </button>
      </form>
    </section>
  </div>
</div>
