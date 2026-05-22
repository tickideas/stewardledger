<!--
  packages/web/src/routes/group/+page.svelte
  Root /group redirect to /group/dashboard. SSR layout already gated access.
  Exists so /group/ is a navigable entry point even if the user types it directly.
  RELEVANT FILES: ./+layout.server.ts, ./+layout.svelte, ./dashboard/+page.svelte
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  onMount(() => goto("/group/dashboard", { replaceState: true }));
</script>
