<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  $effect(() => {
    const zone = page.url.searchParams.get("zone");
    const target = zone
      ? `/members/chapters?zone=${encodeURIComponent(zone)}`
      : "/members/chapters";
    goto(target, { replaceState: true });
  });
</script>

<div class="py-8">
  <p class="text-sm text-slate-500">Opening zone chapters…</p>
</div>
