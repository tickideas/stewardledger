<!--
  packages/web/src/routes/+page.svelte
  Public landing page for StewardLedger.
  Kept intentionally minimal: a centred headline, a short subhead, a single
  sign-in CTA, and a quiet contact note. Footer is rendered by the layout.
  RELEVANT FILES:
    - packages/web/src/routes/+layout.svelte
    - packages/web/src/app.css
    - packages/web/src/lib/session.svelte.ts
    - packages/web/src/routes/login/+page.svelte
-->
<section class="mx-auto max-w-3xl px-6 pt-24 pb-32 text-center sm:pt-40">
  <h1 class="mx-auto max-w-2xl text-[clamp(36px,6vw,64px)] font-medium leading-[1.05] tracking-tight text-[var(--ink)]">
    The church finance ledger,
    <span class="text-[var(--ink-mute)]">recorded once, traceable forever.</span>
  </h1>

  <p class="mx-auto mt-8 max-w-xl text-[17px] leading-relaxed text-[var(--ink-soft)]">
    From a single member's giving to a zone's annual partnership — one ledger,
    audited end-to-end, reportable in seconds.
  </p>

  <div class="mt-10 flex justify-center">
    <a href="/login" class="sl-btn sl-btn-primary">Sign in</a>
  </div>

  <p class="mt-16 text-[13px] text-[var(--ink-mute)]">
    StewardLedger is invitation-only. To onboard a zone, write to
    <a href="mailto:hello@stewardledger.church" class="sl-link">hello@stewardledger.church</a>.
  </p>
</section>
