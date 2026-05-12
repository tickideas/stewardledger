<script lang="ts">
  import { goto } from "$app/navigation";
  $effect(() => {
    goto("/church/overview", { replaceState: true });
  });
</script>

<div class="py-8">
  <p class="text-[13px] text-[var(--ink-mute)]">Opening chapter…</p>
</div>
