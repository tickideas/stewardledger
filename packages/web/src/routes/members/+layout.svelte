<script lang="ts">
  import { page } from "$app/state";
  let { children } = $props();

  const path = $derived(page.url.pathname);
  function isActive(prefix: string) {
    return path === prefix || path.startsWith(prefix + "/");
  }
</script>

<div class="mx-auto max-w-7xl px-8">
  <nav class="flex gap-8 border-b border-[var(--rule)] py-5">
    <a href="/members/chapters" class="sl-nav-link" aria-current={isActive("/members/chapters") ? "page" : undefined}>Chapters</a>
    <a href="/members/people" class="sl-nav-link" aria-current={isActive("/members/people") ? "page" : undefined}>Members</a>
    <a href="/members/lookups" class="sl-nav-link" aria-current={isActive("/members/lookups") ? "page" : undefined}>Lookups</a>
    <a href="/members/merge" class="sl-nav-link" aria-current={isActive("/members/merge") ? "page" : undefined}>Merge proposals</a>
  </nav>
  {@render children?.()}
</div>
