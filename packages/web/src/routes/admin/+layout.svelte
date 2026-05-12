<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { isSuperAdmin, isSuperAdminOnlyPath, session } from "$lib/session.svelte";

  let { children } = $props();

  // Gate super-admin-only admin pages BEFORE rendering. Other admin routes
  // (e.g. /admin/regions, /admin/regions/inbox) are available to
  // REGION_CURATOR platform-role holders too — see `requirePlatformRole`
  // on the API side. The session payload doesn't yet surface platform
  // roles, so the remaining admin routes rely on the API's 403.
  // Lives here (not in
  // the root layout) so admin pages never get a chance to mount and fire
  // their data fetches — which would flash a "Could not load …" error
  // before the redirect arrives.
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

  // What the child page may render: super-admin-only routes wait for the
  // gate; the rest render eagerly (the API enforces curator access).
  const allow = $derived.by(() => {
    const s = session.current;
    if (s.status === "loading") return true;
    if (isSuperAdmin(s)) return true;
    // Authenticated non-super-admin: hide super-admin-only routes; allow
    // the rest (regions, inbox) so curators aren't blocked.
    if (s.status === "authenticated") return !isSuperAdminOnlyPath(page.url.pathname);
    return false;
  });
</script>

{#if allow}
  <div class="border-b bg-amber-50">
    <div class="max-w-6xl mx-auto px-6 py-2 text-xs text-amber-800">
      Platform admin &mdash; cross-zone access. Every action is audited.
    </div>
  </div>
  <div class="max-w-6xl mx-auto px-6">
    <nav class="text-sm text-slate-600 flex gap-6 py-4 border-b">
      {#if isSuperAdmin(session.current)}
        <a href="/admin/zones" class="hover:text-slate-900">Zones</a>
      {/if}
      <a href="/admin/regions" class="hover:text-slate-900">Regions</a>
      <a href="/admin/regions/inbox" class="hover:text-slate-900">Inbox</a>
    </nav>
    {@render children?.()}
  </div>
{:else}
  <!-- Either anonymous/no_zone/error (root layout handles those redirects)
       or authenticated-but-not-super-admin on a super-admin-only path
       (we're about to redirect). Render nothing instead of flashing the
       admin chrome. -->
{/if}
