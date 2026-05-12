<script lang="ts">
  let { children } = $props();
</script>

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
