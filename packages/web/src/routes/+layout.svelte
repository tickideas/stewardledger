<script lang="ts">
  import "../app.css";
  let { children } = $props();
</script>

<div class="min-h-screen flex flex-col">
  <header class="border-b bg-white">
    <div class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
      <a href="/" class="text-xl font-semibold tracking-tight">StewardLedger</a>
      <nav class="text-sm text-slate-600 flex gap-4">
        <a href="/login" class="hover:text-slate-900">Sign in</a>
      </nav>
    </div>
  </header>

  <main class="flex-1">
    {@render children?.()}
  </main>

  <footer class="border-t bg-white">
    <div class="max-w-6xl mx-auto px-6 py-6 text-xs text-slate-500 text-center">
      Powered by StewardLedger &middot; stewardledger.church
    </div>
  </footer>
</div>
