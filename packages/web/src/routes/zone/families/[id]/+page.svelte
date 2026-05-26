<!-- packages/web/src/routes/zone/families/[id]/+page.svelte -->
<!-- Household detail: profile, members, and giving summary. -->
<!-- Exists so admins can curate household composition + primary contact + notes. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/families/+page.svelte, packages/api/src/routes/tenant-families.ts, packages/web/src/routes/zone/members/[id]/+page.svelte -->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, ApiError, isAbortError } from "$lib/api";

  type FamilyMemberRow = {
    id: string;
    memberId: string;
    memberReferenceCode: string;
    memberFullName: string | null;
    relationship: string | null;
    isPrimaryContact: boolean;
    joinedAt: string;
    leftAt: string | null;
  };
  type Family = {
    id: string;
    referenceCode: string;
    chapterId: string;
    name: string;
    notes: string | null;
    primaryAddressId: string | null;
    members: FamilyMemberRow[];
    createdAt: string;
    deletedAt: string | null;
  };
  type CurrencyTotal = { currencyCode: string; total: string };
  type FamilyDetailResp = {
    family: Family;
    givingTotals: CurrencyTotal[];
    givingRange: { dateFrom: string; dateTo: string };
  };
  type MemberLite = { id: string; referenceCode: string; fullName: string | null; firstName: string; lastName: string | null };

  let familyId = $derived(page.params.id);

  let family = $state<Family | null>(null);
  let givingTotals = $state<CurrencyTotal[]>([]);
  let givingRange = $state<{ dateFrom: string; dateTo: string } | null>(null);
  let loadError = $state<string | null>(null);

  // Edit profile state
  let editOpen = $state(false);
  let eName = $state("");
  let eNotes = $state("");
  let saving = $state(false);

  // Add-member state
  let addingMember = $state(false);
  let memberQuery = $state("");
  let memberResults = $state<MemberLite[]>([]);
  let addRelationship = $state("");
  let addPrimary = $state(false);
  let chosenMemberId = $state<string | null>(null);
  let addError = $state<string | null>(null);

  let actionError = $state<string | null>(null);

  async function refresh() {
    try {
      const res = await api.get<FamilyDetailResp>(`/api/tenant/families/${familyId}`);
      family = res.family;
      givingTotals = res.givingTotals;
      givingRange = res.givingRange;
      eName = res.family.name;
      eNotes = res.family.notes ?? "";
      loadError = null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        loadError = "Family not found.";
      } else {
        loadError = err instanceof ApiError ? err.message : "Could not load family.";
      }
    }
  }

  $effect(() => {
    refresh();
  });

  async function searchMembers() {
    try {
      const params = new URLSearchParams();
      if (memberQuery.trim()) params.set("q", memberQuery.trim());
      if (family) params.set("chapterId", family.chapterId);
      params.set("isActive", "true");
      params.set("limit", "10");
      const res = await api.get<{ items: MemberLite[] }>(
        `/api/tenant/members?${params.toString()}`,
      );
      memberResults = res.items;
    } catch (err) {
      if (!isAbortError(err)) memberResults = [];
    }
  }

  async function saveProfile(e: SubmitEvent) {
    e.preventDefault();
    if (!family) return;
    saving = true;
    actionError = null;
    try {
      await api.patch(`/api/tenant/families/${family.id}`, {
        name: eName,
        notes: eNotes || null,
      });
      editOpen = false;
      await refresh();
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not save profile.";
    } finally {
      saving = false;
    }
  }

  async function addMember(e: SubmitEvent) {
    e.preventDefault();
    if (!family || !chosenMemberId) return;
    addError = null;
    try {
      await api.post(`/api/tenant/families/${family.id}/members`, {
        memberId: chosenMemberId,
        relationship: addRelationship || undefined,
        isPrimaryContact: addPrimary,
      });
      memberQuery = "";
      memberResults = [];
      addRelationship = "";
      addPrimary = false;
      chosenMemberId = null;
      addingMember = false;
      await refresh();
    } catch (err) {
      addError = err instanceof ApiError ? err.message : "Could not add member.";
    }
  }

  async function promote(member: FamilyMemberRow) {
    if (!family || member.isPrimaryContact) return;
    actionError = null;
    try {
      await api.patch(
        `/api/tenant/families/${family.id}/members/${member.memberId}`,
        { isPrimaryContact: true },
      );
      await refresh();
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not promote.";
    }
  }

  async function removeMember(member: FamilyMemberRow) {
    if (!family) return;
    const reason = window.prompt("Reason for archiving this household member?");
    if (!reason) return;
    actionError = null;
    try {
      const params = new URLSearchParams({ reason });
      await api.delete(
        `/api/tenant/families/${family.id}/members/${member.memberId}?${params.toString()}`,
      );
      await refresh();
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not remove member.";
    }
  }

  async function deleteFamily() {
    if (!family) return;
    const reason = window.prompt("Reason for archiving this household? (audit)");
    if (!reason) return;
    actionError = null;
    try {
      const params = new URLSearchParams({ reason });
      await api.delete(`/api/tenant/families/${family.id}?${params.toString()}`);
      await goto("/zone/families");
    } catch (err) {
      actionError = err instanceof ApiError ? err.message : "Could not archive household.";
    }
  }

  function fmtMember(row: FamilyMemberRow): string {
    return row.memberFullName ?? row.memberReferenceCode;
  }
