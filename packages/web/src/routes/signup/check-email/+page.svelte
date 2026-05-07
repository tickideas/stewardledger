<script lang="ts">
  import { page } from "$app/state";
  const email = $derived(page.url.searchParams.get("email") ?? "");
</script>

<div class="max-w-md mx-auto px-6 py-24 text-center">
  <h1 class="text-3xl font-semibold tracking-tight">Check your email</h1>
  <p class="mt-3 text-sm text-slate-600">
    We've sent an owner invitation to
    {#if email}<strong>{email}</strong>{:else}your inbox{/if}.
    Click the link in the email to choose a password and finish setting up your zone.
  </p>
  <p class="mt-6 text-xs text-slate-400">
    The invitation link expires in 7 days. Didn't get it? Check spam, or
    <a href="/signup" class="underline">try again</a>.
  </p>
</div>
