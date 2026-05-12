<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { isSuperAdmin, isSuperAdminOnlyPath, session } from "$lib/session.svelte";

  let { children } = $props();

  $effect(() => {
    const s = session.current;
    if (
      s.status === "authenticated" &&
      !s.isSuperAdmin &&
      isSuperAdminOnlyPath(page.url.pathname)
    ) {
      goto("/members", { replaceState: true });
    }
  });

  const allow = $derived.by(() => {
    const s = session.current;
    if (s.status === "loading") return true;
    if (isSuperAdmin(s)) return true;
    if (s.status === "authenticated") return !isSuperAdminOnlyPath(page.url.pathname);
    return false;
  });

  const path = $derived(page.url.pathname);
  function isActive(prefix: string) {
    return path === prefix || path.startsWith(prefix + "/");
  }
</script>

{#if allow}
  <!-- Admin banner: thin brass stripe — restrained but unmistakable -->
  <div
    class="border-b border-[var(--rule)]"
    style="background: linear-gradient(180deg, var(--brass-soft) 0%, var(--paper) 100%)"
  >
    <div class="mx-auto flex max-w-7xl items-center gap-3 px-8 py-2.5">
      <span
        class="inline-block h-1.5 w-1.5 rounded-full"
        style="background:var(--brass);box-shadow:0 0 0 3px rgba(168,116,50,0.18)"
      ></span>
      <span class="sl-eyebrow" style="color:var(--brass-deep)">Platform Admin</span>
      <span class="text-[12px] text-[var(--ink-mute)]">
        Cross-zone access · every action is audited
      </span>
    </div>
  </div>

  <div class="mx-auto max-w-7xl px-8">
    <nav class="flex gap-8 border-b border-[var(--rule)] py-5">
      {#if isSuperAdmin(session.current)}
        <a href="/admin/zones" class="sl-nav-link" aria-current={isActive("/admin/zones") ? "page" : undefined}>
          Zones
        </a>
      {/if}
      <a href="/admin/regions" class="sl-nav-link" aria-current={path === "/admin/regions" ? "page" : undefined}>
        Regions
      </a>
      <a href="/admin/regions/inbox" class="sl-nav-link" aria-current={isActive("/admin/regions/inbox") ? "page" : undefined}>
        Inbox
      </a>
    </nav>
    {@render children?.()}
  </div>
{/if}
