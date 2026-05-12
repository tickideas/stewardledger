<script lang="ts">
  let { children } = $props();
</script>

<div class="max-w-6xl mx-auto px-6">
  <nav class="text-sm text-slate-600 flex gap-6 py-4 border-b">
    <a href="/members/chapters" class="hover:text-slate-900 font-medium">Chapters</a>
    <a href="/members/people" class="hover:text-slate-900">Members</a>
    <a href="/members/lookups" class="hover:text-slate-900">Lookups</a>
    <a href="/members/merge" class="hover:text-slate-900">Merge proposals</a>
  </nav>
  {@render children?.()}
</div>
