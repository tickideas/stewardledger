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

<svelte:head><title>Onboarding · StewardLedger</title></svelte:head>

<div class="mx-auto max-w-2xl px-6 py-16">
  <span class="sl-eyebrow">Step 2 of 2</span>
  <h1 class="mt-3 sl-display text-[36px] leading-[1] text-[var(--ink)]">
    Invite your <span class="sl-serif-italic font-light text-[var(--brass-deep)]">team</span>
  </h1>
  <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
    Add zone-wide users or chapter-scoped users. StewardLedger does not generate passwords:
    each invited user opens their invitation link, creates their own password, and then signs in
    with that email and password.
  </p>

  <form class="sl-card-warm mt-8 grid grid-cols-12 gap-3 p-6" onsubmit={submit}>
    <input type="email" required bind:value={email} placeholder="teammate@example.com" class="sl-input col-span-12 sm:col-span-5" />
    <select bind:value={roleCode} class="sl-select col-span-7 sm:col-span-3">
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
      <select required bind:value={chapterId} class="sl-select col-span-5 sm:col-span-2">
        <option value="" disabled>Chapter…</option>
        {#each chapters as c}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    {/if}
    <button type="submit" disabled={submitting} class="sl-btn sl-btn-primary col-span-12 justify-center sm:col-span-2">
      {submitting ? "Sending…" : "Invite"}
    </button>
  </form>

  {#if errorMsg}
    <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{errorMsg}</p>
  {/if}

  <div class="sl-card mt-6 p-5">
    <span class="sl-eyebrow">How login access is created</span>
    <p class="mt-2 text-[13px] text-[var(--ink-mute)]">
      Zone users are invited with a zone-wide role. Church users are invited with a chapter role
      and a selected chapter. In local development, the invitation URL is printed in the API logs
      when email sending is not configured.
    </p>
  </div>

  <div class="mt-10">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Pending invitations</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {invitations.length} {invitations.length === 1 ? "row" : "rows"}
      </span>
    </div>
    {#if invitations.length === 0}
      <div class="sl-card p-10 text-center text-[13px] text-[var(--ink-mute)]">No invitations yet.</div>
    {:else}
      <ul class="sl-card divide-y divide-[var(--rule)] overflow-hidden">
        {#each invitations as inv}
          <li class="flex items-center justify-between gap-4 px-5 py-4">
            <div class="min-w-0">
              <p class="text-[14px] text-[var(--ink)]">{inv.email}</p>
              <p class="mt-0.5 text-[11.5px] text-[var(--ink-mute)]">
                <span class="sl-mono">{inv.roleCode}</span>
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
              <button type="button" class="sl-btn sl-btn-ghost" style="color:var(--bad)" onclick={() => revoke(inv.id)}>
                Revoke
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="mt-10 flex justify-end">
    <a href="/" class="sl-link text-[13px]">Done for now</a>
  </div>
</div>