</script>

<div class="pt-2 pb-10 lg:pt-0">
  <a href="/zone/families" class="sl-mono text-[11px] uppercase text-[var(--ink-mute)] hover:text-[var(--brass-deep)]" style="letter-spacing:0.08em">← Households</a>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {:else if family}
    <div class="sl-reveal sl-reveal-1 mt-4 flex flex-wrap items-end justify-between gap-6">
      <div>
        <span class="sl-eyebrow">§ II · Households</span>
        <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
          {family.name}
        </h1>
        <p class="sl-mono mt-2 text-[12px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">{family.referenceCode}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button class="sl-btn sl-btn-ghost" onclick={() => (editOpen = !editOpen)}>
          {editOpen ? "Cancel" : "Edit profile"}
        </button>
        <button class="sl-btn sl-btn-danger-ghost" onclick={deleteFamily}>Archive household</button>
      </div>
    </div>

    {#if actionError}
      <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{actionError}</p>
    {/if}

    {#if editOpen}
      <form class="sl-reveal sl-card-warm mt-6 grid grid-cols-12 gap-3 p-6" onsubmit={saveProfile}>
        <label class="col-span-12 sm:col-span-6">
          <span class="sl-eyebrow" style="font-size:10.5px">Household name</span>
          <input type="text" required maxlength="200" bind:value={eName} class="sl-input mt-1.5" />
        </label>
        <label class="col-span-12 sm:col-span-6">
          <span class="sl-eyebrow" style="font-size:10.5px">Notes</span>
          <input type="text" maxlength="2000" bind:value={eNotes} class="sl-input mt-1.5" />
        </label>
        <div class="col-span-12 flex justify-end">
          <button class="sl-btn sl-btn-primary" type="submit" disabled={saving}>Save</button>
        </div>
      </form>
    {/if}

    <!-- Giving summary -->
    <div class="sl-reveal sl-reveal-2 mt-8 sl-card p-5">
      <div class="flex items-center justify-between">
        <span class="sl-eyebrow">Household giving</span>
        {#if givingRange}
          <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
            {givingRange.dateFrom} → {givingRange.dateTo}
          </span>
        {/if}
      </div>
      <ul class="mt-3 space-y-1">
        {#each givingTotals as t}
          <li class="flex items-baseline justify-between">
            <span class="sl-mono text-[12px] text-[var(--ink-soft)]">{t.currencyCode}</span>
            <span class="sl-display text-[20px] text-[var(--ink)]">{t.total}</span>
          </li>
        {:else}
          <li class="text-[13px] text-[var(--ink-mute)]">No posted giving in this window.</li>
        {/each}
      </ul>
    </div>

    <!-- Members table -->
    <div class="sl-reveal sl-reveal-3 mt-8">
      <div class="mb-3 flex items-center justify-between">
        <span class="sl-eyebrow">Members</span>
        <button class="sl-btn sl-btn-ghost" onclick={() => (addingMember = !addingMember)}>
          {addingMember ? "Close" : "Add member"}
        </button>
      </div>

      {#if addingMember}
        <form class="sl-card-warm mb-4 grid grid-cols-12 gap-3 p-5" onsubmit={addMember}>
          <label class="col-span-12 sm:col-span-5">
            <span class="sl-eyebrow" style="font-size:10.5px">Search member</span>
            <input
              type="search"
              bind:value={memberQuery}
              oninput={searchMembers}
              placeholder="Type a name or code…"
              class="sl-input mt-1.5"
            />
            {#if memberResults.length > 0}
              <ul class="sl-card mt-2 max-h-40 overflow-auto">
                {#each memberResults as m}
                  <li>
                    <button
                      type="button"
                      class="block w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--paper-soft)]"
                      onclick={() => {
                        chosenMemberId = m.id;
                        memberResults = [];
                        memberQuery = m.fullName ?? `${m.firstName} ${m.lastName ?? ""}`.trim();
                      }}
                    >
                      <span class="sl-mono text-[11px] text-[var(--ink-mute)]">{m.referenceCode}</span>
                      <span class="ml-2 text-[var(--ink)]">{m.fullName ?? `${m.firstName} ${m.lastName ?? ""}`.trim()}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </label>
          <label class="col-span-12 sm:col-span-3">
            <span class="sl-eyebrow" style="font-size:10.5px">Relationship</span>
            <input type="text" maxlength="100" bind:value={addRelationship} class="sl-input mt-1.5" />
          </label>
          <label class="col-span-12 flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" bind:checked={addPrimary} />
            <span class="text-[13px] text-[var(--ink-soft)]">Primary contact</span>
          </label>
          <div class="col-span-12 flex items-end sm:col-span-2">
            <button type="submit" disabled={!chosenMemberId} class="sl-btn sl-btn-primary w-full justify-center">Add</button>
          </div>
          {#if addError}
            <p class="col-span-12 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{addError}</p>
          {/if}
        </form>
      {/if}

      <div class="sl-card overflow-hidden">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Member</th>
              <th>Relationship</th>
              <th>Joined</th>
              <th>Status</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each family.members as row}
              <tr class={row.leftAt ? "text-[var(--ink-mute)]" : ""}>
                <td class="sl-mono text-[11.5px]" style="letter-spacing:0.04em">{row.memberReferenceCode}</td>
                <td>
                  <a href={`/zone/members/${row.memberId}`} class="text-[var(--ink)] hover:text-[var(--brass-deep)]">
                    {fmtMember(row)}
                  </a>
                </td>
                <td>{row.relationship ?? "—"}</td>
                <td class="sl-mono text-[12px]">{row.joinedAt}</td>
                <td>
                  {#if row.leftAt}
                    <span class="sl-badge sl-badge-mute">archived {row.leftAt}</span>
                  {:else if row.isPrimaryContact}
                    <span class="sl-badge sl-badge-ok">primary</span>
                  {:else}
                    <span class="sl-badge sl-badge-mute">member</span>
                  {/if}
                </td>
                <td class="text-right">
                  {#if !row.leftAt}
                    {#if !row.isPrimaryContact}
                      <button class="sl-btn sl-btn-ghost" onclick={() => promote(row)}>Promote</button>
                    {/if}
                    <button class="sl-btn sl-btn-danger-ghost" onclick={() => removeMember(row)}>Archive</button>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if family.members.length === 0}
              <tr><td colspan="6" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">No members yet. Add one above.</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
