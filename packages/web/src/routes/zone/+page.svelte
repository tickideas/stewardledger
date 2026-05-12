<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // Bare `/zone` has no useful surface of its own; the zonal admin's first
  // editorial chapter is the chapter register, so we land there.
  $effect(() => {
    const zone = page.url.searchParams.get("zone");
    const target = zone
      ? `/zone/chapters?zone=${encodeURIComponent(zone)}`
      : "/zone/chapters";
    goto(target, { replaceState: true });
  });
</script>

<div class="py-8">
  <p class="text-[13px] text-[var(--ink-mute)]">Opening zone…</p>
</div>
