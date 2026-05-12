<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, ApiError } from "$lib/api";

  type Member = {
    id: string;
    referenceCode: string;
    firstName: string;
    middleNames: string | null;
    lastName: string | null;
    fullName: string | null;
    gender: string | null;
    email: string | null;
    mobile: string | null;
    telephone: string | null;
    chapterId: string | null;
    titleId: string | null;
    maritalStatusId: string | null;
    memberTypeId: string | null;
    isActive: boolean;
    isCell: boolean;
    isDepartment: boolean;
    dateOfBirth: string | null;
    dateJoinedMinistry: string | null;
    foundationSchoolGraduationDate: string | null;
    createdAt: string;
  };

  type Chapter = { id: string; name: string };
  type Lookup = { id: string; name: string };

  type Address = {
    id: string;
    isPrimary: boolean;
    line1: string | null;
    line2: string | null;
    city: string | null;
    regionText: string | null;
    postcode: string | null;
    countryCode: string | null;
    dateFrom: string;
    dateTo: string | null;
  };

  let memberId = $derived(page.params.id);

  let member = $state<Member | null>(null);
  let addresses = $state<Address[]>([]);
  let chapters = $state<Chapter[]>([]);
  let titles = $state<Lookup[]>([]);
  let maritalStatuses = $state<Lookup[]>([]);
  let memberTypes = $state<Lookup[]>([]);
  let loadError = $state<string | null>(null);

  let saving = $state(false);
  let saveError = $state<string | null>(null);

  let addrForm = $state({
    line1: "",
    line2: "",
    city: "",
    regionText: "",
    postcode: "",
    countryCode: "",
    isPrimary: false,
  });
  let addrError = $state<string | null>(null);

  async function load() {
    try {
      const [m, a, ch, t, ms, mt] = await Promise.all([
        api.get<{ member: Member }>(`/api/tenant/members/${memberId}`),
        api.get<{ items: Address[] }>(`/api/tenant/members/${memberId}/addresses`),
        api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/titles"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/marital-statuses"),
        api.get<{ items: Lookup[] }>("/api/tenant/lookups/member-types"),
      ]);
      member = m.member;
      addresses = a.items;
      chapters = ch.items;
      titles = t.items;
      maritalStatuses = ms.items;
      memberTypes = mt.items;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load member.";
    }
  }

  $effect(() => {
    if (memberId) load();
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!member) return;
    saving = true;
    saveError = null;
    try {
      await api.patch(`/api/tenant/members/${member.id}`, {
        firstName: member.firstName,
        middleNames: member.middleNames || null,
        lastName: member.lastName || null,
        gender: member.gender || null,
        email: member.email || null,
        mobile: member.mobile || null,
        telephone: member.telephone || null,
        chapterId: member.chapterId || null,
        titleId: member.titleId || null,
        maritalStatusId: member.maritalStatusId || null,
        memberTypeId: member.memberTypeId || null,
        isActive: member.isActive,
        isCell: member.isCell,
        isDepartment: member.isDepartment,
        dateOfBirth: member.dateOfBirth || null,
        dateJoinedMinistry: member.dateJoinedMinistry || null,
        foundationSchoolGraduationDate: member.foundationSchoolGraduationDate || null,
      });
      await load();
    } catch (err) {
      saveError = err instanceof ApiError ? err.message : "Could not save.";
    } finally {
      saving = false;
    }
  }

  async function addAddress(e: SubmitEvent) {
    e.preventDefault();
    addrError = null;
    try {
      await api.post(`/api/tenant/members/${memberId}/addresses`, {
        line1: addrForm.line1 || undefined,
        line2: addrForm.line2 || undefined,
        city: addrForm.city || undefined,
        regionText: addrForm.regionText || undefined,
        postcode: addrForm.postcode || undefined,
        countryCode: addrForm.countryCode || undefined,
        isPrimary: addrForm.isPrimary,
      });
      addrForm = {
        line1: "",
        line2: "",
        city: "",
        regionText: "",
        postcode: "",
        countryCode: "",
        isPrimary: false,
      };
      await load();
    } catch (err) {
      addrError = err instanceof ApiError ? err.message : "Could not add address.";
    }
  }

  async function archiveAddress(addrId: string) {
    addrError = null;
    try {
      await api.delete(`/api/tenant/members/${memberId}/addresses/${addrId}`);
      await load();
    } catch (err) {
      addrError = err instanceof ApiError ? err.message : "Could not archive address.";
    }
  }

  async function softDelete() {
    if (!member) return;
    if (!confirm(`Soft-delete member ${member.fullName ?? member.firstName}?`)) return;
    try {
      await api.delete(`/api/tenant/members/${member.id}`);
      await goto("/zone/members");
    } catch (err) {
      saveError = err instanceof ApiError ? err.message : "Could not delete member.";
    }
  }
</script>

