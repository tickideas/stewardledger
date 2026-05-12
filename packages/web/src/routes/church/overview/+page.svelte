<script lang="ts">
  // Chapter overview. Real (if compact) dashboard: count of members,
  // pending batches, posted totals for the chapter. No new API needed —
  // we issue three parallel reads against the existing tenant endpoints
  // and aggregate client-side. As the API grows a dedicated summary
  // endpoint, this turns into one fetch.

  import { useActiveChapter } from "$lib/active-chapter.svelte";
  import { api, ApiError, isAbortError } from "$lib/api";
  import { session } from "$lib/session.svelte";
  import { formatMoney, money, sumByCurrency } from "@stewardledger/shared";

  type Member = { id: string; isActive: boolean };
  type Batch = {
    id: string;
    cashTotal: string | null;
    chequeTotal: string | null;
    currencyCode: string;
    status: "draft" | "submitted" | "approved" | "posted" | "voided";
    createdAt: string;
  };
  type Contribution = {
    id: string;
    totalAmount: string;
    currencyCode: string;
    status: "draft" | "posted" | "voided" | "reversed";
    contributionDate: string;
  };

  const chapter = useActiveChapter();

  let members = $state<Member[]>([]);
  let batches = $state<Batch[]>([]);
  let contributions = $state<Contribution[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let refreshToken = 0;

  async function refresh(signal: AbortSignal) {
    const here = chapter();
    if (!here) {
      members = [];
      batches = [];
      contributions = [];
      return;
    }
    const my = ++refreshToken;
    loading = true;
    loadError = null;
    try {
      const qs = `chapterId=${encodeURIComponent(here.id)}`;
      const [m, b, c] = await Promise.all([
        api.get<{ items: Member[] }>(`/api/tenant/members?${qs}`, signal),
        api.get<{ items: Batch[] }>(`/api/tenant/contribution-batches?${qs}`, signal),
        api.get<{ items: Contribution[] }>(`/api/tenant/contributions?${qs}`, signal),
      ]);
      if (my !== refreshToken) return;
      members = m.items;
      batches = b.items;
      contributions = c.items;
    } catch (err) {
      if (isAbortError(err)) return;
      if (my !== refreshToken) return;
      loadError = err instanceof ApiError ? err.message : "Could not load overview.";
    } finally {
      if (my === refreshToken) loading = false;
    }
  }

  $effect(() => {
    void chapter()?.id;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  });

  // ─── Derived stats ──────────────────────────────────────────────────────
  const activeMembers = $derived(members.filter((m) => m.isActive).length);
  const pendingBatches = $derived(
    batches.filter((b) => b.status === "draft" || b.status === "submitted" || b.status === "approved").length,
  );
  const postedThisMonth = $derived.by(() => {
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    return sumByCurrency(
      contributions
        .filter((c) => c.status === "posted" && c.contributionDate >= cutoff)
        .map((c) => money(c.totalAmount, c.currencyCode)),
    );
  });
  const cashOnHand = $derived(
    sumByCurrency(
      batches
        .filter((b) => b.status !== "posted" && b.status !== "voided" && b.cashTotal !== null)
        .map((b) => money(b.cashTotal ?? "0", b.currencyCode)),
    ),
  );

  // User's roles within this chapter — context for "why am I seeing this?"
  const chapterRoleCodes = $derived.by<string[]>(() => {
    const here = chapter();
    if (!here) return [];
    const s = session.current;
    if (s.status !== "authenticated") return [];
    const zone = s.zones.find((z) => z.slug === s.activeZoneSlug);
    if (!zone) return [];
    return [
      ...new Set(
        zone.chapterRoles.filter((r) => r.chapterId === here.id).map((r) => r.roleCode),
      ),
    ];
  });
</script>

<svelte:head><title>{chapter()?.name ?? "Chapter"} overview · StewardLedger</title></svelte:head>

<div>
  <div class="sl-reveal sl-reveal-1">
    <p class="sl-eyebrow" style="font-size:10.5px">§ Chapter I · Overview</p>
    <h1 class="sl-display mt-2 text-[44px] leading-[1.05] tracking-tight text-[var(--ink)]">
      {#if chapter()}
        {chapter()!.name}
        <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">overview</span>
      {:else}
        Chapter <span class="sl-serif-italic font-normal text-[var(--brass-deep)]">overview</span>
      {/if}
    </h1>
    <p class="mt-3 max-w-2xl text-[14px] leading-relaxed text-[var(--ink-mute)]">
      Your chapter at a glance — members, open batches, and what's posted
      this month. Drill into Contributions or Imports from the sidebar for
      the row-by-row view.
    </p>
    {#if chapterRoleCodes.length > 0}
      <div class="mt-5 flex flex-wrap items-center gap-2">
        <span class="sl-eyebrow" style="font-size:10px">Your roles</span>
        {#each chapterRoleCodes as code (code)}
          <span class="sl-badge sl-badge-accent">{code.replace(/^chapter_/, "").replace(/_/g, " ")}</span>
        {/each}
      </div>
    {/if}
  </div>

  {#if loadError}
    <p class="mt-6 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{loadError}</p>
  {/if}

  <div class="sl-reveal sl-reveal-2 mt-10 grid grid-cols-2 gap-0 border-y border-[var(--rule)] bg-[var(--card)] md:grid-cols-4">
    <div class="px-6 py-7 border-r border-[var(--rule)]">
      <span class="sl-eyebrow">Active members</span>
      <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
        {#if loading && members.length === 0}
          <span class="text-[var(--ink-faint)]">—</span>
        {:else}
          {activeMembers}
        {/if}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">{members.length} total · {members.length - activeMembers} inactive</p>
    </div>
    <div class="px-6 py-7 md:border-r md:border-[var(--rule)]">
      <span class="sl-eyebrow">Pending batches</span>
      <div class="mt-3 sl-display sl-num text-[44px] leading-none text-[var(--ink)]">
        {#if loading && batches.length === 0}
          <span class="text-[var(--ink-faint)]">—</span>
        {:else}
          {pendingBatches}
        {/if}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">draft · submitted · approved</p>
    </div>
    <div class="border-t border-[var(--rule)] px-6 py-7 md:border-r md:border-t-0 md:border-[var(--rule)]">
      <span class="sl-eyebrow">Cash on hand</span>
      <div class="mt-3 sl-display sl-num text-[28px] leading-tight text-[var(--ink)]">
        {#if cashOnHand.length === 0}
          <span class="text-[var(--ink-faint)]">—</span>
        {:else}
          {#each cashOnHand as total, i (i)}
            <span class:block={i > 0}>{formatMoney(total)}</span>
          {/each}
        {/if}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">unposted physical cash</p>
    </div>
    <div class="border-t border-[var(--rule)] px-6 py-7 md:border-t-0">
      <span class="sl-eyebrow">Posted · this month</span>
      <div class="mt-3 sl-display sl-num text-[28px] leading-tight text-[var(--brass-deep)]">
        {#if postedThisMonth.length === 0}
          <span class="text-[var(--ink-faint)]">—</span>
        {:else}
          {#each postedThisMonth as total, i (i)}
            <span class:block={i > 0}>{formatMoney(total)}</span>
          {/each}
        {/if}
      </div>
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]">since the 1st</p>
    </div>
  </div>

  <!-- Quick links into the rest of the chapter surface. -->
  <div class="sl-reveal sl-reveal-3 mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
    <a href="/church/members" class="sl-card group block p-5 transition-colors hover:bg-[var(--paper-soft)]">
      <span class="sl-eyebrow">People</span>
      <h2 class="mt-2 sl-display text-[18px] text-[var(--ink)] group-hover:text-[var(--brass-deep)]">Members directory</h2>
      <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">Add and edit the people of {chapter()?.name ?? "your chapter"}.</p>
    </a>
    <a href="/church/contributions" class="sl-card group block p-5 transition-colors hover:bg-[var(--paper-soft)]">
      <span class="sl-eyebrow">Giving</span>
      <h2 class="mt-2 sl-display text-[18px] text-[var(--ink)] group-hover:text-[var(--brass-deep)]">Contributions journal</h2>
      <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">Sunday batches, online gifts, reconciliations.</p>
    </a>
    <a href="/church/reports" class="sl-card group block p-5 transition-colors hover:bg-[var(--paper-soft)]">
      <span class="sl-eyebrow">Output</span>
      <h2 class="mt-2 sl-display text-[18px] text-[var(--ink)] group-hover:text-[var(--brass-deep)]">Reports</h2>
      <p class="mt-2 text-[12.5px] text-[var(--ink-mute)]">Statements, member lists, and ledger exports.</p>
    </a>
  </div>
</div>
