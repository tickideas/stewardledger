<script lang="ts">
  import { goto } from "$app/navigation";
  import { isSuperAdmin, session } from "$lib/session.svelte";

  let { children } = $props();

  // Gate /admin/* on super-admin BEFORE rendering any child page. Lives here
  // (not in the root layout) so admin pages never get a chance to mount and
  // fire their data fetches — which would flash a "Could not load …" error
  // to non-super-admins before the redirect arrives.
  $effect(() => {
    const s = session.current;
    if (s.status === "authenticated" && !s.isSuperAdmin) {
      goto("/members", { replaceState: true });
    }
  });

  const allow = $derived(
    session.current.status === "loading" || isSuperAdmin(session.current),
  );
</script>

{#if allow}
  <div class="border-b bg-amber-50">
    <div class="max-w-6xl mx-auto px-6 py-2 text-xs text-amber-800">
      Platform admin &mdash; cross-zone access. Every action is audited.
    </div>
  </div>
  <div class="max-w-6xl mx-auto px-6">
    <nav class="text-sm text-slate-600 flex gap-6 py-4 border-b">
      <a href="/admin/zones" class="hover:text-slate-900">Zones</a>
      <a href="/admin/regions" class="hover:text-slate-900">Regions</a>
      <a href="/admin/regions/inbox" class="hover:text-slate-900">Inbox</a>
    </nav>
    {@render children?.()}
  </div>
{:else}
  <!-- Either anonymous/no_zone/error (root layout handles those redirects)
       or authenticated-but-not-super-admin (we're about to redirect). Render
       nothing instead of flashing the admin chrome. -->
{/if}
