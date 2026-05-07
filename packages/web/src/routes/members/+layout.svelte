<script lang="ts">
  let { children } = $props();
</script>

<div class="max-w-6xl mx-auto px-6">
  <nav class="text-sm text-slate-600 flex gap-6 py-4 border-b">
    <a href="/members" class="hover:text-slate-900 font-medium">Members</a>
    <a href="/members/lookups" class="hover:text-slate-900">Lookups</a>
    <a href="/members/merge" class="hover:text-slate-900">Merge proposals</a>
  </nav>
  {@render children?.()}
</div>
