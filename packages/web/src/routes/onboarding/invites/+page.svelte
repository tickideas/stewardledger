<script lang="ts">
  import { api, ApiError } from "$lib/api";
  import { INVITABLE_CHAPTER_ROLE_OPTIONS, INVITABLE_ZONE_ROLE_OPTIONS } from "$lib/role-options";

  type Chapter = { id: string; name: string; referenceCode: string };
  type Invitation = {
    id: string;
    email: string;
    roleCode: string;
    chapterId: string | null;
    expiresAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
  };

  let chapters = $state<Chapter[]>([]);
  let invitations = $state<Invitation[]>([]);
  let email = $state("");
  let roleCode = $state<string>("zone_admin");
  let chapterId = $state<string>("");
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  const isChapterRole = $derived(roleCode.startsWith("chapter_"));

  async function refresh() {
    const [c, i] = await Promise.all([
      api.get<{ items: Chapter[] }>("/api/tenant/chapters"),
      api.get<{ items: Invitation[] }>("/api/tenant/invitations"),
    ]);
    chapters = c.items;
    invitations = i.items;
  }
  $effect(() => {
    refresh().catch((e) => (errorMsg = e instanceof ApiError ? e.message : "Could not load."));
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    errorMsg = null;
    submitting = true;
    try {
      await api.post("/api/tenant/invitations", {
        email,
        roleCode,
        chapterId: isChapterRole ? chapterId : undefined,
      });
      email = "";
      await refresh();
    } catch (err) {
      errorMsg = err instanceof ApiError ? err.message : "Could not send invitation.";
    } finally {
      submitting = false;
    }
  }

  async function revoke(id: string) {
    try {
      await api.post(`/api/tenant/invitations/${id}/revoke`, {});
      await refresh();
    } catch (err) {
      errorMsg = err instanceof ApiError ? err.message : "Could not revoke.";
    }
  }
</script>

<div class="max-w-2xl mx-auto px-6 py-16">
  <p class="text-xs font-medium text-slate-500 uppercase tracking-wide">Step 2 of 2</p>
  <h1 class="mt-2 text-2xl font-semibold tracking-tight">Invite your team</h1>
  <p class="mt-2 text-sm text-slate-600">
    Add zone-wide users or chapter-scoped users. StewardLedger does not generate passwords:
    each invited user opens their invitation link, creates their own password, and then signs in
    with that email and password.
  </p>

  <form class="mt-6 grid grid-cols-12 gap-3" onsubmit={submit}>
    <input
      type="email"
      required
      bind:value={email}
      placeholder="teammate@example.com"
      class="col-span-12 sm:col-span-5 rounded-lg border border-slate-300 px-3 py-2 text-sm"
    />
    <select
      bind:value={roleCode}
      class="col-span-7 sm:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
    >
      <optgroup label="Zone-wide">
        {#each INVITABLE_ZONE_ROLE_OPTIONS as r}
          <option value={r.value}>{r.label}</option>
        {/each}
      </optgroup>
      <optgroup label="Chapter">
        {#each INVITABLE_CHAPTER_ROLE_OPTIONS as r}
          <option value={r.value}>{r.label}</option>
        {/each}
      </optgroup>
    </select>
    {#if isChapterRole}
      <select
        required
        bind:value={chapterId}
        class="col-span-5 sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="" disabled>Chapter…</option>
        {#each chapters as c}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    {/if}
    <button
      type="submit"
      disabled={submitting}
      class="col-span-12 sm:col-span-2 inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
    >
      {submitting ? "Sending…" : "Invite"}
    </button>
  </form>

  {#if errorMsg}
    <p class="mt-3 text-sm text-red-600">{errorMsg}</p>
  {/if}

  <div class="mt-5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
    <p class="font-medium text-slate-900">How login access is created</p>
    <p class="mt-1">
      Zone users are invited with a zone-wide role. Church users are invited with a chapter role
      and a selected chapter. In local development, the invitation URL is printed in the API logs
      when email sending is not configured.
    </p>
  </div>

  <h2 class="mt-10 text-sm font-semibold text-slate-700 uppercase tracking-wide">Pending invitations</h2>
  {#if invitations.length === 0}
    <p class="mt-3 text-sm text-slate-500">No invitations yet.</p>
  {:else}
    <ul class="mt-3 divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
      {#each invitations as inv}
        <li class="flex items-center justify-between px-4 py-3">
          <div>
            <p class="text-sm font-medium text-slate-800">{inv.email}</p>
            <p class="text-xs text-slate-500">
              {inv.roleCode}
              {#if inv.acceptedAt}
                &middot; accepted
              {:else if inv.revokedAt}
                &middot; revoked
              {:else}
                &middot; expires {new Date(inv.expiresAt).toLocaleDateString()}
              {/if}
            </p>
          </div>
          {#if !inv.acceptedAt && !inv.revokedAt}
            <button
              type="button"
              class="text-xs text-red-600 underline"
              onclick={() => revoke(inv.id)}
            >
              revoke
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <div class="mt-10 flex justify-end">
    <a href="/" class="text-sm text-slate-700 underline">Done for now</a>
  </div>
</div>
