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

<svelte:head><title>Member · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if member}
    <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
      <div>
        <span class="sl-eyebrow">§ II · Identity record</span>
        <p class="mt-3 sl-mono text-[11.5px] text-[var(--ink-mute)]" style="letter-spacing:0.08em">{member.referenceCode}</p>
        <h1 class="mt-1 sl-display text-[40px] leading-[1] text-[var(--ink)]">
          {member.fullName ?? `${member.firstName} ${member.lastName ?? ""}`.trim()}
        </h1>
        <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
          {#if member.isActive}
            <span class="sl-badge sl-badge-ok">active</span>
          {:else}
            <span class="sl-badge sl-badge-mute">inactive</span>
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <a href="/zone/members" class="sl-btn sl-btn-ghost">← Back to directory</a>
        <button type="button" class="sl-btn sl-btn-danger-ghost" onclick={softDelete}>
          Soft-delete
        </button>
      </div>
    </div>

    <form class="sl-reveal sl-reveal-2 sl-card-warm mt-8 grid grid-cols-12 gap-3 p-6" onsubmit={save}>
      <label class="col-span-12 sm:col-span-2">
        <span class="sl-eyebrow" style="font-size:10.5px">Title</span>
        <select bind:value={member.titleId} class="sl-select mt-1.5">
          <option value={null}>—</option>
          {#each titles as t}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">First name</span>
        <input type="text" required minlength="1" maxlength="120" bind:value={member.firstName} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Middle names</span>
        <input type="text" maxlength="200" bind:value={member.middleNames} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Last name</span>
        <input type="text" maxlength="120" bind:value={member.lastName} class="sl-input mt-1.5" />
      </label>

      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Gender</span>
        <select bind:value={member.gender} class="sl-select mt-1.5">
          <option value={null}>—</option>
          <option value="M">M</option>
          <option value="F">F</option>
          <option value="U">U</option>
        </select>
      </label>
      <label class="col-span-6 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Date of birth</span>
        <input type="date" bind:value={member.dateOfBirth} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Marital status</span>
        <select bind:value={member.maritalStatusId} class="sl-select mt-1.5">
          <option value={null}>—</option>
          {#each maritalStatuses as ms}
            <option value={ms.id}>{ms.name}</option>
          {/each}
        </select>
      </label>
      <label class="col-span-12 sm:col-span-3">
        <span class="sl-eyebrow" style="font-size:10.5px">Member type</span>
        <select bind:value={member.memberTypeId} class="sl-select mt-1.5">
          <option value={null}>—</option>
          {#each memberTypes as mt}
            <option value={mt.id}>{mt.name}</option>
          {/each}
        </select>
      </label>

      <label class="col-span-12 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Email</span>
        <input type="email" bind:value={member.email} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Mobile</span>
        <input type="text" maxlength="40" bind:value={member.mobile} class="sl-input mt-1.5" />
      </label>
      <label class="col-span-6 sm:col-span-4">
        <span class="sl-eyebrow" style="font-size:10.5px">Telephone</span>
        <input type="text" maxlength="40" bind:value={member.telephone} class="sl-input mt-1.5" />
      </label>

      <label class="col-span-12 sm:col-span-6">
        <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
        <select bind:value={member.chapterId} class="sl-select mt-1.5">
          <option value={null}>No chapter</option>
          {#each chapters as ch}
            <option value={ch.id}>{ch.name}</option>
          {/each}
        </select>
      </label>
      <div class="col-span-12 flex flex-wrap items-end gap-6 pb-1 text-[13px] text-[var(--ink-soft)] sm:col-span-6">
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
        <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{saveError}</p>
      {/if}
      <div class="col-span-12">
        <button type="submit" disabled={saving} class="sl-btn sl-btn-primary">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>

    <section class="sl-reveal sl-reveal-3 mt-12">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Addresses</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          {addresses.length} on file
        </span>
      </div>
      <ul class="sl-card divide-y divide-[var(--rule)] overflow-hidden">
        {#each addresses as a}
          <li class="flex items-center justify-between gap-4 px-5 py-4">
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2 text-[14px] text-[var(--ink)]">
                <span>{a.line1 ?? "—"}</span>
                {#if a.isPrimary}
                  <span class="sl-badge sl-badge-accent">primary</span>
                {/if}
                {#if a.dateTo}
                  <span class="sl-badge sl-badge-mute">archived {a.dateTo}</span>
                {/if}
              </p>
              <p class="mt-1 text-[12px] text-[var(--ink-mute)]">
                {[a.line2, a.city, a.regionText, a.postcode, a.countryCode].filter(Boolean).join(", ")}
              </p>
            </div>
            {#if !a.dateTo}
              <button type="button" class="sl-btn sl-btn-danger-ghost" onclick={() => archiveAddress(a.id)}>
                Archive
              </button>
            {/if}
          </li>
        {/each}
        {#if addresses.length === 0}
          <li class="px-5 py-10 text-center text-[13px] text-[var(--ink-mute)]">No addresses on file.</li>
        {/if}
      </ul>

      <form class="sl-card-warm mt-4 grid grid-cols-12 gap-3 p-6" onsubmit={addAddress}>
        <label class="col-span-12 sm:col-span-4">
          <span class="sl-eyebrow" style="font-size:10.5px">Address line 1</span>
          <input type="text" bind:value={addrForm.line1} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-12 sm:col-span-4">
          <span class="sl-eyebrow" style="font-size:10.5px">Address line 2</span>
          <input type="text" bind:value={addrForm.line2} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-6 sm:col-span-2">
          <span class="sl-eyebrow" style="font-size:10.5px">City</span>
          <input type="text" bind:value={addrForm.city} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-6 sm:col-span-2">
          <span class="sl-eyebrow" style="font-size:10.5px">Postcode</span>
          <input type="text" bind:value={addrForm.postcode} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-6 sm:col-span-2">
          <span class="sl-eyebrow" style="font-size:10.5px">Country</span>
          <input type="text" maxlength="2" placeholder="GB" bind:value={addrForm.countryCode} class="sl-input mt-1.5 uppercase" />
        </label>
        <label class="col-span-6 flex items-end gap-2 pb-2 text-[12.5px] text-[var(--ink-soft)] sm:col-span-2">
          <input type="checkbox" bind:checked={addrForm.isPrimary} /> Primary
        </label>
        <div class="col-span-12 sm:col-span-8 flex items-end">
          <button type="submit" class="sl-btn sl-btn-primary w-full justify-center sm:w-auto">
            Add address
          </button>
        </div>
        {#if addrError}
          <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{addrError}</p>
        {/if}
      </form>
    </section>
  {/if}
</div>
