<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // Bare `/zone` lands on the zone dashboard — the zonal admin's
  // glance view across the whole tenant. Drilldown links from there
  // take them into the editorial surfaces.
  $effect(() => {
    const zone = page.url.searchParams.get("zone");
    const target = zone
      ? `/zone/dashboard?zone=${encodeURIComponent(zone)}`
      : "/zone/dashboard";
    goto(target, { replaceState: true });
  });
</script>

<div class="py-8">
  <p class="text-[13px] text-[var(--ink-mute)]">Opening zone…</p>
</div>