<div class="py-8">
  {#if loadError}
    <p class="text-sm text-red-600">{loadError}</p>
  {:else if member}
    <div class="flex items-baseline justify-between">
      <div>
        <p class="text-xs font-mono text-slate-500">{member.referenceCode}</p>
        <h1 class="text-2xl font-semibold tracking-tight">
          {member.fullName ?? `${member.firstName} ${member.lastName ?? ""}`.trim()}
        </h1>
      </div>
      <button
        class="text-sm text-red-600 hover:underline"
        onclick={softDelete}
      >
        Soft-delete
      </button>
    </div>

    <form class="mt-6 grid grid-cols-12 gap-4" onsubmit={save}>
      <label class="col-span-12 sm:col-span-2 text-sm">
        <span class="block font-medium text-slate-700">Title</span>
        <select
          bind:value={member.titleId}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value={null}>—</option>
          {#each titles as t}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
      </label>
      <label class="col-span-12 sm:col-span-3 text-sm">
        <span class="block font-medium text-slate-700">First name</span>
        <input
          type="text"
          required
          minlength="1"
          maxlength="120"
          bind:value={member.firstName}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label class="col-span-12 sm:col-span-3 text-sm">
        <span class="block font-medium text-slate-700">Middle names</span>
        <input
          type="text"
          maxlength="200"
          bind:value={member.middleNames}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label class="col-span-12 sm:col-span-4 text-sm">
        <span class="block font-medium text-slate-700">Last name</span>
        <input
          type="text"
          maxlength="120"
          bind:value={member.lastName}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      <label class="col-span-6 sm:col-span-3 text-sm">
        <span class="block font-medium text-slate-700">Gender</span>
        <select
          bind:value={member.gender}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value={null}>—</option>
          <option value="M">M</option>
          <option value="F">F</option>
          <option value="U">U</option>
        </select>
      </label>
      <label class="col-span-6 sm:col-span-3 text-sm">
        <span class="block font-medium text-slate-700">DOB</span>
        <input
          type="date"
          bind:value={member.dateOfBirth}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label class="col-span-12 sm:col-span-3 text-sm">
        <span class="block font-medium text-slate-700">Marital status</span>
        <select
          bind:value={member.maritalStatusId}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value={null}>—</option>
          {#each maritalStatuses as ms}
            <option value={ms.id}>{ms.name}</option>
          {/each}
        </select>
      </label>
      <label class="col-span-12 sm:col-span-3 text-sm">
        <span class="block font-medium text-slate-700">Member type</span>
        <select
          bind:value={member.memberTypeId}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value={null}>—</option>
          {#each memberTypes as mt}
            <option value={mt.id}>{mt.name}</option>
          {/each}
        </select>
      </label>

      <label class="col-span-12 sm:col-span-4 text-sm">
        <span class="block font-medium text-slate-700">Email</span>
        <input
          type="email"
          bind:value={member.email}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label class="col-span-6 sm:col-span-4 text-sm">
        <span class="block font-medium text-slate-700">Mobile</span>
        <input
          type="text"
          maxlength="40"
          bind:value={member.mobile}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label class="col-span-6 sm:col-span-4 text-sm">
        <span class="block font-medium text-slate-700">Telephone</span>
        <input
          type="text"
          maxlength="40"
          bind:value={member.telephone}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      <label class="col-span-12 sm:col-span-6 text-sm">
        <span class="block font-medium text-slate-700">Chapter</span>
        <select
          bind:value={member.chapterId}
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value={null}>No chapter</option>
          {#each chapters as ch}
            <option value={ch.id}>{ch.name}</option>
          {/each}
        </select>
      </label>
      <div class="col-span-12 sm:col-span-6 text-sm flex items-end gap-6 pb-1">
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" bind:checked={member.isActive} /> Active
        </label>
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" bind:checked={member.isCell} /> Cell
        </label>
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" bind:checked={member.isDepartment} /> Department
        </label>
      </div>

      {#if saveError}
        <p class="col-span-12 text-sm text-red-600">{saveError}</p>
      {/if}
      <div class="col-span-12">
        <button
          type="submit"
          disabled={saving}
          class="inline-flex items-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>

    <section class="mt-12">
      <h2 class="text-lg font-semibold tracking-tight">Addresses</h2>
      <ul class="mt-4 divide-y divide-slate-200 border rounded-lg">
        {#each addresses as a}
          <li class="px-4 py-3 text-sm flex items-center justify-between">
            <div>
              <p class="font-medium text-slate-800">
                {a.line1 ?? ""}
                {#if a.isPrimary}
                  <span class="ml-2 text-xs text-green-700">primary</span>
                {/if}
                {#if a.dateTo}
                  <span class="ml-2 text-xs text-slate-400">archived {a.dateTo}</span>
                {/if}
              </p>
              <p class="text-slate-500 text-xs">
                {[a.line2, a.city, a.regionText, a.postcode, a.countryCode]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
            {#if !a.dateTo}
              <button class="text-xs text-red-600 hover:underline" onclick={() => archiveAddress(a.id)}>
                archive
              </button>
            {/if}
          </li>
        {/each}
        {#if addresses.length === 0}
          <li class="px-4 py-6 text-sm text-slate-500 text-center">No addresses on file.</li>
        {/if}
      </ul>

      <form class="mt-4 grid grid-cols-12 gap-3" onsubmit={addAddress}>
        <input
          type="text"
          bind:value={addrForm.line1}
          placeholder="Address line 1"
          class="col-span-12 sm:col-span-4 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          bind:value={addrForm.line2}
          placeholder="Address line 2"
          class="col-span-12 sm:col-span-4 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          bind:value={addrForm.city}
          placeholder="City"
          class="col-span-6 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          bind:value={addrForm.postcode}
          placeholder="Postcode"
          class="col-span-6 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          maxlength="2"
          bind:value={addrForm.countryCode}
          placeholder="GB"
          class="col-span-3 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
        />
        <label class="col-span-6 sm:col-span-2 text-xs flex items-center gap-2">
          <input type="checkbox" bind:checked={addrForm.isPrimary} /> Primary
        </label>
        <button
          type="submit"
          class="col-span-12 sm:col-span-2 inline-flex items-center justify-center px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
        >
          Add address
        </button>
        {#if addrError}
          <p class="col-span-12 text-sm text-red-600">{addrError}</p>
        {/if}
      </form>
    </section>
  {/if}
</div>
